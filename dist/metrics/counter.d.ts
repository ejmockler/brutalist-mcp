/**
 * Counter — a monotonically increasing cumulative metric.
 *
 * Counters are the simplest Prometheus primitive: a numeric value that only
 * goes up. Each distinct label-value combination gets its own independent
 * value so labeled increments never collide.
 */
import type { LabelValues, MetricDescriptor } from './types.js';
import { type LabelKey } from './types.js';
/**
 * Opaque handle to a counter metric. Consumers of the module import these
 * via `createMetricsRegistry()` and call `inc()` at instrumentation points.
 */
export interface Counter<TLabels extends readonly string[]> {
    readonly descriptor: MetricDescriptor<TLabels>;
    /** Increment by 1 (default) or by an explicit non-negative delta. */
    inc(labels: LabelValues<TLabels>, delta?: number): void;
    /** Test-only: read current values keyed by serialized label string. */
    snapshot(): ReadonlyMap<LabelKey, number>;
    /** Render this counter as a Prometheus text-exposition block (without trailing newline). */
    render(): string;
}
export declare function createCounter<TLabels extends readonly string[]>(descriptor: MetricDescriptor<TLabels>): Counter<TLabels>;
//# sourceMappingURL=counter.d.ts.map