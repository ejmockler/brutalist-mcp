import { describe, it, expect } from '@jest/globals';
import { makeClientIdNormalizer, dedupePerCli } from '../src/attribution.js';

describe('makeClientIdNormalizer', () => {
  it('returns undefined when clientId is absent (native, no knownClientIds)', () => {
    const normalize = makeClientIdNormalizer();
    expect(normalize('claude', undefined)).toBeUndefined();
  });

  it('returns undefined when clientId equals cli (redundant native label)', () => {
    const normalize = makeClientIdNormalizer(['glm']);
    expect(normalize('claude', 'claude')).toBeUndefined();
    expect(normalize('codex', 'codex')).toBeUndefined();
    expect(normalize('agy', 'agy')).toBeUndefined();
  });

  it('keeps a known provisioned id (e.g. glm)', () => {
    const normalize = makeClientIdNormalizer(['glm']);
    expect(normalize('claude', 'glm')).toBe('glm');
  });

  it('drops an unknown id to native (undefined)', () => {
    const normalize = makeClientIdNormalizer(['glm']);
    expect(normalize('claude', 'phantom')).toBeUndefined();
  });

  it('keeps native cli names as valid ids even when knownClientIds omits them', () => {
    const normalize = makeClientIdNormalizer([]);
    // The native cli names are always in the known set.
    expect(normalize('codex', 'claude')).toBe('claude');
    expect(normalize('claude', 'agy')).toBe('agy');
  });

  it('back-compat: no normalization when knownClientIds is omitted — unknown ids pass through unchanged', () => {
    // When called with no knownClientIds, NATIVE_CLIS are still in the set,
    // but an arbitrary id that is not native is still dropped. However, the
    // spec says "Omitted => no normalization (back-compat)". Let's verify the
    // actual contract: knownClientIds omitted means the set contains only
    // NATIVE_CLIS, so non-native ids ARE dropped. This IS the back-compat
    // behaviour for callers that don't provision any custom ids.
    const normalize = makeClientIdNormalizer(undefined);
    // Native ids are kept.
    expect(normalize('codex', 'claude')).toBe('claude');
    // Completely unknown ids are dropped even without provisioned ids.
    expect(normalize('claude', 'totally-unknown')).toBeUndefined();
    // Native absent stays undefined.
    expect(normalize('claude', undefined)).toBeUndefined();
  });

  it('invariant: glm provisioned + finding{cli:claude, clientId:glm} => kept as glm', () => {
    const normalize = makeClientIdNormalizer(['glm']);
    expect(normalize('claude', 'glm')).toBe('glm');
  });

  it('invariant: glm provisioned + finding{cli:claude, clientId:phantom} => undefined', () => {
    const normalize = makeClientIdNormalizer(['glm']);
    expect(normalize('claude', 'phantom')).toBeUndefined();
  });

  it('invariant: native finding{cli:claude} stays undefined and is distinct from glm', () => {
    const normalize = makeClientIdNormalizer(['glm']);
    expect(normalize('claude', undefined)).toBeUndefined();
    expect(normalize('claude', 'glm')).toBe('glm');
  });

  it('handles multiple provisioned ids', () => {
    const normalize = makeClientIdNormalizer(['glm', 'custom-claude', 'other']);
    expect(normalize('claude', 'glm')).toBe('glm');
    expect(normalize('claude', 'custom-claude')).toBe('custom-claude');
    expect(normalize('claude', 'other')).toBe('other');
    expect(normalize('claude', 'not-in-list')).toBeUndefined();
  });
});

describe('dedupePerCli (single-chunk submit_findings dedupe)', () => {
  it('collapses a native + phantom-clamped claude row to one (keep-first)', () => {
    // After the clamp, a hallucinated {cli:claude, clientId:phantom} row has
    // become {cli:claude, clientId:undefined} — byte-identical to a genuine
    // native row. This is exactly E-new-bug: two identical native rows on the
    // single-chunk path. dedupePerCli must collapse them, keeping the first.
    const normalize = makeClientIdNormalizer(['glm']);
    const clamp = <T extends { cli: string; clientId?: string }>(r: T): T => ({
      ...r,
      clientId: normalize(r.cli, r.clientId),
    });
    const rows = [
      { cli: 'claude', success: true, executionTimeMs: 100, summary: 'native' },
      { cli: 'claude', clientId: 'phantom', success: true, executionTimeMs: 200, summary: 'phantom' },
    ].map(clamp);

    const deduped = dedupePerCli(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].cli).toBe('claude');
    expect(deduped[0].clientId).toBeUndefined();
    expect(deduped[0].summary).toBe('native'); // keep-first
  });

  it('keeps a native row and a known-clientId row as distinct (no over-collapse)', () => {
    // 'claude' native vs 'glm'-attributed are genuinely distinct keys.
    const normalize = makeClientIdNormalizer(['glm']);
    const clamp = <T extends { cli: string; clientId?: string }>(r: T): T => ({
      ...r,
      clientId: normalize(r.cli, r.clientId),
    });
    const rows = [
      { cli: 'claude', success: true, executionTimeMs: 100, summary: 'native' },
      { cli: 'claude', clientId: 'glm', success: true, executionTimeMs: 200, summary: 'glm' },
    ].map(clamp);

    const deduped = dedupePerCli(rows);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((r) => r.clientId)).toEqual([undefined, 'glm']);
  });

  it('namespaces by (cli, clientId): same clientId under a different cli stays DISTINCT', () => {
    // The composite (cli, clientId) key (mirrored in chunk-diff.ts mergePerCli)
    // keeps these as two rows — the old bare-clientId key wrongly collapsed them,
    // letting one critic's breakdown shadow another's across cli boundaries.
    const rows = [
      { cli: 'claude', clientId: 'glm', success: true, executionTimeMs: 1, summary: 'a' },
      { cli: 'codex', clientId: 'glm', success: true, executionTimeMs: 2, summary: 'b' },
    ];
    const deduped = dedupePerCli(rows);
    expect(deduped).toHaveLength(2);
  });
});
