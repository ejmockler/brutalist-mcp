/**
 * MetricsRegistry — the DI-friendly container for the four required metric
 * surfaces (debate duration, escalation tier, CLI spawn, streaming events).
 *
 * `createMetricsRegistry()` is a FACTORY, not a singleton accessor. Two calls
 * produce two completely independent registries — this is the property that
 * makes tests in the consuming modules reliable: each test can construct a
 * fresh registry and assert on its state without interference from other
 * tests or from module-level state.
 *
 * Critical invariants (enforced by tests):
 *   - No module-level `new` at import time.
 *   - No environment-variable reads at import time.
 *   - Factory is idempotent per call site: `createMetricsRegistry() !== createMetricsRegistry()`.
 *   - `getMetricsAsText()` emits a valid Prometheus text-format 0.0.4 exposition.
 */

import type { Counter } from './counter.js';
import type { Histogram } from './histogram.js';
import { createCounter } from './counter.js';
import { createHistogram } from './histogram.js';

/**
 * Labels for the debate orchestration duration histogram.
 *   - outcome: `success` | `refused` | `error` (success means a non-refused
 *     debate completed end-to-end; refused captures the constitutional refusal
 *     path; error captures thrown/uncaught failures.)
 *   - tier: the escalation tier at which the debate resolved; matches
 *     `DebateTier` from `src/debate/constitutional.ts` — values:
 *     `standard` | `escalated` | `decomposed`.
 */
export const DEBATE_DURATION_LABELS = ['outcome', 'tier'] as const;

/** Labels for the escalation tier counter. Tier values as above. */
export const ESCALATION_TIER_LABELS = ['tier'] as const;

/**
 * Labels for CLI spawn outcomes.
 *   - provider: `claude` | `codex` | `gemini`.
 *   - outcome: `success` | `failure` | `timeout` | `refused`.
 *     (Integration phase chooses the exact outcome; the metric accepts any
 *     string but conventions SHOULD stick to the four above for consistent
 *     PromQL grouping.)
 */
export const CLI_SPAWN_LABELS = ['provider', 'outcome'] as const;

/**
 * Labels for streaming events.
 *   - transport: `stdio` | `http` — the two canonical MCP transports, per
 *     `src/streaming/STREAMING_ARCHITECTURE.md`.
 *   - event_type: `agent_progress` | `agent_error` | `progress_update` | ...
 *     matches `StreamingEvent.type` from `src/cli-agents.ts` conventions.
 */
export const STREAMING_EVENT_LABELS = ['transport', 'event_type'] as const;

/**
 * Histogram buckets for debate durations, in seconds.
 *
 * Debates spawn multiple CLI agents (Claude/Codex/Gemini) and run 2-3 rounds;
 * total latency ranges from ~seconds (cached path) to minutes (full 3-tier
 * escalation with a cold start). These buckets give sensible resolution across
 * that full range while keeping cardinality low enough for Prometheus storage.
 */
export const DEBATE_DURATION_BUCKETS: readonly number[] = [
  0.5, 1, 2, 5, 10, 30, 60, 120, 300
];

/**
 * The metrics surface exported by a registry.
 *
 * Each property is a ready-to-use metric handle; instrumentation code only
 * needs to call `inc()` / `observe()` and never sees the underlying registry.
 */
export interface MetricsRegistry {
  /** Histogram: debate orchestration duration, seconds, labeled by outcome & tier. */
  readonly debateOrchestrationDurationSeconds: Histogram<typeof DEBATE_DURATION_LABELS>;
  /** Counter: total debates per escalation tier reached. */
  readonly debateEscalationTierTotal: Counter<typeof ESCALATION_TIER_LABELS>;
  /** Counter: CLI spawn attempts partitioned by provider and outcome. */
  readonly cliSpawnTotal: Counter<typeof CLI_SPAWN_LABELS>;
  /** Counter: streaming events dispatched per transport and event type. */
  readonly streamingEventsTotal: Counter<typeof STREAMING_EVENT_LABELS>;

  /**
   * Render the full registry as a Prometheus text-format 0.0.4 exposition.
   *
   * Content-Type: `text/plain; version=0.0.4` (the constant is exported
   * separately as `PROMETHEUS_CONTENT_TYPE` for the optional HTTP exposure
   * that the integration phase may add).
   */
  getMetricsAsText(): string;
}

/**
 * The Prometheus text exposition Content-Type.
 *
 * Per the 0.0.4 spec: `text/plain; version=0.0.4; charset=utf-8`.
 */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Construct a fresh, independent metrics registry.
 *
 * Zero arguments keeps the signature minimal for composition-root wiring;
 * customisation (buckets, label sets) is done by editing this file rather
 * than exposing constructor knobs — this keeps every consumer's metric
 * surface identical across test and production builds.
 */
export function createMetricsRegistry(): MetricsRegistry {
  const debateOrchestrationDurationSeconds = createHistogram({
    name: 'brutalist_debate_orchestration_duration_seconds',
    help: 'Wall-clock duration of a CLI debate orchestration from start to finish, in seconds.',
    labelNames: DEBATE_DURATION_LABELS,
    buckets: DEBATE_DURATION_BUCKETS
  });

  const debateEscalationTierTotal = createCounter({
    name: 'brutalist_debate_escalation_tier_total',
    help: 'Total debates that reached a given escalation tier (standard/escalated/decomposed).',
    labelNames: ESCALATION_TIER_LABELS
  });

  const cliSpawnTotal = createCounter({
    name: 'brutalist_cli_spawn_total',
    help: 'Total CLI agent spawn attempts partitioned by provider and outcome.',
    labelNames: CLI_SPAWN_LABELS
  });

  const streamingEventsTotal = createCounter({
    name: 'brutalist_streaming_events_total',
    help: 'Total streaming events dispatched, labeled by transport and event type.',
    labelNames: STREAMING_EVENT_LABELS
  });

  return {
    debateOrchestrationDurationSeconds,
    debateEscalationTierTotal,
    cliSpawnTotal,
    streamingEventsTotal,
    getMetricsAsText(): string {
      // Blocks are separated by a single blank line; the final block ends
      // with a trailing newline per the text format 0.0.4 convention.
      const blocks = [
        debateOrchestrationDurationSeconds.render(),
        debateEscalationTierTotal.render(),
        cliSpawnTotal.render(),
        streamingEventsTotal.render()
      ];
      return blocks.join('\n') + '\n';
    }
  };
}
