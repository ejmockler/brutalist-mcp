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
export declare function safeMetric(log: StructuredLogger, op: string, fn: () => void): void;
//# sourceMappingURL=safe-metric.d.ts.map