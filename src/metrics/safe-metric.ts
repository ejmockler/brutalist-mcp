/**
 * safeMetric — isolate metric writes from business control flow.
 *
 * Metric emissions are side effects that MUST NOT propagate exceptions
 * into the surrounding business logic. If a metric throw escaped into
 * an outer try/catch (e.g., the per-turn try/catch in
 * DebateOrchestrator.executeCLIDebate or the spawn try/catch in
 * CLIAgentOrchestrator._executeCLI), the business layer would treat
 * the metric failure as an operational failure — double-counting,
 * double-pushing metadata, potentially re-emitting streaming events.
 *
 * This helper wraps each metric call in a local try/catch that swallows
 * the exception and emits a warn-level log bound to
 * `operation='metrics'`. The hot-path no-I/O invariant is preserved:
 * `.warn` only fires on the rare exception path (contract-violating
 * label input or registry misconfiguration), and no synchronous I/O is
 * added on the happy path.
 *
 * This module is a TOOL — it imports only the logger type and has no
 * other project dependencies. Call sites (debate, cli spawn) own the
 * operation label.
 */

import type { StructuredLogger } from '../logger.js';

export function safeMetric(
  log: StructuredLogger,
  op: string,
  fn: () => void,
): void {
  try {
    fn();
  } catch (err) {
    // Security (Cycle 3 F36): the MetricsRegistry (Counter/Histogram)
    // only throws synthetic label-validation errors with static strings
    // today, but defense-in-depth says a future caller that passes
    // user-controlled label values must not leak through this sink.
    // Emit class-name only (err.name) — no payload. Do NOT add a
    // nested try/catch around this warn call; F27/F28/F29 (logger-
    // throw propagation) is suppressed by the convergence gate
    // (see decisions.md Cycle 2 ASSESS).
    log.forOperation('metrics').warn(`metric ${op} failed`, {
      err: err instanceof Error ? (err.name ?? 'Error') : '<non-Error-thrown>',
    });
  }
}
