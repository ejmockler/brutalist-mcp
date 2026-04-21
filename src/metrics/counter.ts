/**
 * Counter — a monotonically increasing cumulative metric.
 *
 * Counters are the simplest Prometheus primitive: a numeric value that only
 * goes up. Each distinct label-value combination gets its own independent
 * value so labeled increments never collide.
 */

import type { LabelValues, MetricDescriptor } from './types.js';
import { escapeHelp, serializeLabels, type LabelKey } from './types.js';

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

export function createCounter<TLabels extends readonly string[]>(
  descriptor: MetricDescriptor<TLabels>
): Counter<TLabels> {
  const values = new Map<LabelKey, number>();
  const labelSets = new Map<LabelKey, LabelValues<TLabels>>();

  return {
    descriptor,
    inc(labels: LabelValues<TLabels>, delta: number = 1): void {
      if (!Number.isFinite(delta)) {
        throw new Error(`metrics: counter "${descriptor.name}" delta must be finite`);
      }
      if (delta < 0) {
        throw new Error(`metrics: counter "${descriptor.name}" delta must be >= 0`);
      }
      const key = serializeLabels(descriptor.labelNames, labels);
      values.set(key, (values.get(key) ?? 0) + delta);
      if (!labelSets.has(key)) {
        // Preserve the first-seen label map for rendering (values stringified).
        labelSets.set(key, labels);
      }
    },
    snapshot(): ReadonlyMap<LabelKey, number> {
      return new Map(values);
    },
    render(): string {
      const lines: string[] = [];
      lines.push(`# HELP ${descriptor.name} ${escapeHelp(descriptor.help)}`);
      lines.push(`# TYPE ${descriptor.name} counter`);
      if (values.size === 0) {
        return lines.join('\n');
      }
      // Sort for deterministic output — test assertions rely on this.
      const keys = Array.from(values.keys()).sort();
      for (const key of keys) {
        const value = values.get(key)!;
        if (key === '') {
          lines.push(`${descriptor.name} ${formatNumber(value)}`);
        } else {
          lines.push(`${descriptor.name}{${key}} ${formatNumber(value)}`);
        }
      }
      return lines.join('\n');
    }
  };
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return value.toString();
  }
  // Prometheus accepts Go-style float literals; JS number.toString() is compatible.
  return value.toString();
}
