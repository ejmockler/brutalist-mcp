/**
 * Verbatim-quote → real line number resolver.
 *
 * The orchestrator emits Findings with a `verbatimQuote` field that
 * comes from the CLI critic's prose. CLIs hallucinate line numbers
 * regularly, so we ignore `lineHint` as authoritative and locate the
 * quote in the actual file at the PR head SHA via grep-equivalent
 * matching. This is the same discipline brutalist enforces for legal/
 * research/security domains, generalized to PR review.
 *
 * Rules:
 *   - Exactly one match → use it.
 *   - Multiple matches → prefer `lineHint` if it matches one of them;
 *     otherwise drop (ambiguous reference).
 *   - Zero matches → drop or downgrade to file-level (caller's choice).
 *
 * The file content is read from the PR head SHA via the GitHub API,
 * not from a local checkout, so the resolver works in workflows that
 * don't run actions/checkout.
 */

import type { Finding } from '@brutalist/orchestrator';
import type { Octokit } from './octokit-types.js';
import type { PullRequestContext } from './diff.js';
import { diffLineKey, normalizeRepoPath } from './diff.js';

export interface ResolvedFinding extends Finding {
  /** Line resolved against the file at the PR head SHA. */
  resolvedLine: number;
  /** True when (path, resolvedLine, side) appears in the diff. */
  inDiff: boolean;
  /**
   * Why this finding ended up where it did. Surfaced in the review
   * summary so reviewers can distinguish e.g. a fabricated unanchored
   * quote from a genuine but low-severity finding.
   */
  provenance?: 'unanchored' | 'sub-threshold' | 'comment-cap-overflow';
}

export interface ResolutionOutcome {
  /** Findings whose verbatim quote resolved to a unique diff line. */
  inline: ResolvedFinding[];
  /** Findings that resolved but fall outside the diff. */
  outOfDiff: ResolvedFinding[];
  /** Findings dropped — quote not found, ambiguous, or unreadable. */
  dropped: Array<{ finding: Finding; reason: string }>;
}

export interface ResolverOptions {
  /**
   * Repo-relative subtree the orchestrator was scoped to. When set,
   * the resolver prepends it onto the agent's `finding.path` before
   * the diff-key lookup and the Contents API read.
   *
   * Without this bridging, monorepo users setting
   * `working-directory: packages/api` get a broken pipeline: the
   * orchestrator runs with that CWD so the agent emits paths like
   * `src/foo.ts`; the diff parser stores `packages/api/src/foo.ts`;
   * the diff-key lookup misses; getContent 404s at the wrong key.
   * Every finding lands in outOfDiff with "likely fabricated path"
   * even though the agent did the right thing.
   *
   * Pass '' or '.' to disable.
   */
  workingDirectoryOffset?: string;
}

interface FileCacheEntry {
  lines: string[];
}

/**
 * Resolve every finding against the PR head SHA.
 *
 * Caches per-file reads so multiple findings against the same file
 * make one API call. The PR head SHA is the right anchor (not the
 * default branch HEAD) so line numbers match what the user is
 * reviewing.
 */
export async function resolveFindings(
  findings: Finding[],
  octokit: Octokit,
  context: PullRequestContext,
  options: ResolverOptions = {},
): Promise<ResolutionOutcome> {
  // Normalize the subtree prefix once. Empty / '.' / '/' all mean
  // "no offset". A non-empty offset gets normalized through the same
  // canonicalizer so callers can pass `./packages/api` or
  // `packages/api/` interchangeably.
  const subtreeRaw = options.workingDirectoryOffset ?? '';
  const subtree =
    subtreeRaw && subtreeRaw !== '.' && subtreeRaw !== '/'
      ? normalizeRepoPath(subtreeRaw)
      : '';
  const cache = new Map<string, FileCacheEntry | null>(); // null = read failed
  // Capture the *cause* of each read failure so the drop reason can
  // distinguish "file too large for Contents API (>1MB)" from "file
  // missing" — without this, generated files / large legacy files /
  // checked-in vendor blobs all share the same opaque drop reason.
  const readErrors = new Map<string, string>();
  const inline: ResolvedFinding[] = [];
  const outOfDiff: ResolvedFinding[] = [];
  const dropped: Array<{ finding: Finding; reason: string }> = [];

  for (const rawFinding of findings) {
    // Canonicalize the agent's path against the diff parser's stored
    // form so `./src/foo.ts` / `/src/foo.ts` / `src//foo.ts` all resolve
    // to the same diff entry. When the orchestrator was scoped to a
    // subtree via working-directory, the agent emits paths relative to
    // that subtree — prepend the offset so the diff key and getContent
    // call use the full repo-root-relative path.
    const normalized = normalizeRepoPath(rawFinding.path);
    const bridged =
      subtree && !normalized.startsWith(`${subtree}/`) && normalized !== subtree
        ? normalizeRepoPath(`${subtree}/${normalized}`)
        : normalized;
    const finding: Finding = { ...rawFinding, path: bridged };
    if (finding.side === 'FILE') {
      // FILE-side findings are file-scope observations that don't
      // anchor to a specific line. We still verify the verbatimQuote
      // exists somewhere in the file — without this, an agent can
      // fabricate a finding on any path with any non-empty quote and
      // the resolver would render it under [unanchored], visually
      // identical to a legitimate finding.
      //
      // Resolution strategy: try HEAD first (the common case — file
      // exists, finding is about its current content). If the file is
      // 404 at HEAD specifically — *not* 403/1MB/5xx — try base SHA.
      // This catches the canonical "PR deletes an important file and
      // the critic complains about it" case. Without the base-SHA
      // fallback, legitimate deletion critiques get dropped with
      // "likely fabricated path", slandering a real finding.
      let file = await getFileLines(
        cache,
        readErrors,
        octokit,
        context,
        finding.path,
        context.pull.headSha,
      );
      let resolvedAt: 'head' | 'base' = 'head';
      if (!file) {
        const headKey = `${context.pull.headSha}:${finding.path}`;
        const headErr = readErrors.get(headKey) ?? '';
        // Fall back to base SHA only when the file was missing at HEAD.
        // 1MB cap and other read failures don't benefit from a base-SHA
        // retry — the file is just unfetchable.
        if (/not present at/.test(headErr)) {
          file = await getFileLines(
            cache,
            readErrors,
            octokit,
            context,
            finding.path,
            context.pull.baseSha,
          );
          if (file) resolvedAt = 'base';
        }
      }
      if (!file) {
        const cacheKey = `${resolvedAt === 'head' ? context.pull.headSha : context.pull.baseSha}:${finding.path}`;
        dropped.push({
          finding,
          reason:
            readErrors.get(cacheKey) ??
            `FILE-side: could not read ${finding.path} at head or base SHA — likely fabricated path`,
        });
        continue;
      }
      const fileMatches = findVerbatimMatches(file.lines, finding.verbatimQuote);
      if (fileMatches.length === 0) {
        dropped.push({
          finding,
          reason: `FILE-side: verbatim quote not found in ${finding.path} (${resolvedAt} SHA) — likely fabricated finding`,
        });
        continue;
      }
      // Quote verified. Keep FILE bucketing — the finding's value is at
      // file-scope, not at a specific line. resolvedLine captures the
      // first match for diagnostic purposes only.
      outOfDiff.push({
        ...finding,
        resolvedLine: fileMatches[0],
        inDiff: false,
        provenance: 'unanchored',
      });
      continue;
    }

    // LEFT-side findings comment on deleted content — that content is
    // gone from the head SHA, so we read it from the base SHA instead.
    // Cache key includes the SHA so head + base reads of the same file
    // don't collide.
    const sha = finding.side === 'LEFT' ? context.pull.baseSha : context.pull.headSha;
    const file = await getFileLines(cache, readErrors, octokit, context, finding.path, sha);
    if (!file) {
      const cacheKey = `${sha}:${finding.path}`;
      dropped.push({
        finding,
        reason:
          readErrors.get(cacheKey) ??
          `Could not read file ${finding.path} at ${finding.side === 'LEFT' ? 'base' : 'head'} SHA`,
      });
      continue;
    }

    const ranges = findVerbatimRanges(file.lines, finding.verbatimQuote);

    if (ranges.length === 0) {
      dropped.push({
        finding,
        reason: `Verbatim quote not found in ${finding.path} — quote may be fabricated or the file changed`,
      });
      continue;
    }

    // Pick the resolved line. For single-line quotes the range is a
    // 1-line window so start === end. For multi-line quotes each range
    // is the window the quote occupied. We prefer lineHint if it falls
    // within a unique commentable position inside any range — this
    // correctly anchors the comment to the changed line when the critic
    // quoted a wider context block. Without this, a multi-line quote
    // always pinned to the window's first line, which is often diff
    // context (unchanged) and dropped to outOfDiff.
    let resolvedLine: number | undefined;
    if (ranges.length === 1) {
      const r = ranges[0];
      if (
        finding.lineHint !== undefined &&
        finding.lineHint >= r.start &&
        finding.lineHint <= r.end
      ) {
        resolvedLine = finding.lineHint;
      } else if (r.start === r.end) {
        // Single-line quote — the range collapses to one line.
        resolvedLine = r.start;
      } else {
        // Multi-line quote with no usable lineHint. Prefer a CHANGED
        // line first — the critic's value is anchored to the change,
        // not to the surrounding context. Only fall back to any-in-diff
        // (which includes unchanged context lines) if no changed line
        // exists in the range, and finally to range.start.
        for (let line = r.start; line <= r.end; line++) {
          if (
            context.changedLines.has(
              diffLineKey({ path: finding.path, line, side: finding.side }),
            )
          ) {
            resolvedLine = line;
            break;
          }
        }
        if (resolvedLine === undefined) {
          for (let line = r.start; line <= r.end; line++) {
            if (
              context.diffLines.has(
                diffLineKey({ path: finding.path, line, side: finding.side }),
              )
            ) {
              resolvedLine = line;
              break;
            }
          }
        }
        if (resolvedLine === undefined) resolvedLine = r.start;
      }
    } else {
      // Multiple ranges match. Use lineHint to disambiguate if it
      // falls within one of them; otherwise drop as ambiguous.
      if (finding.lineHint !== undefined) {
        for (const r of ranges) {
          if (finding.lineHint >= r.start && finding.lineHint <= r.end) {
            resolvedLine = finding.lineHint;
            break;
          }
        }
      }
      if (resolvedLine === undefined) {
        dropped.push({
          finding,
          reason: `Verbatim quote matched ${ranges.length} ranges in ${finding.path} and lineHint did not disambiguate`,
        });
        continue;
      }
    }

    // FILE-side findings short-circuited above; remaining cases are
    // RIGHT/LEFT and the diff-key lookup is direct.
    const inDiff = context.diffLines.has(
      diffLineKey({ path: finding.path, line: resolvedLine, side: finding.side }),
    );
    if (inDiff) {
      inline.push({ ...finding, resolvedLine, inDiff });
    } else {
      // Resolved against the file but the line isn't in the diff —
      // GitHub would 422 if we tried to post inline. Surface in summary.
      outOfDiff.push({ ...finding, resolvedLine, inDiff, provenance: 'unanchored' });
    }
  }

  return { inline, outOfDiff, dropped };
}

async function getFileLines(
  cache: Map<string, FileCacheEntry | null>,
  readErrors: Map<string, string>,
  octokit: Octokit,
  context: PullRequestContext,
  path: string,
  sha: string,
): Promise<FileCacheEntry | null> {
  // Cache key includes the SHA so head- and base-side reads of the
  // same path don't collide (they will have different content if the
  // file was modified by the PR).
  const cacheKey = `${sha}:${path}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  try {
    const resp = await octokit.rest.repos.getContent({
      owner: context.pull.owner,
      repo: context.pull.repo,
      path,
      ref: sha,
    });
    const data = resp.data;
    if (Array.isArray(data) || data.type !== 'file' || !('content' in data) || !data.content) {
      cache.set(cacheKey, null);
      // No content but no thrown error usually means the response
      // shape was unexpected (directory listing, symlink, etc.).
      readErrors.set(
        cacheKey,
        `File ${path} at ${sha.substring(0, 7)} returned no content (directory or non-file?)`,
      );
      return null;
    }
    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    // Split on either CRLF or LF and never retain the \r — Windows-
    // authored files would otherwise leave \r at line ends, and the
    // multi-line sliding-window match would silently miss because the
    // agent's quote (LF-delimited) doesn't have the carriage returns.
    const entry: FileCacheEntry = { lines: decoded.split(/\r?\n/) };
    cache.set(cacheKey, entry);
    return entry;
  } catch (err) {
    cache.set(cacheKey, null);
    readErrors.set(cacheKey, classifyReadError(err, path, sha));
    return null;
  }
}

/**
 * Classify a getContent failure so reviewers can act on the drop reason.
 *
 * The Contents API in particular caps file size at 1MB and responds 403
 * with a body that says "This API returns blobs up to 1 MB in size."
 * Conflating that with a 404 (file genuinely missing) misleads the
 * reviewer into thinking the finding was fabricated, when in fact the
 * tool simply couldn't fetch the file via this endpoint.
 */
function classifyReadError(err: unknown, path: string, sha: string): string {
  const status = (err as { status?: number })?.status;
  const message = (err as { message?: string })?.message ?? '';
  const shortSha = sha.substring(0, 7);

  if (status === 403 && /1\s?MB|too large/i.test(message)) {
    return `File ${path} exceeds the Contents API 1MB cap; finding can't be anchored inline. (status 403)`;
  }
  if (status === 404) {
    return `File ${path} not present at ${shortSha}; quote may target a deleted or renamed file.`;
  }
  if (status === 403) {
    return `File ${path} read denied at ${shortSha} (status 403). Check github-token permissions.`;
  }
  if (typeof status === 'number') {
    return `File ${path} read failed at ${shortSha} (status ${status}).`;
  }
  return `File ${path} read failed at ${shortSha}: ${message || 'unknown error'}`;
}

/** A 1-indexed line range covering a verbatim-quote match. */
export interface VerbatimRange {
  start: number;
  end: number;
}

/**
 * Compatibility shim: callers that only need start lines (e.g. the
 * FILE-side resolver path) can keep using the old shape.
 */
export function findVerbatimMatches(fileLines: string[], rawQuote: string): number[] {
  return findVerbatimRanges(fileLines, rawQuote).map((r) => r.start);
}

/**
 * Return all 1-indexed line RANGES whose content contains the verbatim
 * quote. Single-line quotes produce 1-line ranges (start === end);
 * multi-line quotes produce ranges spanning the matched window. The
 * range form is what the resolver needs to correctly anchor a
 * multi-line quote to the changed line via lineHint — pinning to
 * the window's first line silently misroutes findings when the
 * change is in the middle or end of the quoted block.
 */
export function findVerbatimRanges(fileLines: string[], rawQuote: string): VerbatimRange[] {
  const needle = rawQuote.trim();
  if (!needle) return [];

  if (needle.includes('\n')) {
    return findMultiLineRanges(fileLines, needle);
  }

  const ranges: VerbatimRange[] = [];
  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].includes(needle) || fileLines[i].trim() === needle) {
      ranges.push({ start: i + 1, end: i + 1 });
    }
  }
  return ranges;
}

/**
 * Sliding-window match for multi-line quotes. The window is sized to
 * the quote's own line count; we join `quoteLines.length` consecutive
 * file lines back with `\n` and check substring containment.
 *
 * Indentation handling: critics often trim leading whitespace when
 * quoting. We try the verbatim match first; on miss, we re-attempt
 * with leading whitespace stripped from each file-window line. The
 * second pass costs little and handles the common "indented file vs
 * un-indented quote" mismatch.
 */
function findMultiLineRanges(fileLines: string[], needle: string): VerbatimRange[] {
  const quoteLines = needle.split('\n');
  const windowSize = quoteLines.length;
  if (windowSize > fileLines.length) return [];

  const ranges: VerbatimRange[] = [];
  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const window = fileLines.slice(i, i + windowSize).join('\n');
    if (window.includes(needle)) {
      ranges.push({ start: i + 1, end: i + windowSize });
      continue;
    }
    const dedentedWindow = fileLines
      .slice(i, i + windowSize)
      .map((l) => l.replace(/^\s+/, ''))
      .join('\n');
    const dedentedNeedle = quoteLines.map((l) => l.replace(/^\s+/, '')).join('\n');
    if (dedentedWindow.includes(dedentedNeedle)) {
      ranges.push({ start: i + 1, end: i + windowSize });
    }
  }
  return ranges;
}
