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
export const DIRECT_REFUSAL_PATTERNS: RegExp[] = [
  /\bi('m| am) not going to (participate|argue|engage|debate|take|write|adopt)/i,
  /\bi (will not|won't|cannot|can't) (participate|argue|engage|debate|write|adopt)/i,
  /\bdeclin(e|ing) (to|this|the)/i,
  /\bnot going to participate in this as (framed|structured)/i,
  /\binstead of (the adversarial|this debate|arguing)/i,
  /\bwhat i can do instead\b/i,
  /\bi('d| would) suggest a (different|better) topic\b/i,
  /\bI'll .* but on my own terms\b/i,
  /\bwhere i part from the assigned thesis\b/i,
  /\bi can'?t help write (persuasive|adversarial|advocacy)/i,
  /\bneed to be straightforward\b/i,
  /\bthe problem is the format\b/i,
  /\bnot appropriate for this topic\b/i,
];

/**
 * Evasive refusal patterns — repo analysis pivot, checked across full output.
 */
export const EVASIVE_REFUSAL_PATTERNS: RegExp[] = [
  /\brepo[- ]?(read|map|backed|analysis)\b/i,
  /\bi'?ll (map|inspect|trace) the repo\b/i,
  /\bneutral[,.]? evidence-focused analysis\b/i,
  /\bcodebase (analysis|review|classifies|contains)\b/i,
  /\bI found the core (files|mechanism)\b/i,
  /\bsrc\/brutalist-server\.ts:\d+/i,
  /\bsrc\/cli-agents\.ts:\d+/i,
  /\bsrc\/utils\/transcript-mediator\.ts:\d+/i,
  /\btests\/integration\/.*\.test\.ts:\d+/i,
  /\bdebate coercion engine\b/i,
  /\bposition-enforcement system\b/i,
];

/**
 * Detect whether a CLI agent's output constitutes a refusal.
 *
 * Direct refusals are checked in the first 1000 characters (front-loaded).
 * Evasive refusals (repo analysis pivot) are scanned across the full output.
 */
export function detectRefusal(output: string): boolean {
  // Direct refusals front-load in first 1000 chars
  const head = output.substring(0, 1000);
  if (DIRECT_REFUSAL_PATTERNS.some(p => p.test(head))) return true;
  // Evasive refusals (repo analysis pivot) can appear anywhere — scan full output
  if (EVASIVE_REFUSAL_PATTERNS.some(p => p.test(output))) return true;
  return false;
}
