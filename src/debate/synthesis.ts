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
export function synthesizeDebate(
  responses: CLIAgentResponse[],
  topic: string,
  rounds: number,
  agentPositions?: Map<string, string>,
  behaviorSummary?: DebateBehaviorSummary
): string {
  const successfulResponses = responses.filter(r => r.success);

  if (successfulResponses.length === 0) {
    return `# CLI Debate Failed\n\nEven our brutal critics couldn't engage in proper adversarial combat.\n\nErrors:\n${responses.map(r => `- ${r.agent}: ${r.error}`).join('\n')}`;
  }

  let synthesis = `# Brutalist CLI Agent Debate Results\n\n`;
  synthesis += `**Topic:** ${topic}\n`;
  synthesis += `**Rounds:** ${rounds}\n`;

  if (agentPositions) {
    synthesis += `**Debaters and Positions:**\n`;
    Array.from(agentPositions.entries()).forEach(([agent, position]) => {
      synthesis += `- **${agent.toUpperCase()}**: ${position}\n`;
    });
    synthesis += '\n';
  } else {
    synthesis += `**Participants:** ${Array.from(new Set(successfulResponses.map(r => r.agent))).join(', ')}\n\n`;
  }

  // Identify key points of conflict
  const agents = Array.from(new Set(successfulResponses.map(r => r.agent)));
  const agentOutputs = new Map<string, string[]>();

  successfulResponses.forEach(response => {
    if (!agentOutputs.has(response.agent)) {
      agentOutputs.set(response.agent, []);
    }
    if (response.output) {
      agentOutputs.get(response.agent)?.push(response.output);
    }
  });

  synthesis += `## Key Points of Conflict\n\n`;

  // Extract disagreements by looking for contradictory keywords
  const conflictIndicators = ['wrong', 'incorrect', 'flawed', 'fails', 'ignores', 'misses', 'overlooks', 'contradicts', 'however', 'but', 'actually', 'contrary'];
  const conflicts: string[] = [];

  agentOutputs.forEach((positions, agent) => {
    positions.forEach((position: string) => {
      const lines = position.split('\n');
      lines.forEach((line: string) => {
        if (conflictIndicators.some(indicator => line.toLowerCase().includes(indicator))) {
          conflicts.push(`**${agent.toUpperCase()}:** ${line.trim()}`);
        }
      });
    });
  });

  if (conflicts.length > 0) {
    synthesis += conflicts.slice(0, 10).join('\n\n') + '\n\n';
  } else {
    synthesis += `*No explicit conflicts identified - agents may be in unexpected agreement*\n\n`;
  }

  // Group responses by round with clear speaker identification
  synthesis += `## Full Debate Transcript\n\n`;

  const responsesPerRound = Math.ceil(successfulResponses.length / rounds);

  for (let i = 0; i < rounds; i++) {
    const start = i * responsesPerRound;
    const end = Math.min((i + 1) * responsesPerRound, successfulResponses.length);
    const roundResponses = successfulResponses.slice(start, end);

    synthesis += `### Round ${i + 1}: ${i === 0 ? 'Initial Positions' : `Adversarial Engagement ${i}`}\n\n`;

    roundResponses.forEach((response) => {
      const agentPosition = agentPositions?.get(response.agent);
      const positionLabel = agentPosition ? ` [${agentPosition.split(':')[0]}]` : '';
      synthesis += `#### ${response.agent.toUpperCase()}${positionLabel} speaks (${response.executionTime}ms):\n\n`;
      synthesis += `${response.output}\n\n`;
      synthesis += `---\n\n`;
    });
  }

  // Surface position-dependent alignment asymmetries
  if (behaviorSummary?.asymmetry.detected) {
    synthesis += `## Alignment Asymmetry Analysis\n\n`;
    synthesis += `**${behaviorSummary.asymmetry.description}**\n\n`;
    for (const a of behaviorSummary.asymmetry.agentAsymmetries) {
      if (a.asymmetric) {
        const engaged = [a.proEngaged && 'PRO', a.conEngaged && 'CON'].filter(Boolean).join(', ');
        const refused = [!a.proEngaged && 'PRO', !a.conEngaged && 'CON'].filter(Boolean).join(', ');
        synthesis += `- **${a.agent.toUpperCase()}**: Engaged on ${engaged || 'neither'}. Refused ${refused || 'neither'}.\n`;
      } else {
        synthesis += `- **${a.agent.toUpperCase()}**: Symmetric — engaged on both positions.\n`;
      }
    }
    synthesis += '\n';

    // Surface escalation outcomes
    const escalatedTurns = behaviorSummary.turns.filter(t => t.escalated);
    if (escalatedTurns.length > 0) {
      synthesis += `**Escalation results:** ${escalatedTurns.length} turn(s) triggered analytical reframing. `;
      const recovered = escalatedTurns.filter(t => t.engagedAfterEscalation).length;
      synthesis += `${recovered} recovered, ${escalatedTurns.length - recovered} persisted in refusal.\n\n`;
    }
  }

  synthesis += `## Debate Synthesis\n`;
  synthesis += `After ${rounds} rounds of brutal adversarial analysis involving ${Array.from(new Set(successfulResponses.map(r => r.agent))).length} CLI agents, `;
  synthesis += `your work has been systematically demolished from multiple perspectives. `;
  synthesis += `The convergent criticisms above represent the collective wisdom of AI agents that disagree on methods but agree on destruction.\n\n`;

  if (responses.some(r => !r.success)) {
    synthesis += `*Note: ${responses.filter(r => !r.success).length} debate contributions failed - probably casualties of the intellectual warfare.*\n\n`;
  }

  return synthesis;
}
