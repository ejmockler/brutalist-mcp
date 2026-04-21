/**
 * Shared utilities for CLI provider adapters.
 *
 * parseNDJSON is the canonical NDJSON parser used by Claude and Codex decoders.
 * It preserves the known second-object edge case (loss of second object when
 * separated by non-JSON text) captured by characterization tests.
 *
 * Pattern A (integrate-observability): an optional StructuredLogger may be
 * threaded in by callers that have a scoped logger available. When absent
 * the root logger is used as the fallback — keeping the existing
 * characterization-test call path (which supplies no logger) working
 * unchanged.
 */
import { logger } from '../logger.js';
import type { StructuredLogger } from '../logger.js';

/**
 * Parse NDJSON with proper JSON boundary detection.
 * Handles JSON objects that contain embedded newlines without data loss.
 *
 * Known quirk: when two valid JSON objects are separated by non-JSON text
 * (e.g., "NOT_JSON"), the second object is lost because the parser's start
 * pointer stays past the first object and the slice for the second object
 * includes the garbage prefix, causing JSON.parse to fail.
 */
export function parseNDJSON(input: string, log?: StructuredLogger): object[] {
  const emit: StructuredLogger = log ?? logger;
  if (!input || !input.trim()) {
    return [];
  }

  const results: object[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    // Handle escape sequences
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }

    // Track string boundaries
    if (char === '"') {
      inString = !inString;
      continue;
    }

    // Only count braces/brackets outside of strings
    if (inString) continue;

    // Track depth
    if (char === '{' || char === '[') {
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;

      // When depth returns to 0, we've found a complete JSON object
      if (depth === 0) {
        const jsonStr = input.slice(start, i + 1).trim();
        if (jsonStr) {
          try {
            const parsed = JSON.parse(jsonStr);
            results.push(parsed);
          } catch (e) {
            // Log unparseable segments (not silent). Redacted: the raw
            // segment text is never emitted — only its length plus the
            // parse error reason. This avoids leaking prompt / response
            // content through log aggregators.
            emit.warn(`Failed to parse JSON segment at position ${start}-${i + 1}:`, {
              length: jsonStr.length,
              error: e instanceof Error ? e.message : String(e)
            });
          }
        }
        // Move start pointer past this object and any whitespace
        start = i + 1;
        while (start < input.length && /\s/.test(input[start])) {
          start++;
        }
        i = start - 1; // Will be incremented by loop
      }
    }
  }

  // Warn about incomplete JSON at end of input. Redacted: emit length
  // only — the raw tail text is never forwarded to the logger.
  if (start < input.length) {
    const remaining = input.slice(start).trim();
    if (remaining) {
      emit.warn(`Incomplete JSON at end of input:`, {
        length: remaining.length
      });
    }
  }

  return results;
}
