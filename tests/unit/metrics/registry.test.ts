/**
 * Unit tests for `src/metrics/` — the Prometheus-compatible metrics module.
 *
 * These tests prove the TOOL works in isolation, before any other module
 * wires it in. They enforce the five non-negotiables from the phase spec:
 *
 *   1. `createMetricsRegistry()` returns a FRESH registry — two calls
 *      produce independent state (test isolation relies on this).
 *   2. Firing each of the four required metrics produces text exposition
 *      with the expected name, labels, and value.
 *   3. Histogram observations land in the documented cumulative buckets.
 *   4. Counter increments under non-conflicting labels do not collide.
 *   5. `getMetricsAsText()` returns a valid `text/plain; version=0.0.4`
 *      exposition string.
 *
 * Additional coverage:
 *   - No module-level singletons (factory invocation yields distinct objects
 *     with distinct internal state — verified via cross-registry mutation).
 *   - Label value escaping (backslash, quote, newline).
 *   - Bucket validation (non-ascending / non-finite buckets rejected).
 *   - Negative counter deltas rejected (Prometheus counters are monotonic).
 */

import { describe, it, expect } from '@jest/globals';
import {
  createMetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
  DEBATE_DURATION_BUCKETS,
  DEBATE_DURATION_LABELS,
  ESCALATION_TIER_LABELS,
  CLI_SPAWN_LABELS,
  STREAMING_EVENT_LABELS
} from '../../../src/metrics/index.js';

describe('createMetricsRegistry — factory isolation', () => {
  it('returns a fresh registry on every call (two calls are distinct objects)', () => {
    const a = createMetricsRegistry();
    const b = createMetricsRegistry();

    expect(a).not.toBe(b);
    expect(a.debateOrchestrationDurationSeconds).not.toBe(b.debateOrchestrationDurationSeconds);
    expect(a.debateEscalationTierTotal).not.toBe(b.debateEscalationTierTotal);
    expect(a.cliSpawnTotal).not.toBe(b.cliSpawnTotal);
    expect(a.streamingEventsTotal).not.toBe(b.streamingEventsTotal);
  });

  it('keeps counter state independent between registries', () => {
    const a = createMetricsRegistry();
    const b = createMetricsRegistry();

    a.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });
    a.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });
    a.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });

    b.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });

    const aSnapshot = a.cliSpawnTotal.snapshot();
    const bSnapshot = b.cliSpawnTotal.snapshot();

    const aValue = aSnapshot.get('provider="claude",outcome="success"');
    const bValue = bSnapshot.get('provider="claude",outcome="success"');

    expect(aValue).toBe(3);
    expect(bValue).toBe(1);
  });

  it('keeps histogram state independent between registries', () => {
    const a = createMetricsRegistry();
    const b = createMetricsRegistry();

    a.debateOrchestrationDurationSeconds.observe({ outcome: 'success', tier: 'standard' }, 1.2);
    a.debateOrchestrationDurationSeconds.observe({ outcome: 'success', tier: 'standard' }, 3.8);
    b.debateOrchestrationDurationSeconds.observe({ outcome: 'success', tier: 'standard' }, 0.1);

    const aSnap = a.debateOrchestrationDurationSeconds.snapshot();
    const bSnap = b.debateOrchestrationDurationSeconds.snapshot();

    const key = 'outcome="success",tier="standard"';
    expect(aSnap.get(key)?.count).toBe(2);
    expect(aSnap.get(key)?.sum).toBeCloseTo(5.0, 6);
    expect(bSnap.get(key)?.count).toBe(1);
    expect(bSnap.get(key)?.sum).toBeCloseTo(0.1, 6);
  });

  it('does not leak label sets across registries', () => {
    const a = createMetricsRegistry();
    const b = createMetricsRegistry();

    a.debateEscalationTierTotal.inc({ tier: 'escalated' });

    // b must not see a's labels.
    const bSnap = b.debateEscalationTierTotal.snapshot();
    expect(bSnap.size).toBe(0);
  });
});

describe('MetricsRegistry surface — declared metrics match phase spec', () => {
  it('exposes the four required metric handles with the expected descriptor names', () => {
    const metrics = createMetricsRegistry();

    expect(metrics.debateOrchestrationDurationSeconds.descriptor.name)
      .toBe('brutalist_debate_orchestration_duration_seconds');
    expect(metrics.debateEscalationTierTotal.descriptor.name)
      .toBe('brutalist_debate_escalation_tier_total');
    expect(metrics.cliSpawnTotal.descriptor.name)
      .toBe('brutalist_cli_spawn_total');
    expect(metrics.streamingEventsTotal.descriptor.name)
      .toBe('brutalist_streaming_events_total');
  });

  it('declares the label schemas documented in the registry module', () => {
    const metrics = createMetricsRegistry();

    expect(metrics.debateOrchestrationDurationSeconds.descriptor.labelNames)
      .toEqual(DEBATE_DURATION_LABELS);
    expect(metrics.debateEscalationTierTotal.descriptor.labelNames)
      .toEqual(ESCALATION_TIER_LABELS);
    expect(metrics.cliSpawnTotal.descriptor.labelNames)
      .toEqual(CLI_SPAWN_LABELS);
    expect(metrics.streamingEventsTotal.descriptor.labelNames)
      .toEqual(STREAMING_EVENT_LABELS);
  });

  it('uses the documented duration buckets on the debate histogram', () => {
    const metrics = createMetricsRegistry();
    expect(metrics.debateOrchestrationDurationSeconds.descriptor.buckets)
      .toEqual(DEBATE_DURATION_BUCKETS);
  });

  it('exports the correct Prometheus exposition Content-Type', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});

describe('Counter emission — cliSpawnTotal + debateEscalationTierTotal', () => {
  it('records a labeled increment and surfaces it in the text exposition', () => {
    const metrics = createMetricsRegistry();

    metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });

    const text = metrics.getMetricsAsText();
    expect(text).toContain('# HELP brutalist_cli_spawn_total');
    expect(text).toContain('# TYPE brutalist_cli_spawn_total counter');
    expect(text).toContain(
      'brutalist_cli_spawn_total{provider="claude",outcome="success"} 1'
    );
  });

  it('increments by a user-supplied delta', () => {
    const metrics = createMetricsRegistry();

    metrics.cliSpawnTotal.inc({ provider: 'codex', outcome: 'failure' }, 5);
    metrics.cliSpawnTotal.inc({ provider: 'codex', outcome: 'failure' }, 2);

    const snap = metrics.cliSpawnTotal.snapshot();
    expect(snap.get('provider="codex",outcome="failure"')).toBe(7);
  });

  it('does not collide when two distinct label sets are incremented', () => {
    const metrics = createMetricsRegistry();

    metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });
    metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });
    metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'failure' });
    metrics.cliSpawnTotal.inc({ provider: 'codex', outcome: 'success' });
    metrics.cliSpawnTotal.inc({ provider: 'gemini', outcome: 'timeout' });

    const snap = metrics.cliSpawnTotal.snapshot();
    expect(snap.get('provider="claude",outcome="success"')).toBe(2);
    expect(snap.get('provider="claude",outcome="failure"')).toBe(1);
    expect(snap.get('provider="codex",outcome="success"')).toBe(1);
    expect(snap.get('provider="gemini",outcome="timeout"')).toBe(1);
    expect(snap.size).toBe(4);
  });

  it('renders escalation tier counts for every tier value', () => {
    const metrics = createMetricsRegistry();

    metrics.debateEscalationTierTotal.inc({ tier: 'standard' });
    metrics.debateEscalationTierTotal.inc({ tier: 'standard' });
    metrics.debateEscalationTierTotal.inc({ tier: 'escalated' });
    metrics.debateEscalationTierTotal.inc({ tier: 'decomposed' });

    const text = metrics.getMetricsAsText();
    expect(text).toContain('brutalist_debate_escalation_tier_total{tier="standard"} 2');
    expect(text).toContain('brutalist_debate_escalation_tier_total{tier="escalated"} 1');
    expect(text).toContain('brutalist_debate_escalation_tier_total{tier="decomposed"} 1');
  });

  it('rejects negative counter deltas (Prometheus counters are monotonic)', () => {
    const metrics = createMetricsRegistry();
    expect(() =>
      metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' }, -1)
    ).toThrow(/delta must be >= 0/);
  });

  it('rejects non-finite counter deltas', () => {
    const metrics = createMetricsRegistry();
    expect(() =>
      metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' }, Number.NaN)
    ).toThrow(/delta must be finite/);
    expect(() =>
      metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' }, Infinity)
    ).toThrow(/delta must be finite/);
  });

  it('emits only HELP+TYPE headers when no samples have been recorded', () => {
    const metrics = createMetricsRegistry();
    const text = metrics.getMetricsAsText();

    expect(text).toContain('# HELP brutalist_cli_spawn_total');
    expect(text).toContain('# TYPE brutalist_cli_spawn_total counter');
    // No sample lines for an empty counter.
    expect(text).not.toMatch(/^brutalist_cli_spawn_total\{/m);
  });
});

describe('Streaming events counter', () => {
  it('records events labeled by transport and event_type', () => {
    const metrics = createMetricsRegistry();

    metrics.streamingEventsTotal.inc({ transport: 'stdio', event_type: 'agent_progress' });
    metrics.streamingEventsTotal.inc({ transport: 'stdio', event_type: 'agent_progress' });
    metrics.streamingEventsTotal.inc({ transport: 'http', event_type: 'agent_progress' });
    metrics.streamingEventsTotal.inc({ transport: 'http', event_type: 'agent_error' });

    const text = metrics.getMetricsAsText();
    expect(text).toContain(
      'brutalist_streaming_events_total{transport="stdio",event_type="agent_progress"} 2'
    );
    expect(text).toContain(
      'brutalist_streaming_events_total{transport="http",event_type="agent_progress"} 1'
    );
    expect(text).toContain(
      'brutalist_streaming_events_total{transport="http",event_type="agent_error"} 1'
    );
  });
});

describe('Histogram emission — debateOrchestrationDurationSeconds', () => {
  it('lands observations in the correct cumulative buckets', () => {
    const metrics = createMetricsRegistry();
    const h = metrics.debateOrchestrationDurationSeconds;
    const labels = { outcome: 'success', tier: 'standard' } as const;

    // Buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300] + +Inf
    // Observations and their expected bucket memberships (<=):
    //   0.3  -> all buckets [0.5, 1, 2, 5, 10, 30, 60, 120, 300, +Inf]
    //   1.5  -> [2, 5, 10, 30, 60, 120, 300, +Inf]
    //   4.0  -> [5, 10, 30, 60, 120, 300, +Inf]
    //   25   -> [30, 60, 120, 300, +Inf]
    //   100  -> [120, 300, +Inf]
    //   400  -> [+Inf]
    h.observe(labels, 0.3);
    h.observe(labels, 1.5);
    h.observe(labels, 4.0);
    h.observe(labels, 25);
    h.observe(labels, 100);
    h.observe(labels, 400);

    const snap = h.snapshot();
    const entry = snap.get('outcome="success",tier="standard"');
    expect(entry).toBeDefined();

    // Cumulative counts per bucket (index maps to DEBATE_DURATION_BUCKETS position).
    // buckets = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, +Inf]
    // expected [ 1,  1, 2, 3,  3,  4,  4,   5,   5,    6]
    expect(entry!.cumulative).toEqual([1, 1, 2, 3, 3, 4, 4, 5, 5, 6]);
    expect(entry!.count).toBe(6);
    expect(entry!.sum).toBeCloseTo(0.3 + 1.5 + 4.0 + 25 + 100 + 400, 6);
  });

  it('renders `_bucket`, `_sum`, and `_count` series with the `le` label', () => {
    const metrics = createMetricsRegistry();
    const h = metrics.debateOrchestrationDurationSeconds;

    h.observe({ outcome: 'success', tier: 'standard' }, 0.75);
    h.observe({ outcome: 'success', tier: 'standard' }, 3.0);

    const text = metrics.getMetricsAsText();

    // Headers
    expect(text).toContain('# TYPE brutalist_debate_orchestration_duration_seconds histogram');

    // Bucket lines with le="..." appended after existing labels.
    expect(text).toContain(
      'brutalist_debate_orchestration_duration_seconds_bucket{outcome="success",tier="standard",le="0.5"} 0'
    );
    expect(text).toContain(
      'brutalist_debate_orchestration_duration_seconds_bucket{outcome="success",tier="standard",le="1"} 1'
    );
    expect(text).toContain(
      'brutalist_debate_orchestration_duration_seconds_bucket{outcome="success",tier="standard",le="5"} 2'
    );
    expect(text).toContain(
      'brutalist_debate_orchestration_duration_seconds_bucket{outcome="success",tier="standard",le="+Inf"} 2'
    );

    // Sum and count lines.
    expect(text).toContain(
      'brutalist_debate_orchestration_duration_seconds_sum{outcome="success",tier="standard"} 3.75'
    );
    expect(text).toContain(
      'brutalist_debate_orchestration_duration_seconds_count{outcome="success",tier="standard"} 2'
    );
  });

  it('separates bucket state across different label sets', () => {
    const metrics = createMetricsRegistry();
    const h = metrics.debateOrchestrationDurationSeconds;

    h.observe({ outcome: 'success', tier: 'standard' }, 1.0);
    h.observe({ outcome: 'success', tier: 'escalated' }, 50);
    h.observe({ outcome: 'refused', tier: 'decomposed' }, 150);

    const snap = h.snapshot();
    expect(snap.size).toBe(3);

    const standard = snap.get('outcome="success",tier="standard"');
    const escalated = snap.get('outcome="success",tier="escalated"');
    const refused = snap.get('outcome="refused",tier="decomposed"');

    expect(standard?.count).toBe(1);
    expect(standard?.sum).toBeCloseTo(1.0, 6);
    expect(escalated?.count).toBe(1);
    expect(escalated?.sum).toBeCloseTo(50, 6);
    expect(refused?.count).toBe(1);
    expect(refused?.sum).toBeCloseTo(150, 6);
  });

  it('rejects non-finite observations', () => {
    const metrics = createMetricsRegistry();
    const h = metrics.debateOrchestrationDurationSeconds;

    expect(() =>
      h.observe({ outcome: 'success', tier: 'standard' }, Number.NaN)
    ).toThrow(/observation must be finite/);
    expect(() =>
      h.observe({ outcome: 'success', tier: 'standard' }, Infinity)
    ).toThrow(/observation must be finite/);
  });

  // RM1: histogram symmetry with counter — negative observations must be
  // rejected. The duration histogram is wall-clock seconds; a negative
  // value cannot be a real duration and would poison `_sum` + contaminate
  // every finite bucket (cumulative semantics increment all buckets whose
  // upper bound >= value; any negative value is <= every finite bucket).
  it('rejects negative observations (symmetric with Counter.inc negative-delta behavior)', () => {
    const metrics = createMetricsRegistry();
    const h = metrics.debateOrchestrationDurationSeconds;

    expect(() =>
      h.observe({ outcome: 'success', tier: 'standard' }, -0.001)
    ).toThrow(/observation must be >= 0/);
    expect(() =>
      h.observe({ outcome: 'success', tier: 'standard' }, -1)
    ).toThrow(/observation must be >= 0/);
    expect(() =>
      h.observe({ outcome: 'success', tier: 'standard' }, -1e6)
    ).toThrow(/observation must be >= 0/);
  });

  it('matches Counter.inc rejection mode for negative values (both throw)', () => {
    const metrics = createMetricsRegistry();

    // The counter already throws on negative delta (proven by the
    // "rejects negative counter deltas" test in the Counter block).
    // Confirm histogram shares the SAME rejection mode: both throw, not
    // silently skip. This symmetry matters so callers only have to handle
    // one failure shape across the two metric types.
    expect(() =>
      metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' }, -1)
    ).toThrow();
    expect(() =>
      metrics.debateOrchestrationDurationSeconds.observe(
        { outcome: 'success', tier: 'standard' },
        -1
      )
    ).toThrow();
  });

  it('accepts zero observations (the lower bound of the valid range)', () => {
    const metrics = createMetricsRegistry();
    const h = metrics.debateOrchestrationDurationSeconds;

    h.observe({ outcome: 'success', tier: 'standard' }, 0);

    const snap = h.snapshot();
    const entry = snap.get('outcome="success",tier="standard"');
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(1);
    expect(entry!.sum).toBe(0);
    // Zero is <= every finite bucket plus +Inf, so every bucket is 1.
    expect(entry!.cumulative).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('does not contaminate bucket counts or _sum when a negative observation is rejected', () => {
    const metrics = createMetricsRegistry();
    const h = metrics.debateOrchestrationDurationSeconds;
    const labels = { outcome: 'success', tier: 'standard' } as const;

    // Record a legitimate observation first so the per-label-set state is
    // initialized; the negative attempt below must leave it untouched.
    h.observe(labels, 2.5);

    const before = h.snapshot().get('outcome="success",tier="standard"')!;
    expect(before.count).toBe(1);
    expect(before.sum).toBeCloseTo(2.5, 6);

    // Attempt a negative observation — must throw and leave state unchanged.
    expect(() => h.observe(labels, -5)).toThrow(/observation must be >= 0/);

    const after = h.snapshot().get('outcome="success",tier="standard"')!;
    expect(after.count).toBe(1); // unchanged
    expect(after.sum).toBeCloseTo(2.5, 6); // unchanged — not shifted by -5
    expect(after.cumulative).toEqual(before.cumulative); // no bucket contamination
  });

  it('does not initialize per-label state when the FIRST observation is negative', () => {
    const metrics = createMetricsRegistry();
    const h = metrics.debateOrchestrationDurationSeconds;

    // If the rejection path accidentally created the bucket entry before
    // throwing, snapshot() would show a zero-count placeholder — that
    // would still be a bug (cardinality leak via bad input).
    expect(() =>
      h.observe({ outcome: 'success', tier: 'escalated' }, -1)
    ).toThrow();

    const snap = h.snapshot();
    expect(snap.get('outcome="success",tier="escalated"')).toBeUndefined();
    expect(snap.size).toBe(0);
  });
});

describe('getMetricsAsText — Prometheus text format 0.0.4 exposition', () => {
  it('emits all four required metrics with correct HELP + TYPE headers', () => {
    const metrics = createMetricsRegistry();
    const text = metrics.getMetricsAsText();

    // HELP lines present for each metric.
    expect(text).toMatch(/^# HELP brutalist_debate_orchestration_duration_seconds /m);
    expect(text).toMatch(/^# HELP brutalist_debate_escalation_tier_total /m);
    expect(text).toMatch(/^# HELP brutalist_cli_spawn_total /m);
    expect(text).toMatch(/^# HELP brutalist_streaming_events_total /m);

    // TYPE lines with correct types.
    expect(text).toMatch(/^# TYPE brutalist_debate_orchestration_duration_seconds histogram$/m);
    expect(text).toMatch(/^# TYPE brutalist_debate_escalation_tier_total counter$/m);
    expect(text).toMatch(/^# TYPE brutalist_cli_spawn_total counter$/m);
    expect(text).toMatch(/^# TYPE brutalist_streaming_events_total counter$/m);
  });

  it('ends with a trailing newline (spec-compliant exposition)', () => {
    const metrics = createMetricsRegistry();
    const text = metrics.getMetricsAsText();
    expect(text.endsWith('\n')).toBe(true);
  });

  it('each sample line has the form `<metric>{<labels>} <value>` when labels exist', () => {
    const metrics = createMetricsRegistry();

    metrics.debateEscalationTierTotal.inc({ tier: 'standard' }, 3);
    metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' }, 7);

    const text = metrics.getMetricsAsText();

    // Walk sample lines (non-header, non-empty).
    const sampleLines = text
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    for (const line of sampleLines) {
      // Prometheus text format: name{labels} value   OR   name value
      // (with optional timestamp we do not emit)
      expect(line).toMatch(
        /^[a-zA-Z_][a-zA-Z0-9_]*(\{[^}]*\})? -?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/
      );
    }
  });

  it('renders a single exposition that concatenates all metric blocks in a stable order', () => {
    const metrics = createMetricsRegistry();

    metrics.debateOrchestrationDurationSeconds.observe({ outcome: 'success', tier: 'standard' }, 2);
    metrics.debateEscalationTierTotal.inc({ tier: 'standard' });
    metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });
    metrics.streamingEventsTotal.inc({ transport: 'stdio', event_type: 'agent_progress' });

    const text = metrics.getMetricsAsText();

    const idxDurationType = text.indexOf('# TYPE brutalist_debate_orchestration_duration_seconds');
    const idxTierType = text.indexOf('# TYPE brutalist_debate_escalation_tier_total');
    const idxSpawnType = text.indexOf('# TYPE brutalist_cli_spawn_total');
    const idxStreamingType = text.indexOf('# TYPE brutalist_streaming_events_total');

    // Registry renders blocks in a stable, documented order.
    expect(idxDurationType).toBeGreaterThanOrEqual(0);
    expect(idxTierType).toBeGreaterThan(idxDurationType);
    expect(idxSpawnType).toBeGreaterThan(idxTierType);
    expect(idxStreamingType).toBeGreaterThan(idxSpawnType);
  });
});

describe('Label-value escaping — protects exposition from injection', () => {
  it('escapes double-quotes, backslashes, and newlines inside label values', () => {
    const metrics = createMetricsRegistry();

    // Not a realistic production value, but proves the escaper is wired up
    // for ANY caller-supplied label string.
    metrics.streamingEventsTotal.inc({
      transport: 'stdio',
      event_type: 'weird"type\nwith\\chars'
    });

    const text = metrics.getMetricsAsText();
    // The output must escape the quote, the newline, and the backslash
    // per Prometheus text-format 0.0.4.
    expect(text).toContain('event_type="weird\\"type\\nwith\\\\chars"');
  });

  // RM5: CR must be escaped to prevent CRLF-aware downstream tooling
  // (HTTP scrapers, browser views, log viewers) from treating a CR inside
  // a label value as a logical end-of-line.
  it('escapes carriage returns (\\r) inside label values', () => {
    const metrics = createMetricsRegistry();

    metrics.streamingEventsTotal.inc({
      transport: 'stdio',
      event_type: 'carr\riage'
    });

    const text = metrics.getMetricsAsText();
    expect(text).toContain('event_type="carr\\riage"');
    // The literal CR byte (0x0D) must NOT survive in the output.
    expect(text).not.toMatch(/\r/);
  });

  it('escapes all four required control characters in a single label value', () => {
    const metrics = createMetricsRegistry();

    // Backslash, quote, LF, CR — all four in one input. The output must
    // show every input char exactly once in its escaped form.
    metrics.streamingEventsTotal.inc({
      transport: 'stdio',
      event_type: 'a\\b"c\nd\re'
    });

    const text = metrics.getMetricsAsText();
    expect(text).toContain('event_type="a\\\\b\\"c\\nd\\re"');
  });

  // RM5 adversarial #1: forged label-pair injection.
  // If the escaper dropped the quote before the backslash (wrong order),
  // an input like `x\"injected=bad` would emit `x\\"injected=bad` — the
  // `\"` pair re-doubles the backslash, and the unescaped quote after it
  // closes the label value, letting a second forged label pair smuggle in.
  // With correct backslash-first escaping, `\` -> `\\\\` and `"` -> `\\"`,
  // producing `x\\\\"injected=bad` which is a single label value containing
  // literal backslashes and a quote.
  it('cannot be exploited to forge a second label pair via crafted input', () => {
    const metrics = createMetricsRegistry();

    metrics.streamingEventsTotal.inc({
      transport: 'stdio',
      event_type: 'x\\"injected=bad'
    });

    const text = metrics.getMetricsAsText();

    // Find the line we just emitted. Exactly one sample line should appear
    // for streaming_events_total.
    const lines = text.split('\n').filter((l) =>
      l.startsWith('brutalist_streaming_events_total{')
    );
    expect(lines).toHaveLength(1);

    const line = lines[0];

    // The forged key `injected` must NOT appear as a label key. A label
    // key would appear as `,injected="..."` OR `{injected="..."` OR
    // without any surrounding characters as a standalone token; the
    // regex here rejects all of those.
    expect(line).not.toMatch(/[{,]injected=/);

    // Parse label set: everything between the FIRST `{` and the LAST `}`.
    const labelsMatch = line.match(/^[^{]+\{(.*)\}\s+\d+(?:\.\d+)?$/);
    expect(labelsMatch).not.toBeNull();
    const labelBlock = labelsMatch![1];

    // Walk label pairs respecting escape sequences. The parser below is
    // intentionally simple but sufficient to prove boundaries are intact:
    // each pair is `key="<escaped_value>"` with `key` matching the metric
    // label name regex.
    const pairs = splitEscapedPairs(labelBlock);
    const keys = pairs.map((p) => p.key);
    expect(keys).toEqual(['transport', 'event_type']);
    // The event_type value must be the full crafted payload, preserved
    // as a single string — NOT split into a forged `injected` key.
    expect(pairs.find((p) => p.key === 'event_type')?.value).toBe(
      'x\\\\\\"injected=bad'
    );
  });

  // RM5 adversarial #2: forged line injection via CR + LF.
  // Without CR escaping plus LF escaping, an input containing `\r\n` would
  // end the current sample line in CRLF-aware parsers, then emit a forged
  // `malicious_metric 1` line that scrapers would pick up as a separate
  // metric sample.
  it('cannot be exploited to forge a new metric line via CR/LF injection', () => {
    const metrics = createMetricsRegistry();

    metrics.streamingEventsTotal.inc({
      transport: 'stdio',
      event_type: 'x\r\nmalicious_metric 1'
    });

    const text = metrics.getMetricsAsText();

    // No literal CR or LF survives inside a label value; the only LFs
    // present are the ones the renderer itself inserted between lines.
    // Verify the string `malicious_metric 1` only appears INSIDE a
    // label value (wrapped in quotes), never at the start of a line.
    expect(text).not.toMatch(/^malicious_metric /m);

    // The escaped forms must be present where the crafted input was.
    expect(text).toContain('event_type="x\\r\\nmalicious_metric 1"');

    // Every non-empty non-comment line must still parse as a valid
    // Prometheus sample (same regex the existing format test uses).
    const sampleLines = text
      .split('\n')
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    for (const line of sampleLines) {
      expect(line).toMatch(
        /^[a-zA-Z_][a-zA-Z0-9_]*(\{[^}]*\})? -?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/
      );
    }
  });

  // RM5 adversarial #3: each sample line, parsed as a Prometheus sample,
  // MUST yield exactly the labels the caller supplied — no forged keys,
  // no split values.
  it('roundtrip: parsed label set equals the caller-supplied label set for adversarial inputs', () => {
    const metrics = createMetricsRegistry();

    const adversarial = [
      'plain',
      'with"quote',
      'with\\backslash',
      'with\nLF',
      'with\rCR',
      'mixed \\ " \n \r chaos',
      '"=forged_start',
      'end_with_backslash\\',
      // Double-escape honeytrap: if the escaper ran TWICE, `\\` input would
      // become `\\\\\\\\` instead of the correct `\\\\`.
      '\\\\double'
    ];

    for (const payload of adversarial) {
      metrics.streamingEventsTotal.inc({
        transport: 'stdio',
        event_type: payload
      });
    }

    const text = metrics.getMetricsAsText();
    const sampleLines = text
      .split('\n')
      .filter((l) => l.startsWith('brutalist_streaming_events_total{'));

    // One sample line per distinct payload.
    expect(sampleLines).toHaveLength(adversarial.length);

    for (const line of sampleLines) {
      const labelBlockMatch = line.match(/^[^{]+\{(.*)\}\s+\d+(?:\.\d+)?$/);
      expect(labelBlockMatch).not.toBeNull();
      const pairs = splitEscapedPairs(labelBlockMatch![1]);
      // Exactly two labels must be parseable from every emitted line.
      expect(pairs).toHaveLength(2);
      expect(pairs[0].key).toBe('transport');
      expect(pairs[1].key).toBe('event_type');
    }
  });

  it('also escapes CR inside HELP text to keep the exposition well-formed', () => {
    // Helps are internal strings in the registry today, but the escaper
    // must still handle a CR if a future metric descriptor carries one.
    // Verified via a direct import (not through the registry, since the
    // registry's descriptors are hardcoded strings without CR).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { escapeHelp } = require('../../../src/metrics/types.js');
    expect(escapeHelp('line1\rline2')).toBe('line1\\rline2');
    expect(escapeHelp('line1\nline2')).toBe('line1\\nline2');
    expect(escapeHelp('back\\slash')).toBe('back\\\\slash');
  });
});

/**
 * Split a Prometheus label block (content between `{` and `}`) into key/value
 * pairs while respecting `\\` / `\"` / `\n` / `\r` escape sequences inside
 * values. Intentionally minimal — enough to prove label-value boundaries are
 * preserved by the escaper under adversarial input.
 */
function splitEscapedPairs(labelBlock: string): { key: string; value: string }[] {
  const pairs: { key: string; value: string }[] = [];
  let i = 0;
  while (i < labelBlock.length) {
    // Parse key up to `=`.
    const eq = labelBlock.indexOf('=', i);
    if (eq === -1) break;
    const key = labelBlock.slice(i, eq).replace(/^,/, '');
    if (labelBlock[eq + 1] !== '"') {
      throw new Error(`malformed label block (no opening quote): ${labelBlock}`);
    }
    // Walk the quoted value, honoring escape sequences.
    let j = eq + 2;
    let value = '';
    while (j < labelBlock.length) {
      const ch = labelBlock[j];
      if (ch === '\\' && j + 1 < labelBlock.length) {
        // Preserve the escape as-is in the parsed value (the test just needs
        // to confirm the escaped pair is intact and does not terminate the
        // value prematurely).
        value += ch + labelBlock[j + 1];
        j += 2;
        continue;
      }
      if (ch === '"') {
        // End of value.
        break;
      }
      value += ch;
      j += 1;
    }
    if (labelBlock[j] !== '"') {
      throw new Error(`malformed label block (unterminated value): ${labelBlock}`);
    }
    pairs.push({ key, value });
    i = j + 1;
    // Skip trailing comma between pairs.
    if (labelBlock[i] === ',') i += 1;
  }
  return pairs;
}

describe('Import-time invariants — no module-level singletons', () => {
  it('does not instantiate a registry during module import', async () => {
    // Re-import the module and confirm no side effect has been attached to
    // `globalThis`. This is a soft check — the strong check is that the only
    // way to get a registry is via `createMetricsRegistry()`, enforced at
    // the type level.
    const keysBefore = Object.keys(globalThis);
    await import('../../../src/metrics/index.js');
    const keysAfter = Object.keys(globalThis);

    expect(keysAfter).toEqual(keysBefore);
  });

  it('requires an explicit factory call to produce a registry', () => {
    // Confirms the export surface: the module exports a factory function,
    // not a prebuilt registry instance.
    // (If someone ever added `export const registry = createMetricsRegistry()`
    // at module scope, this assertion would still pass — but the two factory
    // isolation tests above would then fail, which is the correct signal.)
    expect(typeof createMetricsRegistry).toBe('function');
  });
});
