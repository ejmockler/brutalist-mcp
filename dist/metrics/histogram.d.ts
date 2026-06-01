/**
 * Histogram — a cumulative histogram of observation values.
 *
 * The Prometheus convention: one `_bucket` series per upper bound plus a
 * mandatory `+Inf` bucket, a `_count` series, and a `_sum` series. Buckets
 * are CUMULATIVE — each bucket includes every lower bucket's observations.
 *
 * Buckets are declared once at construction. Per-label-set state includes:
 *   - counts[i] — cumulative count for the i-th bucket (counts[bucketsAscending.length] = +Inf).
 *   - sum      — cumulative sum of observed values (for quantile approximation).
 *   - count    — total observations (equals counts[+Inf bucket]).
 */
import type { LabelValues, MetricDescriptor } from './types.js';
import { type LabelKey } from './types.js';
export interface HistogramDescriptor<TLabels extends readonly string[]> extends MetricDescriptor<TLabels> {
    /** Upper bounds in strictly ascending order; a `+Inf` bucket is added automatically. */
    readonly buckets: readonly number[];
}
export interface Histogram<TLabels extends readonly string[]> {
    readonly descriptor: HistogramDescriptor<TLabels>;
    /**
     * Record an observation.
     *
     * The value must be a FINITE, NON-NEGATIVE number. Negative values are
     * rejected symmetrically with `Counter.inc()`'s rejection of negative
     * deltas — callers that mis-compute a duration (e.g., `Date.now() -
     * futureTimestamp`) must not silently poison bucket counts or `_sum`
     * (which would break SLO math downstream). Rejection mode: throw.
     */
    observe(labels: LabelValues<TLabels>, value: number): void;
    /** Test-only: cumulative counts per bucket, keyed by serialized label string. */
    snapshot(): ReadonlyMap<LabelKey, HistogramSnapshot>;
    render(): string;
}
export interface HistogramSnapshot {
    /** cumulative[i] = number of observations <= buckets[i]; last entry is +Inf. */
    readonly cumulative: readonly number[];
    readonly sum: number;
    readonly count: number;
}
export declare function createHistogram<TLabels extends readonly string[]>(descriptor: HistogramDescriptor<TLabels>): Histogram<TLabels>;
//# sourceMappingURL=histogram.d.ts.map