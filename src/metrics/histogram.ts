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
import { escapeHelp, escapeLabelValue, serializeLabels, type LabelKey } from './types.js';

export interface HistogramDescriptor<TLabels extends readonly string[]>
  extends MetricDescriptor<TLabels> {
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

interface HistogramState<TLabels extends readonly string[]> {
  readonly labels: LabelValues<TLabels>;
  readonly counts: number[]; // length = buckets.length + 1 (final is +Inf)
  sum: number;
  count: number;
}

export function createHistogram<TLabels extends readonly string[]>(
  descriptor: HistogramDescriptor<TLabels>
): Histogram<TLabels> {
  validateBuckets(descriptor);

  const state = new Map<LabelKey, HistogramState<TLabels>>();

  return {
    descriptor,
    observe(labels: LabelValues<TLabels>, value: number): void {
      if (!Number.isFinite(value)) {
        throw new Error(
          `metrics: histogram "${descriptor.name}" observation must be finite (got ${value})`
        );
      }
      // Symmetric with `Counter.inc()`: negative inputs are rejected by
      // throwing. The registry's duration histogram measures wall-clock
      // time, which is semantically non-negative; a bad delta (e.g.,
      // `Date.now() - futureTimestamp`) would otherwise contaminate every
      // finite bucket AND negatively shift `_sum`, silently breaking any
      // downstream quantile or SLO computation.
      if (value < 0) {
        throw new Error(
          `metrics: histogram "${descriptor.name}" observation must be >= 0 (got ${value})`
        );
      }
      const key = serializeLabels(descriptor.labelNames, labels);
      let entry = state.get(key);
      if (!entry) {
        entry = {
          labels,
          counts: new Array(descriptor.buckets.length + 1).fill(0),
          sum: 0,
          count: 0
        };
        state.set(key, entry);
      }
      // Cumulative: increment every bucket whose upper bound >= value.
      for (let i = 0; i < descriptor.buckets.length; i++) {
        if (value <= descriptor.buckets[i]) {
          entry.counts[i] += 1;
        }
      }
      // +Inf bucket always increments.
      entry.counts[entry.counts.length - 1] += 1;
      entry.sum += value;
      entry.count += 1;
    },
    snapshot(): ReadonlyMap<LabelKey, HistogramSnapshot> {
      const out = new Map<LabelKey, HistogramSnapshot>();
      for (const [key, entry] of state.entries()) {
        out.set(key, {
          cumulative: entry.counts.slice(),
          sum: entry.sum,
          count: entry.count
        });
      }
      return out;
    },
    render(): string {
      const lines: string[] = [];
      lines.push(`# HELP ${descriptor.name} ${escapeHelp(descriptor.help)}`);
      lines.push(`# TYPE ${descriptor.name} histogram`);
      if (state.size === 0) {
        return lines.join('\n');
      }

      const keys = Array.from(state.keys()).sort();
      for (const key of keys) {
        const entry = state.get(key)!;
        const labelPrefix = renderLabelPrefix(key, descriptor.labelNames);

        for (let i = 0; i < descriptor.buckets.length; i++) {
          const bucket = descriptor.buckets[i];
          lines.push(
            `${descriptor.name}_bucket{${labelPrefix}le="${escapeLabelValue(String(bucket))}"} ${entry.counts[i]}`
          );
        }
        // +Inf bucket — total count.
        lines.push(
          `${descriptor.name}_bucket{${labelPrefix}le="+Inf"} ${entry.counts[entry.counts.length - 1]}`
        );
        lines.push(
          `${descriptor.name}_sum${key === '' ? '' : `{${key}}`} ${formatNumber(entry.sum)}`
        );
        lines.push(
          `${descriptor.name}_count${key === '' ? '' : `{${key}}`} ${entry.count}`
        );
      }
      return lines.join('\n');
    }
  };
}

function renderLabelPrefix<TLabels extends readonly string[]>(
  key: LabelKey,
  _labelNames: TLabels
): string {
  // `le` is always the final label in bucket lines; put the existing labels first.
  return key === '' ? '' : `${key},`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return value.toString();
  }
  return value.toString();
}

function validateBuckets<TLabels extends readonly string[]>(
  descriptor: HistogramDescriptor<TLabels>
): void {
  if (descriptor.buckets.length === 0) {
    throw new Error(`metrics: histogram "${descriptor.name}" must have at least one bucket`);
  }
  for (let i = 0; i < descriptor.buckets.length; i++) {
    const b = descriptor.buckets[i];
    if (!Number.isFinite(b)) {
      throw new Error(
        `metrics: histogram "${descriptor.name}" bucket ${i} is not finite (${b})`
      );
    }
    if (i > 0 && b <= descriptor.buckets[i - 1]) {
      throw new Error(
        `metrics: histogram "${descriptor.name}" buckets must be strictly ascending ` +
          `(bucket ${i} = ${b} <= bucket ${i - 1} = ${descriptor.buckets[i - 1]})`
      );
    }
  }
}
