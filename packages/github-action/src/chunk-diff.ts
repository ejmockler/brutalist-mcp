/**
 * Context-window-aware diff chunking.
 *
 * A unified diff larger than a model's usable context window cannot be
 * reviewed in a single pass — the brain (and each critic) would hit
 * "Prompt is too long" (the v1.16.0 E2BIG fix removed the spawn-level crash
 * and exposed this context-window wall). We split the diff into chunks that
 * each fit `maxChunkChars` — sized by the caller from the *governing*
 * (smallest) participant's context window minus working headroom — run an
 * independent orchestrator review per chunk, and merge into one review.
 *
 * Splitting rules:
 *   - Prefer whole-file boundaries (`diff --git ...`), greedily packed.
 *   - A single file larger than the budget is sub-split by `@@` hunks, with
 *     its `diff --git` header re-emitted on each piece so every piece is a
 *     self-contained, critic-readable diff for that file.
 *   - A lone hunk that still exceeds the budget is truncated (counted in
 *     `truncatedHunks` so the caller can warn). Truncation is a last resort
 *     for pathological single-hunk files; whole files and hunks are kept
 *     intact in the common case.
 *
 * Invariant: every produced chunk has length <= maxChunkChars.
 */
import type { OrchestratorResult, Finding, CliBreakdown } from '@brutalist/orchestrator';

export interface ChunkResult {
  chunks: string[];
  /** Count of individual hunks that were truncated to fit the budget. */
  truncatedHunks: number;
}

/**
 * Split `diffText` into chunks no larger than `maxChunkChars`.
 * Returns a single chunk unchanged when the diff already fits.
 */
export function chunkDiff(diffText: string, maxChunkChars: number): ChunkResult {
  if (!Number.isFinite(maxChunkChars) || maxChunkChars < 1) {
    throw new Error(`chunkDiff: maxChunkChars must be a positive integer, got ${maxChunkChars}`);
  }
  if (!diffText) return { chunks: [], truncatedHunks: 0 };
  if (diffText.length <= maxChunkChars) return { chunks: [diffText], truncatedHunks: 0 };

  const sections = splitOnLinePrefix(diffText, 'diff --git ');
  const chunks: string[] = [];
  let truncatedHunks = 0;
  let current = '';

  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = '';
    }
  };

  for (const section of sections) {
    if (section.length > maxChunkChars) {
      // A single file is over budget — emit what we've packed, then split it.
      flush();
      const sub = splitFileByHunks(section, maxChunkChars);
      truncatedHunks += sub.truncatedHunks;
      for (const piece of sub.chunks) chunks.push(piece);
      continue;
    }
    if (current.length > 0 && current.length + section.length > maxChunkChars) flush();
    current += section;
  }
  flush();
  return { chunks, truncatedHunks };
}

/**
 * Split `text` into segments that each begin at a line whose content starts
 * with `prefix`. Content before the first such line becomes the first
 * segment. Index-based slicing preserves exact bytes (no newline rewriting).
 */
function splitOnLinePrefix(text: string, prefix: string): string[] {
  const starts: number[] = [];
  if (text.startsWith(prefix)) starts.push(0);
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' && text.startsWith(prefix, i + 1)) starts.push(i + 1);
  }
  if (starts.length === 0) return [text];
  const segments: string[] = [];
  if (starts[0] > 0) segments.push(text.slice(0, starts[0]));
  for (let s = 0; s < starts.length; s++) {
    const end = s + 1 < starts.length ? starts[s + 1] : text.length;
    segments.push(text.slice(starts[s], end));
  }
  return segments;
}

/** Sub-split one over-budget file section by its `@@` hunks. */
function splitFileByHunks(section: string, maxChunkChars: number): ChunkResult {
  const segs = splitOnLinePrefix(section, '@@ ');
  // segs[0] is the file header unless the section itself starts with "@@ ".
  const hasHeader = !section.startsWith('@@ ');
  const header = hasHeader ? segs[0] : '';
  const hunks = hasHeader ? segs.slice(1) : segs;

  if (hunks.length === 0) {
    // Binary file / pure rename with no hunks: truncate the section to fit.
    return { chunks: [section.slice(0, maxChunkChars)], truncatedHunks: 1 };
  }

  const chunks: string[] = [];
  let truncatedHunks = 0;
  let current = header;

  for (const hunk of hunks) {
    if (header.length + hunk.length > maxChunkChars) {
      // This single hunk can't fit even with just the header. Flush any
      // packed hunks, then emit a truncated piece. Clamp the WHOLE piece to
      // the budget so the invariant holds even when the header alone is
      // >= maxChunkChars (room === 0).
      if (current.length > header.length) chunks.push(current);
      const room = Math.max(0, maxChunkChars - header.length);
      chunks.push((header + hunk.slice(0, room)).slice(0, maxChunkChars));
      truncatedHunks++;
      current = header;
      continue;
    }
    if (current.length > header.length && current.length + hunk.length > maxChunkChars) {
      chunks.push(current);
      current = header + hunk;
    } else {
      current += hunk;
    }
  }
  if (current.length > header.length) chunks.push(current);
  return { chunks, truncatedHunks };
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight at once.
 * Never rejects: each slot resolves to `{ ok, value | error, index }` so a
 * failed chunk degrades coverage instead of failing the whole review.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ index: number; ok: true; value: R } | { index: number; ok: false; error: unknown }>> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: Array<{ index: number; ok: true; value: R } | { index: number; ok: false; error: unknown }> = [];
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i], i);
        results.push({ index: i, ok: true, value });
      } catch (error) {
        results.push({ index: i, ok: false, error });
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  results.sort((a, b) => a.index - b.index);
  return results;
}

/**
 * Merge per-chunk OrchestratorResults into one. Findings/outOfDiff are
 * concatenated and de-duplicated; perCli is merged per critic (success OR-ed,
 * execution time is the per-critic MAX across chunks (chunks run in parallel
 * via chunkConcurrency, so summing overcounts wall-clock; at chunkConcurrency=1
 * this undercounts total work — an intentional latency-over-cost signal));
 * synthesis is concatenated with chunk labels. Quotes are anchored to
 * file+line downstream, so concatenating across chunks is sound — chunks are
 * disjoint by file/hunk.
 */
export function mergeResults(results: OrchestratorResult[]): OrchestratorResult {
  const findings = dedupeFindings(results.flatMap((r) => r.findings));
  const outOfDiff = dedupeFindings(results.flatMap((r) => r.outOfDiff));
  const perCli = mergePerCli(results.flatMap((r) => r.perCli));

  // Trim BEFORE labeling so an empty-synthesis chunk is dropped entirely
  // rather than emitting a bare "Chunk i/n:" label. Chunk index stays stable.
  const synthesis = results
    .map((r, i) => {
      const s = (r.synthesis ?? '').trim();
      if (!s) return '';
      return results.length > 1 ? `Chunk ${i + 1}/${results.length}: ${s}` : s;
    })
    .filter((s) => s.length > 0)
    .join('\n\n');

  // Carry the first non-empty contextId so the review's debug footer still
  // has a breadcrumb on chunked runs (each chunk has its own; no resume logic
  // depends on it).
  const contextId = results.find((r) => r.contextId)?.contextId;

  return { schemaVersion: 1, findings, perCli, synthesis, outOfDiff, ...(contextId ? { contextId } : {}) };
}

// Field separator for finding dedup keys: ASCII char code 0. It cannot occur
// in a path, line number, verbatim source quote, or title, so field
// boundaries are unambiguous — a single-space delimiter blurs on free-text
// fields and could collapse two distinct findings into one (a lost finding).
// Built via fromCharCode so no control byte appears in this source file.
const FIELD_SEP = String.fromCharCode(0);

function findingKey(f: Finding): string {
  // `side` is part of the key: LEFT vs RIGHT on the same line is a distinct
  // finding (matches grouper.ts keying on path::line::side).
  return [f.clientId ?? f.cli, f.cli, f.path, f.side, f.lineHint ?? '', f.verbatimQuote, f.title].join(FIELD_SEP);
}

function dedupeFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function mergePerCli(entries: CliBreakdown[]): CliBreakdown[] {
  const byCli = new Map<string, CliBreakdown>();
  for (const e of entries) {
    const key = e.clientId ?? e.cli;
    const existing = byCli.get(key);
    if (!existing) {
      byCli.set(key, { ...e });
      continue;
    }
    existing.success = existing.success || e.success;
    existing.executionTimeMs = Math.max(existing.executionTimeMs, e.executionTimeMs);
    if (!existing.model && e.model) existing.model = e.model;
    if (e.summary && !existing.summary.includes(e.summary)) {
      existing.summary = existing.summary ? `${existing.summary}\n\n${e.summary}` : e.summary;
    }
  }
  return [...byCli.values()];
}
