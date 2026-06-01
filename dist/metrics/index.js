/**
 * Metrics module — barrel export.
 *
 * This is a TOOL, not wiring: nothing under `src/metrics/` imports from the
 * debate, CLI-adapter, streaming, or logger modules. Call sites depend on
 * this module; this module depends on nothing inside the project.
 *
 * Usage (composition root):
 *
 *   import { createMetricsRegistry } from './metrics/index.js';
 *   const metrics = createMetricsRegistry();
 *   // ... pass `metrics` into DebateOrchestratorDeps, CLIAgentOrchestrator, etc.
 *
 * Usage (test):
 *
 *   const metrics = createMetricsRegistry();
 *   metrics.cliSpawnTotal.inc({ provider: 'claude', outcome: 'success' });
 *   expect(metrics.getMetricsAsText()).toContain('brutalist_cli_spawn_total');
 */
export { createMetricsRegistry, PROMETHEUS_CONTENT_TYPE, DEBATE_DURATION_LABELS, DEBATE_DURATION_BUCKETS, ESCALATION_TIER_LABELS, CLI_SPAWN_LABELS, STREAMING_EVENT_LABELS } from './registry.js';
export { safeMetric } from './safe-metric.js';
//# sourceMappingURL=index.js.map