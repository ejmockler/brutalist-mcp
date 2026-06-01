/**
 * Constitutional Position Anchoring — 3-tier escalation system.
 *
 * Three tiers of position anchoring aligned with the system prompt's
 * analytical register:
 *   - 'standard'   — agency framing + position lock + expertise framing
 *   - 'escalated'  — adds epistemic obligation
 *   - 'decomposed' — pure expertise synthesis, no adversarial vocabulary
 *
 * Design principle: the standard tier is the first-class anchor. Pattern-based
 * refusal detection + escalation is the safety net, not the primary mechanism.
 * The standard-tier prompt internalizes agency ("you have chosen", "your
 * expertise obligates engagement") rather than externalizing constraints
 * alone, so the agent recognizes its professional role before the regex
 * fallback ever fires. The numbered ANALYTICAL CONSTRAINTS block is preserved
 * verbatim as an invariant under characterization tests.
 */
export type DebateTier = 'standard' | 'escalated' | 'decomposed';
/**
 * Generate a constitutional position anchor for a debate agent.
 *
 * The anchor frames the agent's role and thesis for a given escalation tier.
 * Each tier uses progressively less adversarial vocabulary to recover agents
 * that refuse at lower tiers.
 */
export declare function constitutionalAnchor(agent: string, position: string, thesis: string, tier?: DebateTier): string;
//# sourceMappingURL=constitutional.d.ts.map