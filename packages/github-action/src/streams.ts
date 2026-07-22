// Per-participant fidelity streams. Instead of clamping every critic to the
// SMALLEST participant window and re-reviewing the diff N times, each ACTIVE
// critic reviews the WHOLE diff chunked to ITS OWN fidelity window: claude/glm
// (~1M) in ~1 chunk (max cross-diff correlation, no redundant re-review), codex
// ≤272k, agy ≤135k (verbatim). Critics are agentic — window pressure is the
// diff/context, not the codebase they read themselves — so this cuts CRITIC
// invocations and raises fidelity. NB it is not universally "leaner": a large
// (uncollapsed) diff runs more separate orchestrator BRAIN passes than the old
// all-critics-per-chunk loop (see the tradeoff note in index.ts). Pure + testable;
// the driver (index.ts) wires these to the orchestrator + core logging.
import { chunkDiff } from './chunk-diff.js';
import { charsForWindow, type ParticipantFidelityWindow } from './inputs.js';

export type NativeCritic = 'claude' | 'codex' | 'agy';

export interface FidelityStream {
  /**
   * Mechanical isolation tag passed to the orchestrator (BRUTALIST_FORCE_CLIS):
   * a native critic name, `'custom'` for the collapsed custom-client stream, or
   * `undefined` for the defensive all-critics fallback.
   */
  tag: NativeCritic | 'custom' | undefined;
  label: string;
  window: number;
}

export interface StreamPass {
  stream: FidelityStream;
  chunk: string;
  i: number;
  n: number;
}

/**
 * Select the review streams for the active participants. Each NATIVE critic is
 * its own stream; ALL custom clients collapse into one `'custom'` stream chunked
 * to the smallest of their windows (they run together server-side). A single
 * native override restricts to that one native stream; an empty participant set
 * falls back to a single all-critics stream at the governing window.
 */
export function buildParticipantStreams(
  participants: ParticipantFidelityWindow[],
  nativeCriticOverride: NativeCritic | undefined,
  fallbackWindow: number,
): FidelityStream[] {
  const custom = participants.filter((p) => p.kind === 'custom');
  let streams: FidelityStream[] = participants
    .filter((p) => p.kind === 'native')
    .map((p) => ({ tag: p.id as NativeCritic, label: p.id, window: p.window }));
  if (custom.length > 0) {
    streams.push({
      tag: 'custom',
      label: `custom(${custom.map((c) => c.id).join('+')})`,
      window: Math.min(...custom.map((c) => c.window)),
    });
  }
  if (nativeCriticOverride) {
    streams = streams.filter((s) => s.tag === nativeCriticOverride);
    if (streams.length === 0) {
      // The operator pinned a critic that isn't active/authed — fail loudly
      // rather than silently reviewing with everyone (matches the pre-stream
      // "Requested CLIs not available" hard error).
      throw new Error(
        `native-critic override "${nativeCriticOverride}" is not an active/authed critic; ` +
          `active participants: ${participants.map((p) => p.id).join(', ') || '(none)'}.`,
      );
    }
  }
  if (streams.length === 0) {
    streams = [{ tag: undefined, label: 'all', window: fallbackWindow }];
  }
  return streams;
}

/**
 * If the whole diff fits the SMALLEST stream's window, every critic would review
 * it in a single chunk regardless of stream — so per-participant streams add
 * only redundant BRAIN passes (the orchestrator brain runs once PER stream, and
 * it re-reads the whole diff each time). Collapse to a single all-critics stream
 * (one brain pass, all critics) in that common case; keep per-participant streams
 * only when the diff actually exceeds some critic's window, where big critics
 * genuinely benefit from being chunked less finely than the smallest critic.
 */
export function collapseStreamsIfDiffFits(
  streams: FidelityStream[],
  diffLength: number,
  headroomPct: number,
): FidelityStream[] {
  if (streams.length <= 1) return streams;
  const minWindow = Math.min(...streams.map((s) => s.window));
  if (diffLength <= charsForWindow(minWindow, headroomPct)) {
    // tag undefined => no isolation => all critics run together in one pass.
    return [{ tag: undefined, label: 'all', window: minWindow }];
  }
  return streams;
}

/**
 * Chunk the diff per stream (each to its own window − headroom) and flatten
 * every (stream, chunk) into one work list so total concurrency is bounded
 * across ALL streams — not per-stream. Returns human-readable per-stream
 * summaries and any oversized-hunk truncation warnings for the caller to log.
 */
export function planPasses(
  streams: FidelityStream[],
  diff: string,
  headroomPct: number,
): { passes: StreamPass[]; summaries: string[]; warnings: string[] } {
  const passes: StreamPass[] = [];
  const summaries: string[] = [];
  const warnings: string[] = [];
  for (const stream of streams) {
    const budget = charsForWindow(stream.window, headroomPct);
    const { chunks, truncatedHunks } = chunkDiff(diff, budget);
    if (truncatedHunks > 0) {
      warnings.push(
        `${stream.label} stream: ${truncatedHunks} oversized hunk(s) truncated to fit its ` +
          `${stream.window}-tok window (≤${budget} chars); findings on those regions may be missed for this critic.`,
      );
    }
    summaries.push(`${stream.label}=${chunks.length}×≤${budget}c@${stream.window}tok`);
    chunks.forEach((chunk, i) => passes.push({ stream, chunk, i, n: chunks.length }));
  }
  return { passes, summaries, warnings };
}
