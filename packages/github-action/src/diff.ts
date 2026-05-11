/**
 * PR diff fetching and parsing.
 *
 * Posts to GitHub's Reviews API are constrained to lines that exist in
 * the diff (HTTP 422 otherwise). We fetch the diff, parse it into a
 * lookup of `(path, line, side) → bool`, and use that to bucket
 * findings into "inline" vs "outOfDiff".
 */

import * as github from '@actions/github';
import type { Octokit } from './octokit-types.js';

export interface PullRequestRef {
  owner: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export interface DiffLineKey {
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
}

export interface PullRequestContext {
  pull: PullRequestRef;
  diffText: string;
  /**
   * Set of "path:line:side" strings present in the diff — INCLUDES
   * context (unchanged) lines because GitHub accepts inline comments
   * on them. Use this to decide whether a comment can be posted at
   * all.
   */
  diffLines: Set<string>;
  /**
   * Subset of diffLines containing only CHANGED lines (`-` deletions
   * on LEFT, `+` additions on RIGHT). Use this when picking an anchor
   * inside a multi-line quote range — the change is what the critic
   * is reacting to, so an inert context line is almost always the
   * wrong anchor.
   */
  changedLines: Set<string>;
}

export function getPullRequestRef(): PullRequestRef | null {
  const ctx = github.context;
  const pr = ctx.payload.pull_request;
  if (!pr) {
    return null;
  }
  return {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    number: pr.number,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
  };
}

export async function fetchPullRequestContext(
  octokit: Octokit,
  pull: PullRequestRef,
): Promise<PullRequestContext> {
  // Use octokit.request directly with an explicit Accept header rather
  // than the typed `pulls.get({mediaType:{format:'diff'}})` shortcut.
  // The shortcut casts the response data as the JSON-shape type even
  // though the body is the raw diff string — that breaks under strict
  // mode and is fragile against Octokit version drift. Going through
  // .request gives us a documented, stable surface where the body is
  // explicitly typed as `unknown` and we narrow once.
  const diffResp = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner: pull.owner,
    repo: pull.repo,
    pull_number: pull.number,
    headers: { accept: 'application/vnd.github.v3.diff' },
  });
  const diffText = typeof diffResp.data === 'string' ? diffResp.data : String(diffResp.data ?? '');
  if (!diffText) {
    throw new Error(
      `Empty diff returned for ${pull.owner}/${pull.repo}#${pull.number}. ` +
        `This usually means the PR has no file changes, or the github-token lacks read access to the repo.`,
    );
  }
  const { diffLines, changedLines } = parseDiff(diffText);
  return { pull, diffText, diffLines, changedLines };
}

export function diffLineKey(key: DiffLineKey): string {
  return `${normalizeRepoPath(key.path)}:${key.line}:${key.side}`;
}

/**
 * Canonicalize a repo-relative path so that the agent's finding.path
 * and the diff parser's stored path resolve to the same string. Without
 * this, an agent emitting `./src/foo.ts`, `/src/foo.ts`, or
 * `packages/api/src/foo.ts` (when working-directory was set to a
 * subtree) misses the diff-key lookup even though the line is genuinely
 * in the diff. The visible failure looks like "agent fabricated a path"
 * when the truth is path-string drift.
 *
 * Normalization rules:
 *   - Strip a leading `./` (`./foo` → `foo`).
 *   - Strip a leading `/`   (`/foo`  → `foo`).
 *   - Collapse repeated slashes (`a//b` → `a/b`).
 *   - Resolve `..` segments where safe (no resulting upward escape).
 *   - Do NOT lowercase — case-sensitive on Linux/macOS by default.
 */
export function normalizeRepoPath(path: string): string {
  if (!path) return path;
  let s = path.trim();
  // Strip leading ./ or / so absolute/explicit-relative variants
  // collapse to the same canonical form the diff parser uses.
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('/')) s = s.slice(1);
  // Collapse repeated slashes.
  s = s.replace(/\/{2,}/g, '/');
  // Resolve `..` and `.` segments. Bail to the original if the path
  // tries to escape its root — we'd rather miss the lookup than
  // silently rewrite to something dangerous.
  const parts: string[] = [];
  for (const segment of s.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return s;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/');
}

/**
 * Parse a file path from a diff `--- a/<path>` or `+++ b/<path>` header.
 *
 * Two shapes:
 *   1. `a/src/foo.ts` — unquoted, the common case.
 *   2. `"a/src/café.ts"` — git's `core.quotepath=true` (default) wraps
 *      paths containing non-ASCII bytes in C-style quotes, escaping
 *      \\, ", \\n, \\t, and \\NNN (octal). Without this, every PR
 *      touching i18n source files / non-ASCII filenames silently loses
 *      its diff-key entries, and every finding the agent makes on those
 *      files lands in outOfDiff as "[unanchored]" with a misleading
 *      "likely fabricated path" warning.
 *
 * Returns the path without the a/ or b/ prefix, undefined if the line
 * doesn't match either shape with the expected prefix.
 */
function parseDiffPath(rest: string, prefix: 'a/' | 'b/'): string | undefined {
  if (rest.startsWith('"') && rest.endsWith('"')) {
    const unquoted = unescapeQuotedPath(rest.slice(1, -1));
    if (unquoted.startsWith(prefix)) return unquoted.slice(prefix.length);
    return undefined;
  }
  if (rest.startsWith(prefix)) return rest.slice(prefix.length);
  return undefined;
}

/**
 * Reverse git's C-style quote escaping. Handles \\, \", \n, \r, \t,
 * and \NNN (3-digit octal for non-ASCII bytes). Octal bytes are
 * collected and decoded as UTF-8 since git encodes the file path's
 * raw byte sequence, which for modern repos is UTF-8.
 */
function unescapeQuotedPath(quoted: string): string {
  const bytes: number[] = [];
  let i = 0;
  while (i < quoted.length) {
    if (quoted[i] === '\\' && i + 1 < quoted.length) {
      const next = quoted[i + 1];
      if (next === '\\' || next === '"') {
        bytes.push(next.charCodeAt(0));
        i += 2;
      } else if (next === 'n') {
        bytes.push(0x0a);
        i += 2;
      } else if (next === 'r') {
        bytes.push(0x0d);
        i += 2;
      } else if (next === 't') {
        bytes.push(0x09);
        i += 2;
      } else if (/[0-7]/.test(next) && i + 3 < quoted.length && /[0-7]/.test(quoted[i + 2]) && /[0-7]/.test(quoted[i + 3])) {
        bytes.push(parseInt(quoted.slice(i + 1, i + 4), 8));
        i += 4;
      } else {
        // Unknown escape — keep the literal backslash; defensive.
        bytes.push(0x5c);
        i += 1;
      }
    } else {
      bytes.push(quoted.charCodeAt(i));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Parse a unified diff into the set of (path, line, side) keys that the
 * Reviews API will accept inline comments for.
 *
 * RIGHT side: post-image lines (additions and unchanged context). LEFT
 * side: pre-image lines (deletions and unchanged context). Hunk headers
 * (`@@ -a,b +c,d @@`) seed the line counters.
 *
 * Path tracking is dual-source: we capture both `--- a/<path>` (base
 * path) and `+++ b/<path>` (head path). For deletions, the `+++` is
 * `/dev/null` and we use the base path. For additions/creates, `---`
 * is `/dev/null` and we use the head path. For renames-with-modification
 * the two paths differ; we key LEFT side keys by the base path and
 * RIGHT side keys by the head path. Without dual tracking, deleted
 * files inherit the previous file's `currentPath` and produce phantom
 * diff keys against the wrong file.
 */
/**
 * Backwards-compatible API: callers that only want the all-lines set
 * keep using this. New callers use parseDiff() to get changedLines too.
 */
export function parseDiffLines(diff: string): Set<string> {
  return parseDiff(diff).diffLines;
}

export interface ParsedDiff {
  diffLines: Set<string>;
  changedLines: Set<string>;
}

export function parseDiff(diff: string): ParsedDiff {
  const keys = new Set<string>();
  const changedKeys = new Set<string>();
  if (!diff) return { diffLines: keys, changedLines: changedKeys };

  const lines = diff.split('\n');
  let basePath: string | undefined; // from `--- a/<path>` (LEFT side)
  let headPath: string | undefined; // from `+++ b/<path>` (RIGHT side)
  let leftLine = 0;
  let rightLine = 0;
  let inHunk = false;

  for (const raw of lines) {
    if (raw.startsWith('diff --git')) {
      // Reset for a new file pair. Preserves no state across files.
      basePath = undefined;
      headPath = undefined;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('--- /dev/null')) {
      basePath = undefined; // creation: no base side
      continue;
    }
    if (raw.startsWith('+++ /dev/null')) {
      headPath = undefined; // deletion: no head side
      continue;
    }
    const basePathMatch = raw.match(/^--- (.+)$/);
    const headPathMatch = raw.match(/^\+\+\+ (.+)$/);
    if (basePathMatch && !raw.startsWith('--- /dev/null')) {
      const parsed = parseDiffPath(basePathMatch[1], 'a/');
      if (parsed !== undefined) basePath = parsed;
      continue;
    }
    if (headPathMatch && !raw.startsWith('+++ /dev/null')) {
      const parsed = parseDiffPath(headPathMatch[1], 'b/');
      if (parsed !== undefined) headPath = parsed;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('index ')) {
      continue;
    }

    const hunkMatch = raw.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      leftLine = parseInt(hunkMatch[1], 10);
      rightLine = parseInt(hunkMatch[3], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (raw.startsWith('\\ No newline')) continue; // diff metadata in hunk body

    if (raw.startsWith('+')) {
      if (headPath) {
        const k = `${headPath}:${rightLine}:RIGHT`;
        keys.add(k);
        changedKeys.add(k);
      }
      rightLine++;
    } else if (raw.startsWith('-')) {
      if (basePath) {
        const k = `${basePath}:${leftLine}:LEFT`;
        keys.add(k);
        changedKeys.add(k);
      }
      leftLine++;
    } else if (raw.startsWith(' ')) {
      // Context line — both sides advance, both are commentable, but
      // NEITHER is "changed" — the critic almost never wants to anchor
      // a multi-line-quote finding to a line that didn't change.
      if (headPath) keys.add(`${headPath}:${rightLine}:RIGHT`);
      if (basePath) keys.add(`${basePath}:${leftLine}:LEFT`);
      leftLine++;
      rightLine++;
    }
  }

  return { diffLines: keys, changedLines: changedKeys };
}
