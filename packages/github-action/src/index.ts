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
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { run as runOrchestrator } from '@brutalist/orchestrator';
import type { OrchestratorResult } from '@brutalist/orchestrator';
import { chunkDiff, mergeResults, runWithConcurrency } from './chunk-diff.js';
import { readInputs } from './inputs.js';
import { provisionCustomClaudeClient } from './custom-claude.js';
import { fetchPullRequestContext, getPullRequestRef } from './diff.js';
import { resolveFindings } from './resolver.js';
import { groupInlineFindingsWithSubThreshold, applyReviewsApiLimits } from './grouper.js';
import { submitReview } from './reviews-api.js';
import { runPreflight, assertPreflight } from './preflight.js';
import { truncateDiff } from './truncate-diff.js';
import { provisionCredentials, detectRefreshRotation, extractOauthSecrets } from './oauth-provisioning.js';

async function main(): Promise<void> {
  const inputs = readInputs();

  // Preflight: fail fast with an actionable error if `brutalist-mcp` or
  // `claude` aren't on PATH (these are hard requirements). Warn — but
  // don't block — when only one critic is installed.
  core.info('Running preflight checks...');
  const preflight = await runPreflight();
  assertPreflight(preflight);

  // Provision OAuth credential files for Codex and Agy. Both CLIs read
  // their OAuth state from disk (~/.codex/auth.json and
  // ~/.gemini/antigravity-cli/antigravity-oauth-token), so we write the
  // GitHub secrets to those paths before invoking the orchestrator.
  // Files are mode 0600.
  const provisioned = await provisionCredentials({
    codexAuth: inputs.codexAuth,
    agyOauthToken: inputs.agyOauthToken,
  });

  // Forward provider keys into process.env ONLY when OAuth wasn't
  // provisioned for that provider. The CLI prefers env-based API keys
  // over file-based OAuth, so setting both would override the OAuth
  // path we just wrote to disk. Agy has no env-var auth path (#78 still
  // open), so the file provisioning is the only viable CI auth.
  if (!provisioned.codexOauth && inputs.openaiApiKey) {
    process.env.OPENAI_API_KEY = inputs.openaiApiKey;
  }
  if (provisioned.codexOauth) core.info('Codex critic will authenticate via OAuth.');
  if (provisioned.agyOauth) core.info('Agy critic will authenticate via file-based OAuth.');

  const { knownClientIds } = await provisionCustomClaudeClient(inputs);

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
  // Best model by default: write ~/.claude/settings.json `model` so the
  // claude CRITIC (spawned by brutalist-mcp) runs on inputs.model. The brain
  // gets the model directly via runOrchestrator({ model }). Merges with any
  // existing settings so unrelated keys are preserved.
  await ensureClaudeSettingsModel(inputs.claudeCriticModel);

  // Resolve working-directory against process.cwd(). The runner sets
  // cwd to $GITHUB_WORKSPACE (the checked-out repo root); the input
  // narrows from there. Absolute inputs are honored verbatim; relative
  // inputs (the common case, `.` or `./packages/api`) are rooted at cwd.
  const repoPath = path.resolve(process.cwd(), inputs.workingDirectory);
  core.info(`Orchestrator repoPath resolved to ${repoPath}`);

  const contextHints = [
    `PR base SHA: ${pull.baseSha}`,
    `PR head SHA: ${pull.headSha}`,
    `Working directory: ${inputs.workingDirectory}`,
  ];

  // Context-window-aware chunking. A diff larger than the usable context
  // window can't be reviewed in one pass (the brain + every critic would hit
  // "Prompt is too long"), so split it to fit and review each chunk with an
  // independent orchestrator run, then merge into one review.
  const { chunks, truncatedHunks } = chunkDiff(truncated.text, inputs.maxChunkChars);
  if (truncatedHunks > 0) {
    core.warning(
      `${truncatedHunks} oversized hunk(s) were truncated to fit the per-chunk budget (${inputs.maxChunkChars} chars); findings on truncated regions may be missed.`,
    );
  }
  core.info(
    `Diff split into ${chunks.length} chunk(s) of ≤${inputs.maxChunkChars} chars ` +
      `(window ${inputs.contextWindowTokens} tok − ${inputs.contextHeadroomPct}% headroom). Brain model: ${inputs.model}.`,
  );

  const runChunk = (chunk: string, i: number): Promise<OrchestratorResult> =>
    runOrchestrator({
      repoPath,
      focus:
        `Pull request #${pull.number} diff ` +
        `(${chunks.length > 1 ? `chunk ${i + 1}/${chunks.length}, ` : ''}commentable lines only):\n\n${chunk}`,
      contextHints,
      oauthToken: inputs.anthropicOauthToken,
      // Pin the claude executable from the preflight result so the SDK
      // doesn't fall back to bundle-internal native package lookup,
      // which isn't available in the ncc-bundled action runtime.
      claudeCodeExecutablePath: preflight.claude.resolvedPath,
      model: inputs.model,
      knownClientIds,
    });

  let result: OrchestratorResult;
  if (chunks.length <= 1) {
    core.info('Invoking @brutalist/orchestrator...');
    result = await runChunk(chunks[0] ?? truncated.text, 0);
  } else {
    core.info(
      `Invoking @brutalist/orchestrator across ${chunks.length} chunks (concurrency ${inputs.chunkConcurrency})...`,
    );
    const settled = await runWithConcurrency(chunks, inputs.chunkConcurrency, runChunk);
    const ok: OrchestratorResult[] = [];
    let failedCount = 0;
    for (const r of settled) {
      if (r.ok) {
        ok.push(r.value);
      } else {
        failedCount++;
        const msg = r.error instanceof Error ? r.error.message : String(r.error);
        core.warning(`Chunk ${r.index + 1}/${chunks.length} review failed: ${msg}`);
      }
    }
    if (ok.length === 0) {
      // Every chunk failed — surface a hard failure rather than an empty review.
      const firstErr = settled.find((r) => !r.ok) as { error: unknown } | undefined;
      const e = firstErr?.error;
      throw e instanceof Error ? e : new Error(`All ${chunks.length} chunk reviews failed.`);
    }
    result = mergeResults(ok);
    core.info(`Merged ${ok.length}/${chunks.length} chunk reviews (${failedCount} failed).`);
  }
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
    secrets = [i.anthropicOauthToken, i.openaiApiKey].filter(
      (s): s is string => typeof s === 'string' && s.length >= 8,
    );
    // Every custom Claude-routed critic carries its own bearer token; register
    // them ALL for redaction (the singular custom-claude-auth-token is merged
    // into customClaudeClients by readInputs, so this covers it too).
    for (const c of i.customClaudeClients ?? []) {
      if (typeof c.authToken === 'string' && c.authToken.length >= 8) secrets.push(c.authToken);
    }
    // Extract individual token fields from each OAuth credential blob
    // so partial echoes (e.g. a CLI logging "Bearer <token>") get
    // masked even when the whole-blob match doesn't fire. Defense in
    // depth on top of the blob-level mask.
    secrets.push(...extractOauthSecrets(i.codexAuth));
    secrets.push(...extractOauthSecrets(i.agyOauthToken));
    // Also register the whole blob — covers full-payload echoes that
    // the field-level extractor wouldn't reach (e.g. an error dump that
    // serialized the input dict).
    if (i.codexAuth && i.codexAuth.length >= 16) secrets.push(i.codexAuth);
    if (i.agyOauthToken && i.agyOauthToken.length >= 16) secrets.push(i.agyOauthToken);
  } catch {
    // readInputs may itself throw (e.g. missing required input) — in
    // that case there's nothing input-side to redact; fall through to
    // the env-scan path below.
  }
  // Add any provider-key process.env values too — orchestrator forwards
  // them into spawn env, the SDK could echo them in errors.
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    const v = process.env[key];
    if (v && v.length >= 8) secrets.push(v);
  }
  const redacted = redactSecrets(raw, secrets);
  // Classify auth failures so the SDK's opaque "401 Invalid authentication
  // credentials" (which surfaces on the orchestrator's first turn, before any
  // critic runs) becomes an actionable instruction instead of a dead end.
  // OAuth tokens from `claude setup-token` are long-lived but can be revoked
  // or rotated — generating a fresh token elsewhere can invalidate an older
  // one still sitting in a repo secret, which is exactly this 401.
  const looksLikeAuthFailure =
    /\b401\b|invalid authentication|authentication_error|failed to authenticate/i.test(raw);
  const message = looksLikeAuthFailure
    ? `${redacted}\n\n` +
      'This is an authentication failure, not a code error. The ANTHROPIC_OAUTH_TOKEN ' +
      'secret is most likely expired, revoked, or rotated. Regenerate it and update the secret:\n' +
      '    claude setup-token\n' +
      '    gh secret set ANTHROPIC_OAUTH_TOKEN --repo <owner>/<repo>\n' +
      'Capture it without a trailing newline (the action trims it defensively, but the secret should be clean).'
    : redacted;
  core.setFailed(message);
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

/**
 * Write `model` into ~/.claude/settings.json so the claude CRITIC (spawned
 * by brutalist-mcp via the claude CLI) defaults to it — the CLI and
 * brutalist's ModelResolver both read this file, and createSecureEnvironment
 * would strip an env-var approach. Merges with any existing settings.
 * Best-effort: a write failure degrades to the CLI's own default model, not
 * a hard error.
 */
async function ensureClaudeSettingsModel(model: string): Promise<void> {
  try {
    const dir = path.join(os.homedir(), '.claude');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8'));
      if (parsed && typeof parsed === 'object') settings = parsed as Record<string, unknown>;
    } catch {
      /* no existing settings / unparseable — start fresh */
    }
    settings.model = model;
    await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
    core.info(`Claude critic model set via ~/.claude/settings.json: ${model}`);
  } catch (e) {
    core.warning(
      `Could not write ~/.claude/settings.json model (${e instanceof Error ? e.message : String(e)}); claude critic will use its default model.`,
    );
  }
}
