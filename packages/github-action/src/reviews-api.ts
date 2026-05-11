/**
 * GitHub Reviews API submission.
 *
 * Sends one review (event: COMMENT) per orchestrator run, carrying:
 *   - body: cross-CLI synthesis + per-CLI breakdowns + out-of-diff findings
 *   - comments[]: grouped inline comments, one per (path, line, side)
 *
 * Reviews API rejects (HTTP 422) inline comments on lines that aren't
 * in the diff — that's why the resolver and grouper carefully bucket
 * findings before this point. We surface 422 errors with diagnostic
 * context so contract drift is debuggable.
 */

import type { OrchestratorResult } from '@brutalist/orchestrator';
import type { Octokit } from './octokit-types.js';
import type { PullRequestRef } from './diff.js';
import type { GroupedComment } from './grouper.js';
import type { ResolvedFinding } from './resolver.js';
import { bucketOutOfDiff, SEVERITY_BADGES, CLI_BADGE } from './grouper.js';
import { renderReviewSummary } from './render.js';

export interface ReviewSubmissionInputs {
  pull: PullRequestRef;
  groups: GroupedComment[];
  outOfDiff: ResolvedFinding[];
  dropped: Array<{ reason: string }>;
  result: OrchestratorResult;
}

export interface SubmitReviewOptions {
  /** Maximum total attempts (initial + retries). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default 500. */
  baseDelayMs?: number;
  /** Override for testability — replaces the actual sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export async function submitReview(
  octokit: Octokit,
  inputs: ReviewSubmissionInputs,
  options: SubmitReviewOptions = {},
): Promise<{ reviewId: number; htmlUrl: string; degradedToSummaryOnly: boolean }> {
  const summary = renderReviewSummary(inputs);
  const comments = inputs.groups.map((g) => ({
    path: g.path,
    line: g.line,
    side: g.side,
    body: g.body,
  }));

  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await octokit.rest.pulls.createReview({
        owner: inputs.pull.owner,
        repo: inputs.pull.repo,
        pull_number: inputs.pull.number,
        commit_id: inputs.pull.headSha,
        body: summary,
        event: 'COMMENT',
        comments,
      });
      return { reviewId: resp.data.id, htmlUrl: resp.data.html_url, degradedToSummaryOnly: false };
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number })?.status;
      // Only retry on 5xx (transient server-side hiccups). 4xx is a
      // programmer error — retrying wastes time and can mask the bug.
      if (typeof status === 'number' && status >= 500 && status < 600 && attempt < maxAttempts) {
        const wait = baseDelayMs * Math.pow(2, attempt - 1);
        await sleep(wait);
        continue;
      }
      break;
    }
  }

  // 422 fallback: contract drift (a comment fell outside the diff, an
  // oversized payload, etc.) takes down the entire review including
  // the synthesis. Retry once with comments stripped so the summary
  // still posts. Better partial than nothing.
  const lastStatus = (lastError as { status?: number })?.status;
  if (lastStatus === 422 && comments.length > 0) {
    try {
      const resp = await octokit.rest.pulls.createReview({
        owner: inputs.pull.owner,
        repo: inputs.pull.repo,
        pull_number: inputs.pull.number,
        commit_id: inputs.pull.headSha,
        body: appendDegradedNotice(summary, comments.length),
        event: 'COMMENT',
        comments: [],
      });
      // Surface the degraded path to the caller so action outputs
      // honestly report 0 inline comments instead of the pre-fallback
      // count. Without this, workflows reading inline-comment-count
      // are misled into thinking the comments survived.
      return {
        reviewId: resp.data.id,
        htmlUrl: resp.data.html_url,
        degradedToSummaryOnly: true,
      };
    } catch (_degradedError) {
      // Preserve the original 422 as `lastError`. The 422's diagnostic
      // (describeReviewSubmissionError surfaces sample path:line:side
      // triplets pointing at the offending comment) is the actionable
      // signal for contract drift. The degraded fallback's failure is
      // secondary; if we overwrite lastError with it, we lose the
      // information the reviewer needs to fix the underlying bug.
    }
  }

  const detail = describeReviewSubmissionError(lastError, comments);
  throw new Error(`Reviews API submission failed: ${detail}`);
}

function appendDegradedNotice(body: string, droppedCount: number): string {
  return (
    body +
    `\n\n---\n\n` +
    `⚠️ **Inline comments dropped**: ${droppedCount} comment(s) couldn't be posted (HTTP 422 — likely a quote line fell outside the PR diff or contract drift). The synthesis above is still valid; raise minimum-severity or split the PR to see inline detail.`
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Best-effort diagnostic for Reviews API failures. The Reviews API will
 * 422 if any comment in the array references a line outside the diff;
 * surfacing the offending finding speeds up contract-drift debugging.
 */
function describeReviewSubmissionError(
  error: unknown,
  comments: Array<{ path: string; line: number; side: string }>,
): string {
  const status = (error as { status?: number })?.status;
  const message = (error as { message?: string })?.message ?? String(error);

  if (status === 422) {
    const sample = comments
      .slice(0, 3)
      .map((c) => `${c.path}:${c.line}:${c.side}`)
      .join(', ');
    return `HTTP 422 (likely a comment references a line outside the diff). Sample: ${sample}. Original: ${message}`;
  }
  if (status === 403) {
    return `HTTP 403 — github-token lacks pull-requests:write permission. Original: ${message}`;
  }
  return message;
}

export { bucketOutOfDiff, SEVERITY_BADGES, CLI_BADGE };
