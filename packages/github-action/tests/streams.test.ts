import { describe, it, expect } from '@jest/globals';
import { buildParticipantStreams, planPasses } from '../src/streams.js';
import { charsForWindow, type ParticipantFidelityWindow } from '../src/inputs.js';

const p = (id: string, kind: 'native' | 'custom', window: number): ParticipantFidelityWindow => ({
  id,
  kind,
  window,
});

/** A multi-file diff: N `diff --git` sections of ~perFileChars each. */
function multiFileDiff(files: number, perFileChars: number): string {
  let s = '';
  const body = ('+' + 'x'.repeat(78) + '\n').repeat(Math.ceil(perFileChars / 80));
  for (let i = 0; i < files; i++) {
    s += `diff --git a/f${i}.ts b/f${i}.ts\n@@ -1,1 +1,1 @@\n${body}`;
  }
  return s;
}

describe('buildParticipantStreams', () => {
  it('each native is its own stream; all customs collapse into ONE stream at their min window (dogfood shape)', () => {
    const streams = buildParticipantStreams(
      [
        p('claude', 'native', 1_000_000),
        p('codex', 'native', 272_000),
        p('agy', 'native', 135_000),
        p('glm', 'custom', 1_000_000),
      ],
      undefined,
      200_000,
    );
    expect(streams).toEqual([
      { tag: 'claude', label: 'claude', window: 1_000_000 },
      { tag: 'codex', label: 'codex', window: 272_000 },
      { tag: 'agy', label: 'agy', window: 135_000 },
      { tag: 'custom', label: 'custom(glm)', window: 1_000_000 },
    ]);
  });

  it('a single-native override restricts to just that native stream', () => {
    const streams = buildParticipantStreams(
      [p('claude', 'native', 1_000_000), p('agy', 'native', 135_000), p('glm', 'custom', 1_000_000)],
      'agy',
      200_000,
    );
    expect(streams).toEqual([{ tag: 'agy', label: 'agy', window: 135_000 }]);
  });

  it('multiple custom clients collapse to one stream chunked at the SMALLER window (no overflow)', () => {
    const streams = buildParticipantStreams(
      [p('glm', 'custom', 1_000_000), p('kimi', 'custom', 256_000)],
      undefined,
      200_000,
    );
    expect(streams).toEqual([{ tag: 'custom', label: 'custom(glm+kimi)', window: 256_000 }]);
  });

  it('an empty participant set falls back to a single all-critics stream at the governing window', () => {
    expect(buildParticipantStreams([], undefined, 175_000)).toEqual([
      { tag: undefined, label: 'all', window: 175_000 },
    ]);
  });
});

describe('planPasses — per-participant fidelity + leanness', () => {
  const diff = multiFileDiff(40, 40_000); // ~1.6M chars across 40 files

  it('a small-window critic gets MORE passes than a large one; the 1M critic reviews the whole diff in ONE pass', () => {
    const streams = buildParticipantStreams(
      [p('claude', 'native', 1_000_000), p('codex', 'native', 272_000), p('agy', 'native', 135_000)],
      undefined,
      200_000,
    );
    const { passes } = planPasses(streams, diff, 15);
    const count = (tag: string) => passes.filter((x) => x.stream.tag === tag).length;

    expect(count('agy')).toBeGreaterThan(count('codex'));
    expect(count('codex')).toBeGreaterThan(count('claude'));
    expect(count('claude')).toBe(1); // max cross-diff correlation, no redundant re-review

    // Fidelity invariant: NO chunk exceeds its own stream's char budget.
    for (const pass of passes) {
      expect(pass.chunk.length).toBeLessThanOrEqual(charsForWindow(pass.stream.window, 15));
    }
  });

  it('is LEANER than clamping all critics to the global-min window', () => {
    const perParticipant = planPasses(
      buildParticipantStreams(
        [p('claude', 'native', 1_000_000), p('codex', 'native', 272_000), p('agy', 'native', 135_000)],
        undefined,
        200_000,
      ),
      diff,
      15,
    ).passes.length;

    // Old model: every critic re-reviewed the diff chunked to the SMALLEST window (agy's).
    const minChunks = planPasses(
      buildParticipantStreams([p('agy', 'native', 135_000)], undefined, 200_000),
      diff,
      15,
    ).passes.length;
    const oldAllCriticsAtMin = minChunks * 3;

    expect(perParticipant).toBeLessThan(oldAllCriticsAtMin);
  });

  it('carries mechanical isolation tags + per-stream chunk indices for every pass', () => {
    const streams = buildParticipantStreams(
      [p('agy', 'native', 135_000), p('glm', 'custom', 1_000_000)],
      undefined,
      200_000,
    );
    const { passes, summaries } = planPasses(streams, diff, 15);
    // Every pass is tagged with its stream's isolation tag (native id or 'custom').
    expect(new Set(passes.map((x) => x.stream.tag))).toEqual(new Set(['agy', 'custom']));
    // Chunk indices within a stream are contiguous 0..n-1.
    for (const tag of ['agy', 'custom'] as const) {
      const streamPasses = passes.filter((x) => x.stream.tag === tag);
      expect(streamPasses.map((x) => x.i)).toEqual(streamPasses.map((_, i) => i));
      expect(streamPasses.every((x) => x.n === streamPasses.length)).toBe(true);
    }
    expect(summaries).toHaveLength(2);
  });
});
