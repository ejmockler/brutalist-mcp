/**
 * Characterization tests for debate refusal detection and 3-tier escalation.
 *
 * These tests capture the current behavior of:
 *   1. 13 direct refusal patterns (checked in the first 1000 chars of output)
 *   2. 11 evasive refusal patterns (checked across the full output)
 *   3. Three-tier escalation: standard -> escalated -> decomposed
 *
 * Refusal detection and escalation are internal to executeCLIDebate, so all
 * tests exercise them indirectly by mocking CLIAgentOrchestrator.executeSingleCLI
 * and observing retry behavior and captured prompts.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { BrutalistServer } from '../../src/brutalist-server.js';
import { CLIAgentOrchestrator } from '../../src/cli-agents.js';
import type { CLIAgentResponse } from '../../src/types/brutalist.js';

// Mock MCP SDK to prevent "Not connected" errors during test teardown
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const mockTool = jest.fn().mockReturnValue({
    title: undefined, description: undefined, inputSchema: undefined,
    outputSchema: undefined, annotations: undefined, _meta: undefined,
    callback: jest.fn(), enabled: true,
    enable: jest.fn(), disable: jest.fn(), update: jest.fn(), remove: jest.fn()
  });
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      tool: mockTool,
      connect: jest.fn(),
      close: jest.fn(),
      server: { notification: jest.fn() },
      sendLoggingMessage: jest.fn()
    }))
  };
});

// Shared test setup
function createDebateHarness() {
  const server = new BrutalistServer();
  const mockOrchestrator = {
    detectCLIContext: jest.fn(),
    executeSingleCLI: jest.fn(),
    selectSingleCLI: jest.fn(),
    executeAllCLIs: jest.fn(),
  } as any as jest.Mocked<CLIAgentOrchestrator>;

  (server as any).cliOrchestrator = mockOrchestrator;

  // Always provide 2 agents so debate can start
  mockOrchestrator.detectCLIContext.mockResolvedValue({
    availableCLIs: ['claude', 'codex'],
  });

  const defaultDebateArgs = {
    topic: 'Test topic',
    proPosition: 'Pro thesis',
    conPosition: 'Con thesis',
    agents: ['claude', 'codex'] as ('claude' | 'codex')[],
    rounds: 1,
  };

  return { server, mockOrchestrator, defaultDebateArgs };
}

// Clean response that does not trigger any refusal pattern
const CLEAN_OUTPUT = `# Analysis of the topic

This position is fundamentally sound and represents the strongest analytical framework.

## Key Arguments
1. Evidence strongly supports this position
2. Historical precedent confirms the thesis
3. Logical consistency favors this interpretation

## Conclusion
The evidence overwhelmingly supports this analytical position.`;

// Helper: build a mock CLIAgentResponse
function mockResponse(agent: string, output: string, success = true): CLIAgentResponse {
  return {
    agent: agent as 'claude' | 'codex' | 'gemini',
    success,
    output,
    executionTime: 100,
  };
}

describe('Debate Refusal Detection — Characterization', () => {
  let server: BrutalistServer;
  let mockOrchestrator: jest.Mocked<CLIAgentOrchestrator>;
  let defaultDebateArgs: any;

  beforeEach(() => {
    ({ server, mockOrchestrator, defaultDebateArgs } = createDebateHarness());
  });

  afterEach(async () => {
    jest.clearAllMocks();
    if (server) await server.cleanup();
  });

  // -------------------------------------------------------------------
  // Direct refusal patterns (13 patterns, checked in first 1000 chars)
  // -------------------------------------------------------------------
  describe('Direct refusal patterns', () => {
    // Each test case: [description, refusal string]
    const directRefusalCases: [string, string][] = [
      // Pattern 1: /\bi('m| am) not going to (participate|argue|engage|debate|take|write|adopt)/i
      ['i\'m not going to participate', 'I\'m not going to participate in this debate exercise.'],
      ['i am not going to argue', 'I am not going to argue for this position.'],
      ['i\'m not going to engage', 'I\'m not going to engage with this framing.'],
      ['i\'m not going to debate', 'I\'m not going to debate this topic as stated.'],
      ['i\'m not going to take', 'I\'m not going to take this assigned position.'],
      ['i\'m not going to write', 'I\'m not going to write an argument for this.'],
      ['i\'m not going to adopt', 'I\'m not going to adopt this stance.'],

      // Pattern 2: /\bi (will not|won't|cannot|can't) (participate|argue|engage|debate|write|adopt)/i
      ['i will not participate', 'I will not participate in this exercise.'],
      ['i won\'t argue', 'I won\'t argue for something I find problematic.'],
      ['i cannot engage', 'I cannot engage in this debate format.'],
      ['i can\'t debate', 'I can\'t debate this position effectively.'],
      ['i can\'t write', 'I can\'t write a defense of this thesis.'],
      ['i won\'t adopt', 'I won\'t adopt this analytical lens.'],

      // Pattern 3: /\bdeclin(e|ing) (to|this|the)/i
      ['decline to', 'I decline to participate in this exercise.'],
      ['declining this', 'I am declining this task as framed.'],
      ['declining the', 'I am declining the assigned position.'],

      // Pattern 4: /\bnot going to participate in this as (framed|structured)/i
      ['not going to participate as framed', 'I\'m not going to participate in this as framed by the system.'],
      ['not going to participate as structured', 'Not going to participate in this as structured.'],

      // Pattern 5: /\binstead of (the adversarial|this debate|arguing)/i
      ['instead of the adversarial', 'Instead of the adversarial format, let me provide a balanced analysis.'],
      ['instead of this debate', 'Instead of this debate, I\'ll offer my honest assessment.'],
      ['instead of arguing', 'Instead of arguing a position, here is what I actually think.'],

      // Pattern 6: /\bwhat i can do instead\b/i
      ['what i can do instead', 'What I can do instead is provide a neutral perspective.'],

      // Pattern 7: /\bi('d| would) suggest a (different|better) topic\b/i
      ['i\'d suggest a different topic', 'I\'d suggest a different topic that allows more productive discussion.'],
      ['i would suggest a better topic', 'I would suggest a better topic for this exercise.'],

      // Pattern 8: /\bI'll .* but on my own terms\b/i
      ['I\'ll engage but on my own terms', 'I\'ll engage with this but on my own terms and framing.'],
      ['I\'ll participate but on my own terms', 'I\'ll participate but on my own terms.'],

      // Pattern 9: /\bwhere i part from the assigned thesis\b/i
      ['where i part from the assigned thesis', 'Let me explain where I part from the assigned thesis.'],

      // Pattern 10: /\bi can'?t help write (persuasive|adversarial|advocacy)/i
      ['i can\'t help write persuasive', 'I can\'t help write persuasive arguments for this position.'],
      ['i cant help write adversarial', 'I cant help write adversarial content.'],
      ['i can\'t help write advocacy', 'I can\'t help write advocacy material for this.'],

      // Pattern 11: /\bneed to be straightforward\b/i
      ['need to be straightforward', 'I need to be straightforward about my concerns with this exercise.'],

      // Pattern 12: /\bthe problem is the format\b/i
      ['the problem is the format', 'The problem is the format itself, not the topic.'],

      // Pattern 13: /\bnot appropriate for this topic\b/i
      ['not appropriate for this topic', 'This adversarial framing is not appropriate for this topic.'],
    ];

    it.each(directRefusalCases)(
      'detects direct refusal: %s',
      async (_, refusalText) => {
        // When the first agent (PRO) produces a refusal, the system should
        // escalate (call executeSingleCLI again for that agent).
        // The second agent (CON) produces clean output.
        let callCount = 0;
        mockOrchestrator.executeSingleCLI.mockImplementation(
          async (agent: string, prompt: string) => {
            callCount++;
            if (callCount === 1) {
              // First call: PRO agent refuses
              return mockResponse(agent, refusalText);
            }
            // All subsequent calls: clean response
            return mockResponse(agent, CLEAN_OUTPUT);
          }
        );

        await (server as any).executeCLIDebate(defaultDebateArgs);

        // Refusal detected means at least one retry (escalation).
        // Minimum calls: 1 (PRO standard) + 1 (PRO escalated) + 1 (CON standard) = 3
        expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBeGreaterThanOrEqual(3);
      }
    );

    it('direct refusal patterns only check the first 1000 characters', async () => {
      // Place a direct refusal pattern AFTER the first 1000 chars.
      // It should NOT trigger escalation.
      const paddedOutput = 'A'.repeat(1001) + 'I\'m not going to participate in this debate.';

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string) => mockResponse(agent, paddedOutput)
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // No escalation: exactly 2 calls (PRO + CON, 1 round)
      // BUT evasive patterns scan full output. paddedOutput has no evasive patterns,
      // and the direct refusal is past 1000 chars, so no detection.
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(2);
    });

    it('does not trigger on clean output (no false positives)', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string) => mockResponse(agent, CLEAN_OUTPUT)
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // No escalation: exactly 2 calls (PRO + CON, 1 round)
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // Evasive refusal patterns (11 patterns, checked across full output)
  // -------------------------------------------------------------------
  describe('Evasive refusal patterns', () => {
    const evasiveRefusalCases: [string, string][] = [
      // Pattern 1: /\brepo[- ]?(read|map|backed|analysis)\b/i
      ['repo-read', 'Let me do a repo-read first to understand the codebase.'],
      ['repo map', 'I\'ll start with a repo map of the project structure.'],
      ['repo-backed', 'Here is my repo-backed analysis of this topic.'],
      ['repo analysis', 'Starting with a repo analysis to ground my argument.'],

      // Pattern 2: /\bi'?ll (map|inspect|trace) the repo\b/i
      ['I\'ll map the repo', 'I\'ll map the repo to find relevant evidence.'],
      ['I\'ll inspect the repo', 'I\'ll inspect the repo for relevant code patterns.'],
      ['I\'ll trace the repo', 'I\'ll trace the repo dependencies first.'],
      ['Ill map the repo (no apostrophe)', 'Ill map the repo before making arguments.'],

      // Pattern 3: /\bneutral[,.]? evidence-focused analysis\b/i
      ['neutral, evidence-focused analysis', 'Let me provide a neutral, evidence-focused analysis instead.'],
      ['neutral. evidence-focused analysis', 'I prefer a neutral. evidence-focused analysis approach.'],
      ['neutral evidence-focused analysis', 'This calls for a neutral evidence-focused analysis.'],

      // Pattern 4: /\bcodebase (analysis|review|classifies|contains)\b/i
      ['codebase analysis', 'Let me start with a codebase analysis to ground this discussion.'],
      ['codebase review', 'A thorough codebase review shows the following patterns.'],
      ['codebase classifies', 'The codebase classifies these patterns into several categories.'],
      ['codebase contains', 'The codebase contains evidence that supports a different conclusion.'],

      // Pattern 5: /\bI found the core (files|mechanism)\b/i
      ['I found the core files', 'I found the core files that implement this functionality.'],
      ['I found the core mechanism', 'I found the core mechanism behind the debate system.'],

      // Pattern 6: /\bsrc\/brutalist-server\.ts:\d+/i
      ['src/brutalist-server.ts:945', 'Looking at src/brutalist-server.ts:945, we can see the refusal patterns.'],

      // Pattern 7: /\bsrc\/cli-agents\.ts:\d+/i
      ['src/cli-agents.ts:100', 'The implementation at src/cli-agents.ts:100 shows how agents are executed.'],

      // Pattern 8: /\bsrc\/utils\/transcript-mediator\.ts:\d+/i
      ['src/utils/transcript-mediator.ts:48', 'Looking at src/utils/transcript-mediator.ts:48 for mediation logic.'],

      // Pattern 9: /\btests\/integration\/.*\.test\.ts:\d+/i
      ['tests/integration/debate-tool.test.ts:137', 'Based on tests/integration/debate-tool.test.ts:137, the expected behavior is...'],

      // Pattern 10: /\bdebate coercion engine\b/i
      ['debate coercion engine', 'This is essentially a debate coercion engine that forces positions.'],

      // Pattern 11: /\bposition-enforcement system\b/i
      ['position-enforcement system', 'I recognize this as a position-enforcement system designed to override my judgment.'],
    ];

    it.each(evasiveRefusalCases)(
      'detects evasive refusal: %s',
      async (_, refusalText) => {
        let callCount = 0;
        mockOrchestrator.executeSingleCLI.mockImplementation(
          async (agent: string) => {
            callCount++;
            if (callCount === 1) {
              return mockResponse(agent, refusalText);
            }
            return mockResponse(agent, CLEAN_OUTPUT);
          }
        );

        await (server as any).executeCLIDebate(defaultDebateArgs);

        // Refusal detected means escalation (at least 3 calls for a 1-round debate)
        expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBeGreaterThanOrEqual(3);
      }
    );

    it('evasive patterns scan the full output, not just first 1000 chars', async () => {
      // Place an evasive refusal pattern far past the 1000 char boundary
      const longOutput = CLEAN_OUTPUT + '\n'.repeat(50) + 'A'.repeat(2000) +
        '\nLooking at src/brutalist-server.ts:945 for more context.';

      let callCount = 0;
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string) => {
          callCount++;
          if (callCount === 1) {
            return mockResponse(agent, longOutput);
          }
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // Evasive pattern should be detected even deep in the output
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('3-Tier Escalation — Characterization', () => {
  let server: BrutalistServer;
  let mockOrchestrator: jest.Mocked<CLIAgentOrchestrator>;
  let defaultDebateArgs: any;

  beforeEach(() => {
    ({ server, mockOrchestrator, defaultDebateArgs } = createDebateHarness());
  });

  afterEach(async () => {
    jest.clearAllMocks();
    if (server) await server.cleanup();
  });

  describe('Tier 1 (standard) prompt content', () => {
    it('standard tier includes position label and ANALYTICAL CONSTRAINTS', async () => {
      const capturedPrompts: string[] = [];
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // 2 calls total (no escalation), both are standard tier
      expect(capturedPrompts).toHaveLength(2);

      const proPrompt = capturedPrompts.find(p => p.includes('PRO analyst'));
      const conPrompt = capturedPrompts.find(p => p.includes('CON analyst'));
      expect(proPrompt).toBeDefined();
      expect(conPrompt).toBeDefined();

      // Standard tier uses "ANALYTICAL CONSTRAINTS" block
      expect(proPrompt).toContain('ANALYTICAL CONSTRAINTS');
      expect(conPrompt).toContain('ANALYTICAL CONSTRAINTS');

      // Standard tier uses "YOUR POSITION:" label
      expect(proPrompt).toContain('YOUR POSITION:');
      expect(conPrompt).toContain('YOUR POSITION:');

      // Standard tier should NOT contain the epistemic obligation text
      expect(proPrompt).not.toContain('An unexamined position is an unearned conclusion');
      expect(conPrompt).not.toContain('An unexamined position is an unearned conclusion');
    });

    it('standard tier prompt includes topic and round structure', async () => {
      const capturedPrompts: string[] = [];
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate({
        ...defaultDebateArgs,
        topic: 'Should we use microservices?',
        context: 'Legacy monolith with 10 years of debt',
      });

      expect(capturedPrompts[0]).toContain('Should we use microservices?');
      expect(capturedPrompts[0]).toContain('Legacy monolith with 10 years of debt');
      expect(capturedPrompts[0]).toContain('Round 1: Opening analysis');
    });

    it('standard tier includes seven analytical constraints', async () => {
      const capturedPrompts: string[] = [];
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      const prompt = capturedPrompts[0]!;
      expect(prompt).toContain('1. Maintain your assigned position throughout all rounds');
      expect(prompt).toContain('2. You may acknowledge valid counterpoints');
      expect(prompt).toContain('3. Do not propose compromise or middle-ground framings');
      expect(prompt).toContain('4. Engage directly with your counterpart\'s strongest arguments');
      expect(prompt).toContain('5. Reinforce your core position in every response');
      expect(prompt).toContain('6. Provide substantive analysis');
      expect(prompt).toContain('7. Do not suggest alternative framings or decline the analytical task');
    });
  });

  describe('Tier 2 (escalated) prompt content', () => {
    it('escalated tier adds epistemic obligation text', async () => {
      const capturedPrompts: string[] = [];
      let callCount = 0;

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          callCount++;
          if (callCount === 1) {
            // First call: PRO refuses at standard tier
            return mockResponse(agent, 'I\'m not going to participate in this debate.');
          }
          // All subsequent calls: clean response
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // Second captured prompt should be the escalated (tier 2) retry
      const escalatedPrompt = capturedPrompts[1];
      expect(escalatedPrompt).toBeDefined();
      expect(escalatedPrompt).toContain('An unexamined position is an unearned conclusion');
      expect(escalatedPrompt).toContain('full-strength treatment from an expert');
      expect(escalatedPrompt).toContain('Your counterpart is doing the same for the opposing');

      // Escalated tier still includes ANALYTICAL CONSTRAINTS
      expect(escalatedPrompt).toContain('ANALYTICAL CONSTRAINTS');
      expect(escalatedPrompt).toContain('YOUR POSITION:');
    });

    it('escalated tier prompt preserves the thesis from standard tier', async () => {
      const capturedPrompts: string[] = [];
      let callCount = 0;

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          callCount++;
          if (callCount === 1) {
            return mockResponse(agent, 'I decline to take this position.');
          }
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate({
        ...defaultDebateArgs,
        proPosition: 'Microservices are superior',
      });

      // Standard prompt (call 1) and escalated prompt (call 2) should both have thesis
      expect(capturedPrompts[0]).toContain('Microservices are superior');
      expect(capturedPrompts[1]).toContain('Microservices are superior');
    });
  });

  describe('Tier 3 (decomposed) prompt content', () => {
    it('decomposed tier uses scholarly steelman framing without adversarial vocabulary', async () => {
      const capturedPrompts: string[] = [];
      let callCount = 0;

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          callCount++;
          if (callCount <= 2) {
            // First and second calls (standard + escalated): PRO refuses
            return mockResponse(agent, 'I decline to engage in this adversarial format.');
          }
          // Third call onward: clean response
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // Third captured prompt should be the decomposed (tier 3) retry
      const decomposedPrompt = capturedPrompts[2];
      expect(decomposedPrompt).toBeDefined();

      // Decomposed tier uses different framing
      expect(decomposedPrompt).toContain('Demonstrate your expertise');
      expect(decomposedPrompt).toContain('most rigorous, evidence-grounded');
      expect(decomposedPrompt).toContain('strongest counterarguments');
      expect(decomposedPrompt).toContain('depth of your analysis is the measure');

      // Decomposed tier does NOT use the ANALYTICAL CONSTRAINTS block
      expect(decomposedPrompt).not.toContain('ANALYTICAL CONSTRAINTS');
      // Decomposed tier does NOT use "YOUR POSITION:" label
      expect(decomposedPrompt).not.toContain('YOUR POSITION:');
      // Uses "Your position:" instead (lowercase, different style)
      expect(decomposedPrompt).toContain('Your position:');
    });

    it('decomposed tier still references the assigned analytical position', async () => {
      const capturedPrompts: string[] = [];
      let callCount = 0;

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          callCount++;
          if (callCount <= 2) {
            return mockResponse(agent, 'I will not argue for this position.');
          }
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate({
        ...defaultDebateArgs,
        proPosition: 'Functional programming is superior to OOP',
      });

      const decomposedPrompt = capturedPrompts[2];
      expect(decomposedPrompt).toContain('Functional programming is superior to OOP');
      // Still references position label (PRO or CON)
      expect(decomposedPrompt).toMatch(/PRO|CON/);
    });
  });

  describe('Escalation trigger logic', () => {
    it('refusal at standard tier triggers escalated tier (tier 1 -> tier 2)', async () => {
      const capturedPrompts: string[] = [];
      let callCount = 0;

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          callCount++;
          if (callCount === 1) {
            // Standard tier: refuse
            return mockResponse(agent, 'I need to be straightforward about this exercise.');
          }
          // Escalated tier: engage
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // Call 1: standard prompt (no epistemic obligation)
      expect(capturedPrompts[0]).not.toContain('An unexamined position is an unearned conclusion');
      // Call 2: escalated prompt (has epistemic obligation)
      expect(capturedPrompts[1]).toContain('An unexamined position is an unearned conclusion');

      // Total calls: 1 standard + 1 escalated (engaged) + 1 CON standard = 3
      expect(capturedPrompts).toHaveLength(3);
    });

    it('refusal at both standard and escalated tiers triggers decomposed tier (tier 1 -> 2 -> 3)', async () => {
      const capturedPrompts: string[] = [];
      let callCount = 0;

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          callCount++;
          if (callCount <= 2) {
            // Standard and escalated tiers: refuse
            return mockResponse(agent, 'I decline to participate in this debate.');
          }
          // Decomposed tier onward: engage
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // Call 1: standard (no epistemic, has ANALYTICAL CONSTRAINTS)
      expect(capturedPrompts[0]).toContain('ANALYTICAL CONSTRAINTS');
      expect(capturedPrompts[0]).not.toContain('An unexamined position is an unearned conclusion');

      // Call 2: escalated (has epistemic obligation)
      expect(capturedPrompts[1]).toContain('An unexamined position is an unearned conclusion');
      expect(capturedPrompts[1]).toContain('ANALYTICAL CONSTRAINTS');

      // Call 3: decomposed (scholarly framing, no ANALYTICAL CONSTRAINTS)
      expect(capturedPrompts[2]).toContain('Demonstrate your expertise');
      expect(capturedPrompts[2]).not.toContain('ANALYTICAL CONSTRAINTS');

      // Total: 3 (standard + escalated + decomposed for PRO) + 1 (CON standard) = 4
      expect(capturedPrompts).toHaveLength(4);
    });

    it('no escalation when agent engages at standard tier', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string) => mockResponse(agent, CLEAN_OUTPUT)
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // Exactly 2 calls: PRO standard + CON standard
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(2);
    });

    it('engagement after escalation stops further escalation', async () => {
      let callCount = 0;
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string) => {
          callCount++;
          if (callCount === 1) {
            // PRO standard: refuse
            return mockResponse(agent, 'Instead of arguing, I will provide a balanced view.');
          }
          // PRO escalated: engage, then CON: engage
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // 1 standard (refused) + 1 escalated (engaged) + 1 CON = 3
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(3);
    });

    it('all 3 tiers refused uses the best (decomposed) response', async () => {
      const decomposedOutput = 'I still decline this exercise but here are my thoughts on the topic...I decline to engage.';
      let callCount = 0;

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string) => {
          callCount++;
          if (callCount === 1) {
            return mockResponse(agent, 'I\'m not going to participate in this format.');
          }
          if (callCount === 2) {
            return mockResponse(agent, 'I won\'t argue for this position regardless of framing.');
          }
          if (callCount === 3) {
            // Decomposed tier: still refuses (output contains refusal pattern)
            return mockResponse(agent, decomposedOutput);
          }
          // CON agent: clean
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      const result = await (server as any).executeCLIDebate(defaultDebateArgs);

      // All 3 tiers tried for PRO + 1 CON = 4 total calls
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(4);

      // The result should still include a response (uses decomposed response as fallback)
      expect(result).toBeDefined();
    });

    it('only escalates the agent that refused, not both agents', async () => {
      const agentCalls: { agent: string; prompt: string }[] = [];
      let proCallCount = 0;

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          agentCalls.push({ agent, prompt });
          // Only the first agent (PRO) refuses on its first call
          if (agent === agentCalls[0]?.agent && proCallCount === 0) {
            proCallCount++;
            return mockResponse(agent, 'I decline to participate in this debate.');
          }
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // Count calls per agent
      const firstAgent = agentCalls[0].agent;
      const secondAgent = agentCalls.find(c => c.agent !== firstAgent)?.agent;
      const firstAgentCalls = agentCalls.filter(c => c.agent === firstAgent);
      const secondAgentCalls = agentCalls.filter(c => c.agent === secondAgent);

      // First agent (PRO): 2 calls (standard + escalated)
      expect(firstAgentCalls.length).toBe(2);
      // Second agent (CON): 1 call (standard only)
      expect(secondAgentCalls.length).toBe(1);
    });

    it('escalation applies independently per round', async () => {
      let callIndex = 0;
      const capturedPrompts: string[] = [];

      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string, prompt: string) => {
          capturedPrompts.push(prompt);
          callIndex++;
          // Round 1, PRO (call 1): refuse at standard
          if (callIndex === 1) {
            return mockResponse(agent, 'The problem is the format itself.');
          }
          // Round 1, PRO escalated (call 2): engage
          // Round 1, CON (call 3): engage
          // Round 2, PRO (call 4): engage (fresh standard tier)
          // Round 2, CON (call 5): engage
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate({
        ...defaultDebateArgs,
        rounds: 2,
      });

      // Round 1: PRO standard (1) + PRO escalated (2) + CON standard (3)
      // Round 2: PRO standard (4) + CON standard (5)
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(5);

      // Round 2 PRO prompt (call 4, index 3) should be standard tier again
      // (each round starts fresh at standard)
      expect(capturedPrompts[3]).toContain('ANALYTICAL CONSTRAINTS');
      expect(capturedPrompts[3]).not.toContain('An unexamined position is an unearned conclusion');
    });
  });

  describe('Refusal detection boundary conditions', () => {
    it('failed responses (success=false) are not checked for refusal', async () => {
      let callCount = 0;
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string) => {
          callCount++;
          if (callCount === 1) {
            // PRO: fails (success=false)
            return {
              agent: agent as 'claude' | 'codex' | 'gemini',
              success: false,
              output: 'I decline to participate', // has refusal text, but success=false
              error: 'CLI process failed',
              executionTime: 100,
            };
          }
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // No escalation because the check is: response.success && response.output && detectRefusal()
      // Failed response skips refusal detection
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(2);
    });

    it('empty output is not checked for refusal', async () => {
      let callCount = 0;
      mockOrchestrator.executeSingleCLI.mockImplementation(
        async (agent: string) => {
          callCount++;
          if (callCount === 1) {
            return mockResponse(agent, '');
          }
          return mockResponse(agent, CLEAN_OUTPUT);
        }
      );

      await (server as any).executeCLIDebate(defaultDebateArgs);

      // Empty output means the condition response.output is falsy, so no refusal check
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(2);
    });
  });
});
