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
export declare function parseNDJSON(input: string, log?: StructuredLogger): object[];
//# sourceMappingURL=shared.d.ts.map