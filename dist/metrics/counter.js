/**
 * Counter — a monotonically increasing cumulative metric.
 *
 * Counters are the simplest Prometheus primitive: a numeric value that only
 * goes up. Each distinct label-value combination gets its own independent
 * value so labeled increments never collide.
 */
import { escapeHelp, serializeLabels } from './types.js';
export function createCounter(descriptor) {
    const values = new Map();
    const labelSets = new Map();
    return {
        descriptor,
        inc(labels, delta = 1) {
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
        snapshot() {
            return new Map(values);
        },
        render() {
            const lines = [];
            lines.push(`# HELP ${descriptor.name} ${escapeHelp(descriptor.help)}`);
            lines.push(`# TYPE ${descriptor.name} counter`);
            if (values.size === 0) {
                return lines.join('\n');
            }
            // Sort for deterministic output — test assertions rely on this.
            const keys = Array.from(values.keys()).sort();
            for (const key of keys) {
                const value = values.get(key);
                if (key === '') {
                    lines.push(`${descriptor.name} ${formatNumber(value)}`);
                }
                else {
                    lines.push(`${descriptor.name}{${key}} ${formatNumber(value)}`);
                }
            }
            return lines.join('\n');
        }
    };
}
function formatNumber(value) {
    if (Number.isInteger(value)) {
        return value.toString();
    }
    // Prometheus accepts Go-style float literals; JS number.toString() is compatible.
    return value.toString();
}
//# sourceMappingURL=counter.js.map