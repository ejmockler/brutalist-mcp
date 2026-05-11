/**
 * Action entrypoint.
 *
 * Pipeline:
 *   1. Read + validate inputs.
 *   2. Resolve PR context (owner, repo, number, head/base SHAs, diff lines).
 *   3. Invoke @brutalist/orchestrator with focus=diff and the OAuth token.
 *   4. Resolve every Finding's verbatimQuote against the file at head SHA.
 *   5. Group inline-eligible findings by (path, line, side); bucket the rest.
 *   6. POST one Reviews API call (event: COMMENT) carrying the synthesis
 *      summary and the inline comments.
 */

import * as path from 'node:path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { run as runOrchestrator } from '@brutalist/orchestrator';
import { readInputs } from './inputs.js';
import { fetchPullRequestContext, getPullRequestRef } from './diff.js';
import { resolveFindings } from './resolver.js';
import { groupInlineFindingsWithSubThreshold, applyReviewsApiLimits } from './grouper.js';
import { submitReview } from './reviews-api.js';
import { runPreflight, assertPreflight } from './preflight.js';
import { truncateDiff } from './truncate-diff.js';
import { provisionCredentials, detectRefreshRotation } from './oauth-provisioning.js';

async function main(): Promise<void> {
  const inputs = readInputs();

  // Preflight: fail fast with an actionable error if `brutalist-mcp` or
  // `claude` aren't on PATH (these are hard requirements). Warn — but
  // don't block — when only one critic is installed.
  core.info('Running preflight checks...');
  const preflight = await runPreflight();
  assertPreflight(preflight);

  // Provision OAuth credential files for Codex + Gemini. The CLIs read
  // their OAuth state from disk (~/.codex/auth.json /
  // ~/.gemini/oauth_creds.json + google_accounts.json), so we write the
  // GitHub secrets back to those paths before invoking the orchestrator.
  // Files are mode 0600.
  const provisioned = await provisionCredentials({
    codexAuth: inputs.codexAuth,
    geminiOauthCreds: inputs.geminiOauthCreds,
    geminiGoogleAccounts: inputs.geminiGoogleAccounts,
  });

  // Forward provider keys into process.env ONLY when OAuth wasn't
  // provisioned for that provider. The CLIs prefer env-based API keys
  // over file-based OAuth, so setting both would override the OAuth
  // path we just wrote to disk.
  if (!provisioned.codexOauth && inputs.openaiApiKey) {
    process.env.OPENAI_API_KEY = inputs.openaiApiKey;
  }
  if (!provisioned.geminiOauth && inputs.googleApiKey) {
    process.env.GEMINI_API_KEY = inputs.googleApiKey;
  }
  if (provisioned.codexOauth) core.info('Codex critic will authenticate via OAuth.');
  if (provisioned.geminiOauth) core.info('Gemini critic will authenticate via OAuth.');

  const pull = getPullRequestRef();
  if (!pull) {
    throw new Error(
      'This action runs on pull_request events only. github.context.payload.pull_request was missing.',
    );
  }

  const octokit = github.getOctokit(inputs.githubToken);
  core.info(
    `Brutalist review on ${pull.owner}/${pull.repo}#${pull.number} (head ${pull.headSha.substring(0, 7)})`,
  );

  const context = await fetchPullRequestContext(octokit, pull);
  core.info(`Diff covers ${context.diffLines.size / 2} commentable line-positions.`);

  // The diff itself is the focus. Trim to keep prompts manageable; if a
  // diff is genuinely huge, callers can raise max-diff-chars or partition
  // before invoking us. Truncation is surfaced as a warning so silent
  // partial-context analysis doesn't masquerade as a complete review.
  const truncated = truncateDiff(context.diffText, inputs.maxDiffChars);
  if (truncated.didTruncate) {
    core.warning(
      `PR diff exceeded max-diff-chars (${inputs.maxDiffChars}) — truncated from ${truncated.originalChars} to ${truncated.keptChars} chars. Findings on omitted regions will be missed; raise max-diff-chars or split the PR.`,
    );
  }
  const focus = `Pull request #${pull.number} diff (commentable lines only):\n\n${truncated.text}`;

  // Resolve working-directory against process.cwd(). The runner sets
  // cwd to $GITHUB_WORKSPACE (the checked-out repo root); the input
  // narrows from there. Absolute inputs are honored verbatim; relative
  // inputs (the common case, `.` or `./packages/api`) are rooted at cwd.
  const repoPath = path.resolve(process.cwd(), inputs.workingDirectory);
  core.info(`Orchestrator repoPath resolved to ${repoPath}`);

  core.info('Invoking @brutalist/orchestrator...');
  const result = await runOrchestrator({
    repoPath,
    focus,
    contextHints: [
      `PR base SHA: ${pull.baseSha}`,
      `PR head SHA: ${pull.headSha}`,
      `Working directory: ${inputs.workingDirectory}`,
    ],
    oauthToken: inputs.anthropicOauthToken,
    // Pin the claude executable from the preflight result so the SDK
    // doesn't fall back to bundle-internal native package lookup,
    // which isn't available in the ncc-bundled action runtime.
    claudeCodeExecutablePath: preflight.claude.resolvedPath,
  });
  core.info(
    `Orchestrator returned ${result.findings.length} findings + ${result.outOfDiff.length} out-of-diff. perCli=${result.perCli.length}.`,
  );

  // Resolve every finding against the head SHA. Drops fabricated quotes.
  const allFindings = [...result.findings, ...result.outOfDiff];
  // Pass the working-directory offset so the resolver bridges
  // subtree-relative agent paths to repo-root-relative diff keys for
  // monorepo workflows.
  const subtreeOffset = inputs.workingDirectory && inputs.workingDirectory !== '.'
    ? inputs.workingDirectory
    : '';
  const resolution = await resolveFindings(allFindings, octokit, context, {
    workingDirectoryOffset: subtreeOffset,
  });
  core.info(
    `Resolved: ${resolution.inline.length} inline, ${resolution.outOfDiff.length} out-of-diff, ${resolution.dropped.length} dropped.`,
  );
  for (const drop of resolution.dropped) {
    core.warning(`Dropped finding: ${drop.reason}`);
  }

  const grouped = groupInlineFindingsWithSubThreshold(resolution.inline, inputs.minimumSeverity);
  core.info(
    `Grouped into ${grouped.groups.length} inline comments (severity ≥${inputs.minimumSeverity}); ${grouped.subThreshold.length} sub-threshold findings demoted to summary.`,
  );

  const limited = applyReviewsApiLimits(grouped.groups);
  if (limited.bodyTruncated) {
    core.warning('Some inline comment bodies exceeded the GitHub size cap and were truncated.');
  }
  if (limited.demoted.length > 0) {
    core.warning(
      `Inline comment cap exceeded — ${limited.demoted.length} finding(s) demoted to the review summary's out-of-diff section.`,
    );
  }

  // The review summary's out-of-diff section gets three classes of
  // finding, each tagged with its `provenance` so the reviewer can
  // tell them apart:
  //   - 'unanchored' — resolver couldn't anchor to a diff line
  //   - 'sub-threshold' — filtered by severity but still substantive
  //   - 'comment-cap-overflow' — bumped from inline by the per-review cap
  const summaryOutOfDiff = [
    ...resolution.outOfDiff, // already tagged 'unanchored' by resolver
    ...grouped.subThreshold.map(
      (f) => ({ ...f, provenance: 'sub-threshold' as const }),
    ),
    ...limited.demoted.map(
      (f) => ({ ...f, provenance: 'comment-cap-overflow' as const }),
    ),
  ];

  const submission = await submitReview(octokit, {
    pull,
    groups: limited.inline,
    outOfDiff: summaryOutOfDiff,
    dropped: resolution.dropped,
    result,
  });

  // Detect mid-run refresh-token rotation so operators learn empirically
  // whether their provider hard-rotates (in which case the stored secret
  // is now stale and the next run will fail auth).
  await detectRefreshRotation(provisioned.initialFingerprints);

  core.info(`Review submitted: ${submission.htmlUrl}`);
  if (submission.degradedToSummaryOnly) {
    core.warning(
      'Review submitted in degraded mode (summary only). Inline comments could not be posted; see the review body for details.',
    );
  }
  core.setOutput('review-id', submission.reviewId);
  core.setOutput('review-url', submission.htmlUrl);
  // Honest count: when the 422 fallback stripped comments, 0 inline
  // comments were actually posted regardless of how many we tried to
  // submit. Workflows wiring outputs into downstream gates need this.
  core.setOutput(
    'inline-comment-count',
    submission.degradedToSummaryOnly ? 0 : limited.inline.length,
  );
  core.setOutput('out-of-diff-count', summaryOutOfDiff.length);
  core.setOutput('dropped-count', resolution.dropped.length);
  core.setOutput('demoted-count', limited.demoted.length);
  core.setOutput('sub-threshold-count', grouped.subThreshold.length);
  core.setOutput('degraded-fallback', submission.degradedToSummaryOnly ? 'true' : 'false');
}

// truncateDiff was moved to ./truncate-diff.js so it can be unit-tested
// in isolation. Import is at the top of this file.

main().catch((err) => {
  const raw = err instanceof Error ? err.message : String(err);
  // Read inputs again for redaction. The earlier readInputs() call
  // happened inside main() and its scope is gone in the .catch handler;
  // re-reading is cheap and guarantees we redact what was actually
  // supplied even if main() threw before assigning to closure variables.
  let secrets: string[] = [];
  try {
    const i = readInputs();
    secrets = [i.anthropicOauthToken, i.openaiApiKey, i.googleApiKey].filter(
      (s): s is string => typeof s === 'string' && s.length >= 8,
    );
  } catch {
    // readInputs may itself throw (e.g. missing required input) — in
    // that case there's nothing input-side to redact; fall through to
    // the env-scan path below.
  }
  // Add any provider-key process.env values too — orchestrator forwards
  // them into spawn env, the SDK could echo them in errors.
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    const v = process.env[key];
    if (v && v.length >= 8) secrets.push(v);
  }
  core.setFailed(redactSecrets(raw, secrets));
});

/**
 * Strip any of the supplied secret values from a string before it
 * lands in the action log. The Claude Agent SDK occasionally echoes
 * config (and PR content) back in error messages — without redaction,
 * a flaky run could leak the OAuth token to a public action log.
 *
 * Takes an explicit list because the action's OAuth token is passed
 * as a function parameter rather than via process.env, so an
 * env-scanning redactor would miss it in production. The 8-character
 * floor protects against masking trivial substrings.
 */
export function redactSecrets(message: string, secrets: readonly string[]): string {
  let out = message;
  // Sort by length descending so longer secrets match first — without
  // this, a short secret that's a substring of a longer one would
  // partially redact the longer one and leave fragments visible.
  const sorted = [...secrets].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}
