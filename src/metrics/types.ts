/**
 * Shared type primitives for the metrics module.
 *
 * `LabelValues` intentionally constrains label names at the type level: each
 * metric declares a tuple of its label keys and consumers must supply every
 * key — this catches missing-label bugs at compile time rather than exposing
 * an untyped `Record<string, string>` to callers.
 */

/** Cardinality-safe label value map. Values are stringified before emission. */
export type LabelValues<TLabels extends readonly string[]> = {
  [K in TLabels[number]]: string | number;
};

/** Common metadata carried by every declared metric. */
export interface MetricDescriptor<TLabels extends readonly string[]> {
  /** Fully-qualified Prometheus metric name (e.g. `brutalist_debate_...`). */
  readonly name: string;
  /** One-line HELP text emitted in the exposition. */
  readonly help: string;
  /** The ordered label key tuple. */
  readonly labelNames: TLabels;
}

/**
 * The internal storage shape shared by Counter and Histogram.
 * A metric keeps a map from `labelKey` (stable, deterministic serialization
 * of its label values) to per-label-set state.
 */
export type LabelKey = string;

/**
 * Build a stable, deterministic label key from a label-value map.
 *
 * Labels are emitted in the order declared in `labelNames` so two equivalent
 * maps always produce the same key regardless of call-site iteration order.
 *
 * Values are coerced to strings and newline/quote-escaped for safe embedding
 * in the exposition text format.
 */
export function serializeLabels<TLabels extends readonly string[]>(
  labelNames: TLabels,
  values: LabelValues<TLabels>
): LabelKey {
  if (labelNames.length === 0) {
    return '';
  }
  const parts: string[] = [];
  for (const key of labelNames) {
    const raw = (values as Record<string, string | number>)[key];
    if (raw === undefined) {
      throw new Error(
        `metrics: missing label "${key}" for metric (expected keys: ${labelNames.join(', ')})`
      );
    }
    parts.push(`${key}="${escapeLabelValue(String(raw))}"`);
  }
  return parts.join(',');
}

/**
 * Escape a label value for the Prometheus text format 0.0.4 exposition.
 *
 * The spec only mandates escaping of three characters inside a label value:
 *   \\ -> \\\\    (backslash — must come FIRST so later-emitted escape
 *                  sequences that include a literal `\` do not get their
 *                  backslash doubled on a second pass. The single-pass
 *                  character-walker below makes the order moot in practice
 *                  because each input char is transformed exactly once,
 *                  but we keep the documented ordering for clarity and
 *                  parity with any future two-pass rewrite.)
 *   "  -> \\"    (double quote — else the label value terminator is
 *                  ambiguous and a crafted input can forge a label pair.)
 *   \n -> \\n    (LF — else a newline injects a fake metric line.)
 *
 * We ALSO escape CR (`\r`) even though the 0.0.4 spec does not strictly
 * require it: without CR escaping an input like `x\r\nmalicious_metric 1`
 * ends the current line in any CRLF-aware parser (HTTP scrapers, browser
 * views, log viewers) and forges a downstream metric line. The future
 * integrate_observability phase may add HTTP exposition; escaping CR now
 * removes a whole class of injection vectors before anyone exposes the
 * exposition to untrusted network paths.
 *
 * Other control characters (C0 range 0x00-0x1F, DEL 0x7F, NUL) are passed
 * through as-is. Rationale: (a) none of them can terminate a label value
 * or inject a line break in the 0.0.4 grammar; (b) metric callers in this
 * codebase build label values from closed sets (`claude`/`codex`/`gemini`,
 * `success`/`failure`, etc.) so there is no realistic path for a NUL or
 * bell character to reach this function; (c) stripping/rejecting them is
 * policy, not encoding correctness — the integrate_observability phase can
 * add a reject/sanitize layer at the call site if that policy is needed.
 */
export function escapeLabelValue(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 0x5c) {
      // backslash — MUST precede quote/LF/CR so the documented order
      // (backslash first, quote, LF, CR) is honored.
      out += '\\\\';
    } else if (ch === 0x22) {
      // double quote
      out += '\\"';
    } else if (ch === 0x0a) {
      // LF
      out += '\\n';
    } else if (ch === 0x0d) {
      // CR — not mandated by 0.0.4 but required for defense-in-depth
      // against CRLF injection into HTTP/scraper/log tooling.
      out += '\\r';
    } else {
      out += value[i];
    }
  }
  return out;
}

/**
 * Escape a HELP text per the Prometheus text format 0.0.4 spec:
 *   \\ -> \\\\
 *   \n -> \\n
 * (quote escaping is NOT required in HELP lines, only in label values.)
 *
 * CR is also escaped — same rationale as `escapeLabelValue`: downstream
 * HTTP/browser tooling is CRLF-aware and an unescaped CR would forge
 * subsequent lines in the exposition output.
 */
export function escapeHelp(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (ch === 0x5c) {
      out += '\\\\';
    } else if (ch === 0x0a) {
      out += '\\n';
    } else if (ch === 0x0d) {
      out += '\\r';
    } else {
      out += value[i];
    }
  }
  return out;
}
