/**
 * Debate Synthesis — formats debate results into markdown output.
 *
 * Generates structured output including:
 *   - Topic, positions, and round count
 *   - Key points of conflict (extracted via keyword indicators)
 *   - Full debate transcript grouped by round
 *   - Alignment asymmetry analysis (when detected)
 *   - Escalation outcome summary
 *   - Closing synthesis section
 *
 * Extracted from brutalist-server.ts lines 1353-1471.
 */
import type { CLIAgentResponse, DebateBehaviorSummary } from '../types/brutalist.js';
/**
 * Synthesize debate results into formatted markdown output.
 *
 * This function is a direct extraction of BrutalistServer.synthesizeDebate().
 * It preserves all formatting quirks captured by characterization tests.
 */
export declare function synthesizeDebate(responses: CLIAgentResponse[], topic: string, rounds: number, agentPositions?: Map<string, string>, behaviorSummary?: DebateBehaviorSummary): string;
//# sourceMappingURL=synthesis.d.ts.map