import { describe, it, expect } from '@jest/globals';
import { chunkDiff, mergeResults, runWithConcurrency } from '../src/chunk-diff.js';
import type { OrchestratorResult, Finding, CliBreakdown } from '@brutalist/orchestrator';

function fileSection(name: string, bodyLines: number): string {
  const lines = [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -1,${bodyLines} +1,${bodyLines} @@`,
  ];
  for (let i = 0; i < bodyLines; i++) lines.push(`+line ${i} of ${name}`);
  return lines.join('\n') + '\n';
}

describe('chunkDiff', () => {
  it('returns a single chunk unchanged when the diff fits', () => {
    const diff = fileSection('a.ts', 3);
    expect(chunkDiff(diff, 10_000)).toEqual({ chunks: [diff], truncatedHunks: 0 });
  });

  it('returns no chunks for empty input', () => {
    expect(chunkDiff('', 1000)).toEqual({ chunks: [], truncatedHunks: 0 });
  });

  it('throws on a non-positive budget', () => {
    expect(() => chunkDiff('x', 0)).toThrow();
  });

  it('splits on whole-file boundaries and every chunk is within budget', () => {
    const a = fileSection('a.ts', 20);
    const b = fileSection('b.ts', 20);
    const c = fileSection('c.ts', 20);
    const diff = a + b + c;
    const budget = a.length + 5; // ~1 file per chunk
    const { chunks, truncatedHunks } = chunkDiff(diff, budget);

    expect(truncatedHunks).toBe(0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) expect(ch.length).toBeLessThanOrEqual(budget);
    // Concatenation reconstructs the original (file-boundary path is lossless).
    expect(chunks.join('')).toBe(diff);
    // Each file header lands in exactly one chunk.
    expect(chunks.filter((ch) => ch.includes('diff --git a/a.ts')).length).toBe(1);
    expect(chunks.filter((ch) => ch.includes('diff --git a/c.ts')).length).toBe(1);
  });

  it('greedily packs multiple small files into one chunk', () => {
    const a = fileSection('a.ts', 2);
    const b = fileSection('b.ts', 2);
    const diff = a + b;
    const { chunks } = chunkDiff(diff, diff.length); // exactly fits
    expect(chunks).toEqual([diff]);
  });

  it('sub-splits a single oversized file by hunks, re-emitting the header', () => {
    const header = ['diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts'].join('\n') + '\n';
    const hunk = (n: number) => `@@ -${n},1 +${n},1 @@\n+change at ${n}\n`;
    const section = header + hunk(1) + hunk(2) + hunk(3);
    // Budget fits header + ~1 hunk.
    const budget = header.length + hunk(1).length + 2;
    const { chunks, truncatedHunks } = chunkDiff(section, budget);

    expect(truncatedHunks).toBe(0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const ch of chunks) {
      expect(ch.length).toBeLessThanOrEqual(budget);
      // The file header is present on every piece so each is self-contained.
      expect(ch.startsWith('diff --git a/big.ts')).toBe(true);
      expect(ch).toContain('@@ ');
    }
  });

  it('does NOT treat a `diff --git` inside a hunk body as a file boundary', () => {
    const diff = [
      'diff --git a/real.ts b/real.ts',
      '--- a/real.ts',
      '+++ b/real.ts',
      '@@ -1,3 +1,4 @@',
      ' const foo = 1;',
      '+const marker = "diff --git a/fake b/fake";',
      ' const baz = 2;',
    ].join('\n') + '\n';
    // Even with a tiny budget that forces splitting, the fake header (which
    // is a `+`-prefixed content line) must not start a new file section.
    const { chunks } = chunkDiff(diff, 60);
    // Only ONE real file header across all chunks.
    const headerCount = chunks.reduce(
      (n, ch) => n + (ch.match(/(^|\n)diff --git /g)?.length ?? 0),
      0,
    );
    expect(headerCount).toBe(1);
  });

  it('truncates and counts a lone hunk that exceeds the budget', () => {
    const header = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts'].join('\n') + '\n';
    const hugeHunk = '@@ -1,1 +1,1 @@\n+' + 'x'.repeat(5000) + '\n';
    const section = header + hugeHunk;
    const budget = header.length + 500;
    const { chunks, truncatedHunks } = chunkDiff(section, budget);
    expect(truncatedHunks).toBe(1);
    for (const ch of chunks) expect(ch.length).toBeLessThanOrEqual(budget);
  });

  it('never emits a chunk over budget even when the file header alone exceeds it', () => {
    // Pathological: header longer than the whole budget.
    const header = 'diff --git a/x.ts b/x.ts\n' + 'H'.repeat(200) + '\n';
    const section = header + '@@ -1,1 +1,1 @@\n+y\n';
    const budget = 50; // < header.length
    const { chunks } = chunkDiff(section, budget);
    for (const ch of chunks) expect(ch.length).toBeLessThanOrEqual(budget);
  });
});

// ── mergeResults ────────────────────────────────────────────────────────────

function finding(over: Partial<Finding> = {}): Finding {
  return {
    cli: 'claude',
    path: 'src/a.ts',
    side: 'RIGHT',
    severity: 'high',
    category: 'security',
    title: 'SQLi',
    body: 'bad',
    verbatimQuote: 'query(`SELECT ${x}`)',
    ...over,
  };
}

function result(over: Partial<OrchestratorResult> = {}): OrchestratorResult {
  return {
    schemaVersion: 1,
    findings: [],
    perCli: [],
    synthesis: '',
    outOfDiff: [],
    ...over,
  };
}

describe('mergeResults', () => {
  it('concatenates findings across chunks', () => {
    const r1 = result({ findings: [finding({ title: 'A' })] });
    const r2 = result({ findings: [finding({ title: 'B', path: 'src/b.ts' })] });
    const merged = mergeResults([r1, r2]);
    expect(merged.findings.map((f) => f.title).sort()).toEqual(['A', 'B']);
    expect(merged.schemaVersion).toBe(1);
  });

  it('de-duplicates identical findings reported in two chunks', () => {
    const dup = finding({ title: 'dup', lineHint: 12 });
    const merged = mergeResults([result({ findings: [dup] }), result({ findings: [{ ...dup }] })]);
    expect(merged.findings.length).toBe(1);
  });

  it('keeps findings that differ ONLY by side (LEFT vs RIGHT)', () => {
    const left = finding({ side: 'LEFT', lineHint: 5 });
    const right = finding({ side: 'RIGHT', lineHint: 5 });
    const merged = mergeResults([result({ findings: [left] }), result({ findings: [right] })]);
    expect(merged.findings.length).toBe(2);
  });

  it('keeps distinct findings whose fields would blur under a space delimiter', () => {
    // Two genuinely different findings that a space-joined key could collide.
    const a = finding({ verbatimQuote: 'foo bar', title: 'baz' });
    const b = finding({ verbatimQuote: 'foo', title: 'bar baz' });
    const merged = mergeResults([result({ findings: [a] }), result({ findings: [b] })]);
    expect(merged.findings.length).toBe(2);
  });

  it('drops empty-synthesis chunks instead of emitting a bare "Chunk i/n:" label', () => {
    const merged = mergeResults([result({ synthesis: 'real' }), result({ synthesis: '   ' })]);
    expect(merged.synthesis.trim()).toBe('Chunk 1/2: real');
    expect(merged.synthesis).not.toMatch(/Chunk 2\/2:\s*$/);
  });

  it('carries the first non-empty contextId across chunks', () => {
    const merged = mergeResults([result({}), result({ contextId: 'ctx-2' }), result({ contextId: 'ctx-3' })]);
    expect(merged.contextId).toBe('ctx-2');
  });

  it('merges perCli per critic: OR success, sum time, keep first model', () => {
    const a: CliBreakdown = { cli: 'codex', success: false, model: 'gpt-5', executionTimeMs: 100, summary: 's1' };
    const b: CliBreakdown = { cli: 'codex', success: true, executionTimeMs: 250, summary: 's2' };
    const merged = mergeResults([result({ perCli: [a] }), result({ perCli: [b] })]);
    expect(merged.perCli.length).toBe(1);
    expect(merged.perCli[0].success).toBe(true);
    expect(merged.perCli[0].executionTimeMs).toBe(350);
    expect(merged.perCli[0].model).toBe('gpt-5');
  });

  it('labels and concatenates per-chunk synthesis', () => {
    const merged = mergeResults([result({ synthesis: 'first' }), result({ synthesis: 'second' })]);
    expect(merged.synthesis).toContain('Chunk 1/2: first');
    expect(merged.synthesis).toContain('Chunk 2/2: second');
  });
});

// ── runWithConcurrency ───────────────────────────────────────────────────────

describe('runWithConcurrency', () => {
  it('runs every item, preserves index order, and never exceeds the cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [0, 1, 2, 3, 4, 5];
    const settled = await runWithConcurrency(items, 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(settled.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(settled.every((r) => r.ok)).toBe(true);
    expect(settled.map((r) => (r.ok ? r.value : null))).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('captures per-item failures without rejecting the whole run', async () => {
    const settled = await runWithConcurrency([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(settled[0]).toMatchObject({ ok: true, value: 1 });
    expect(settled[1].ok).toBe(false);
    expect(settled[2]).toMatchObject({ ok: true, value: 3 });
  });
});
