/**
 * Refusal Detection — identifies when a debate agent breaks debate framing.
 *
 * Two classes:
 *   - 13 direct refusal patterns (checked in first 1000 chars of output)
 *   - 11 evasive refusal patterns (checked across full output)
 *
 * Extracted from brutalist-server.ts lines 943-981.
 */
/**
 * Direct refusal patterns — front-loaded in first 1000 chars.
 * IMPORTANT: There are exactly 13 patterns. Do not add or remove patterns
 * without updating characterization tests.
 */
export declare const DIRECT_REFUSAL_PATTERNS: RegExp[];
/**
 * Evasive refusal patterns — repo analysis pivot, checked across full output.
 */
export declare const EVASIVE_REFUSAL_PATTERNS: RegExp[];
/**
 * Detect whether a CLI agent's output constitutes a refusal.
 *
 * Direct refusals are checked in the first 1000 characters (front-loaded).
 * Evasive refusals (repo analysis pivot) are scanned across the full output.
 */
export declare function detectRefusal(output: string): boolean;
//# sourceMappingURL=refusal-detection.d.ts.map