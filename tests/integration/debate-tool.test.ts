/**
 * Debate Tool Tests
 * Complete coverage of multi-agent debate functionality
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { BrutalistServer } from '../../src/brutalist-server.js';
import { CLIAgentOrchestrator } from '../../src/cli-agents.js';
import { CLIAgentResponse } from '../../src/types/brutalist.js';

// Mock CLI responses for testing
const mockCLIResponses = {
  claude: {
    proPosition: `# CLAUDE: STRONG ADVOCATE FOR PROGRESS

This approach is FUNDAMENTALLY SOUND and represents the only viable path forward.

## Why This Must Be Done

1. **Strategic Necessity**: Delaying this decision costs us competitive advantage
2. **Technical Excellence**: The proposed solution leverages proven patterns
3. **Risk Mitigation**: Not acting introduces far greater risks

## Addressing Opposition Concerns

The opposition's concerns about complexity are overblown. Modern engineering practices handle this complexity routinely.

**Bottom Line**: This is the correct choice. Any alternative approach leads to technical debt and missed opportunities.`,

    contraResponse: `# CLAUDE: RESPONDING TO FLAWED REASONING

The opposition's arguments are built on DANGEROUS ASSUMPTIONS.

## Critical Flaws in Their Logic

1. **False Urgency**: Their "strategic necessity" is manufactured panic
2. **Complexity Blindness**: They dismiss real implementation challenges
3. **Risk Miscalculation**: They vastly underestimate execution risks

Quote: "Modern engineering practices handle this complexity routinely"
**Reality**: Most projects of this complexity fail spectacularly.

The opposition's confidence is completely misplaced.`
  },

  codex: {
    contraPosition: `# CODEX: SYSTEMATIC OPPOSITION TO RECKLESS DECISIONS

This proposal is a TEXTBOOK EXAMPLE of engineering hubris.

## Fatal Implementation Problems

1. **Scalability Nightmare**: Architecture won't handle real-world load
2. **Maintenance Hell**: Overly complex systems become unmaintainable
3. **Resource Drain**: Implementation costs will spiral out of control

## Historical Evidence

Similar approaches have failed consistently across the industry.

**Verdict**: This approach is fundamentally flawed and should be rejected outright.`,

    proResponse: `# CODEX: EXPOSING OPPOSITION'S FEAR-BASED THINKING

The opposition's arguments reveal PARALYZING RISK AVERSION.

## Debunking Their Claims

Quote: "Architecture won't handle real-world load"
**Counter**: Modern cloud infrastructure scales elastically.

Quote: "Implementation costs will spiral"
**Counter**: Cost of inaction far exceeds implementation costs.

## The Real Problem

Their "historical evidence" cherry-picks failures while ignoring successes.

**Truth**: Cautious incrementalism leads to obsolescence.`
  },

  gemini: {
    proPosition: `# GEMINI: DECISIVE ACTION IS REQUIRED

The opposition's position reflects OUTDATED THINKING.

## Market Reality Check

1. **Competitive Pressure**: Competitors are already implementing similar solutions
2. **User Expectations**: Modern users demand this functionality
3. **Technology Maturity**: Required technologies are now stable and proven

## Opposition's Blind Spots

Their focus on hypothetical risks ignores REAL market threats.

**Conclusion**: Hesitation is the greater risk.`,

    contraResponse: `# GEMINI: EXPOSING MARKET-DRIVEN FALLACIES

The pro position demonstrates DANGEROUS MARKET MYOPIA.

## Flawed Market Analysis

Quote: "Competitors are already implementing similar solutions"
**Reality**: Most competitors are struggling with these implementations.

Quote: "Users demand this functionality"
**Counter**: Users demand reliable systems, not bleeding-edge complexity.

## Strategic Wisdom

True competitive advantage comes from SUSTAINABLE solutions, not rushed implementations.

**Verdict**: Following market hype leads to technical disasters.`
  }
};

describe('Debate Tool Tests', () => {
  let brutalistServer: BrutalistServer;
  let mockOrchestrator: jest.Mocked<CLIAgentOrchestrator>;

  beforeEach(() => {
    brutalistServer = new BrutalistServer();
    
    // Mock the CLI orchestrator
    mockOrchestrator = {
      detectCLIContext: jest.fn(),
      executeSingleCLI: jest.fn(),
      selectSingleCLI: jest.fn(),
      executeAllCLIs: jest.fn(),
    } as any;

    // Replace the orchestrator in the brutalist server
    (brutalistServer as any).cliOrchestrator = mockOrchestrator;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Debate Initialization', () => {
    it('should require at least 2 CLI agents for debate', async () => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude'], // Only one CLI
      });

      await expect(
        (brutalistServer as any).executeCLIDebate(
          'Should we migrate to microservices?',
          2
        )
      ).rejects.toThrow('Need at least 2 CLI agents for debate');
    });

    it('should assign opposing positions to available agents', async () => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex'],
      });

      let capturedPrompts: string[] = [];
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        capturedPrompts.push(prompt);
        return {
          agent,
          success: true,
          output: `Mock response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'Should we adopt GraphQL?',
        1 // Single round to test initialization
      );

      expect(capturedPrompts).toHaveLength(2);
      
      // Check that prompts contain proper position assignments
      const proPrompt = capturedPrompts.find(p => p.includes('PRO-POSITION: Argue strongly FOR'));
      const contraPrompt = capturedPrompts.find(p => p.includes('CONTRA-POSITION: Argue strongly AGAINST'));
      
      expect(proPrompt).toBeDefined();
      expect(contraPrompt).toBeDefined();
    });

    it('should handle debate topic and context properly', async () => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex'],
      });

      let capturedPrompts: string[] = [];
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        capturedPrompts.push(prompt);
        return {
          agent,
          success: true,
          output: `Mock response from ${agent}`,
          executionTime: 100
        };
      });

      const topic = 'Should we rewrite our legacy system?';
      const context = 'Our current system has 10 years of technical debt';

      await (brutalistServer as any).executeCLIDebate(topic, 1, context);

      capturedPrompts.forEach(prompt => {
        expect(prompt).toContain(topic);
        expect(prompt).toContain(context);
      });
    });
  });

  describe('Multi-Round Debate Flow', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex'],
      });
    });

    it('should conduct multiple rounds of debate', async () => {
      let callCount = 0;
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        callCount++;
        const round = callCount <= 2 ? 1 : 2;
        
        return {
          agent,
          success: true,
          output: `Round ${round} response from ${agent}: ${prompt.substring(0, 50)}...`,
          executionTime: 100
        };
      });

      const result = await (brutalistServer as any).executeCLIDebate(
        'GraphQL vs REST debate',
        2 // Two rounds
      );

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledTimes(4); // 2 agents * 2 rounds
      expect(result.success).toBe(true);
      expect(result.responses).toHaveLength(4);
    });

    it('should build confrontational context in subsequent rounds', async () => {
      let roundPrompts: string[] = [];
      
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        roundPrompts.push(prompt);
        
        // Return different responses for each agent/round
        if (prompt.includes('Round 1') || !prompt.includes('Round')) {
          return {
            agent,
            success: true,
            output: agent === 'claude' ? mockCLIResponses.claude.proPosition : mockCLIResponses.codex.contraPosition,
            executionTime: 100
          };
        } else {
          return {
            agent,
            success: true,
            output: agent === 'claude' ? mockCLIResponses.claude.contraResponse : mockCLIResponses.codex.proResponse,
            executionTime: 100
          };
        }
      });

      await (brutalistServer as any).executeCLIDebate(
        'Microservices architecture decision',
        2
      );

      // Round 2 prompts should contain opponent's previous arguments
      const round2Prompts = roundPrompts.filter(p => p.includes('Round 2'));
      expect(round2Prompts.length).toBeGreaterThan(0);
      
      round2Prompts.forEach(prompt => {
        expect(prompt).toContain('YOUR OPPONENTS HAVE ARGUED:');
        expect(prompt).toContain('QUOTE their specific claims');
        expect(prompt).toContain('Round 2');
      });
    });

    it('should maintain agent positions across rounds', async () => {
      let agentPositions: Map<string, string> = new Map();
      
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        // Track positions from initial assignment
        if (prompt.includes('PRO-POSITION: Argue strongly FOR')) {
          agentPositions.set(agent, 'PRO');
        } else if (prompt.includes('CONTRA-POSITION: Argue strongly AGAINST')) {
          agentPositions.set(agent, 'CONTRA');
        }
        
        return {
          agent,
          success: true,
          output: `Position-consistent response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'Technology adoption strategy',
        3 // Three rounds
      );

      // Each agent should maintain the same position throughout
      expect(agentPositions.size).toBe(2);
      expect([...agentPositions.values()]).toContain('PRO');
      expect([...agentPositions.values()]).toContain('CONTRA');
    });
  });

  describe('Three-Agent Debate Scenarios', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex', 'gemini'],
      });
    });

    it('should handle three-agent debates with position assignment', async () => {
      let agentCalls: Array<{ agent: string; round: number }> = [];
      
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        const isFirstRound = !prompt.includes('Round 2') && !prompt.includes('Round 3');
        const roundMatch = prompt.match(/Round (\d+)/);
        const round = isFirstRound ? 1 : parseInt(roundMatch?.[1] || '1');
        
        agentCalls.push({ agent, round });
        
        return {
          agent,
          success: true,
          output: `Response from ${agent} in round ${round}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'Cloud-native architecture debate',
        2
      );

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledTimes(6); // 3 agents * 2 rounds
      
      // Check that all agents participated in each round
      const round1Calls = agentCalls.filter(c => c.round === 1);
      const round2Calls = agentCalls.filter(c => c.round === 2);
      
      expect(round1Calls).toHaveLength(3);
      expect(round2Calls).toHaveLength(3);
      
      expect(round1Calls.map(c => c.agent).sort()).toEqual(['claude', 'codex', 'gemini']);
      expect(round2Calls.map(c => c.agent).sort()).toEqual(['claude', 'codex', 'gemini']);
    });

    it('should alternate PRO/CONTRA positions for three agents', async () => {
      let positions: Array<{ agent: string; position: string }> = [];
      
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        if (prompt.includes('PRO-POSITION: Argue strongly FOR')) {
          positions.push({ agent, position: 'PRO' });
        } else if (prompt.includes('CONTRA-POSITION: Argue strongly AGAINST')) {
          positions.push({ agent, position: 'CONTRA' });
        }
        
        return {
          agent,
          success: true,
          output: `Positioned response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'API design philosophy',
        1
      );

      expect(positions).toHaveLength(3);
      
      // Should alternate PRO/CONTRA/PRO or CONTRA/PRO/CONTRA
      const proCount = positions.filter(p => p.position === 'PRO').length;
      const contraCount = positions.filter(p => p.position === 'CONTRA').length;
      
      expect(Math.abs(proCount - contraCount)).toBeLessThanOrEqual(1); // Should be balanced
    });
  });

  describe('Error Handling and Edge Cases', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex'],
      });
    });

    it('should handle CLI execution failures gracefully', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        if (agent === 'claude') {
          return {
            agent,
            success: false,
            error: 'Claude CLI not available',
            executionTime: 0,
            output: ''
          };
        }
        return {
          agent,
          success: true,
          output: 'Successful response from codex',
          executionTime: 100
        };
      });

      const result = await (brutalistServer as any).executeCLIDebate(
        'Database migration strategy',
        2
      );

      expect(result.success).toBe(true); // Should succeed if at least one agent succeeds
      expect(result.responses.some((r: any) => r.success)).toBe(true);
      // Note: Failed responses are not included in the final response array by design
      expect(result.responses.every((r: any) => r.success)).toBe(true);
      expect(result.synthesis).toBeDefined();
      expect(result.synthesis).not.toContain('CLI Debate Failed');
    });

    it('should handle complete debate failure', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: false,
          error: `${agent} failed to execute`,
          executionTime: 0,
          output: ''
        };
      });

      const result = await (brutalistServer as any).executeCLIDebate(
        'Failed debate topic',
        1
      );

      expect(result.success).toBe(false);
      expect(result.synthesis).toContain('CLI Debate Failed');
      expect(result.synthesis).toContain('brutal critics couldn\'t engage');
    });

    it('should handle empty or malformed responses', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: '', // Empty response
          executionTime: 100
        };
      });

      const result = await (brutalistServer as any).executeCLIDebate(
        'Empty response test',
        1
      );

      expect(result.success).toBe(true);
      expect(result.responses.every((r: any) => r.success)).toBe(true);
      expect(result.synthesis).toBeDefined();
    });

    it('should handle very long debate rounds', async () => {
      let executionCount = 0;
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        executionCount++;
        return {
          agent,
          success: true,
          output: `Round ${Math.ceil(executionCount / 2)} response from ${agent}`,
          executionTime: 100
        };
      });

      // Test maximum rounds (10)
      const result = await (brutalistServer as any).executeCLIDebate(
        'Extended debate topic',
        10
      );

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledTimes(20); // 2 agents * 10 rounds
      expect(result.success).toBe(true);
      expect(result.responses).toHaveLength(20);
    });

    it('should respect timeout settings', async () => {
      const startTime = Date.now();
      
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        // Simulate long execution time
        await new Promise(resolve => setTimeout(resolve, 50));
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: Date.now() - startTime
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'Timeout test topic',
        1
      );

      // Verify that timeout was passed to CLI execution
      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          timeout: expect.any(Number)
        })
      );
    });
  });

  describe('Debate Synthesis', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex', 'gemini'],
      });
    });

    it('should synthesize debate results correctly', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: (mockCLIResponses[agent as keyof typeof mockCLIResponses] as any)?.proPosition || `Response from ${agent}`,
          executionTime: 100
        };
      });

      const result = await (brutalistServer as any).executeCLIDebate(
        'API versioning strategy',
        2,
        'Legacy API needs updating'
      );

      expect(result.synthesis).toBeDefined();
      expect(result.synthesis).toContain('Brutalist CLI Agent Debate Results');
      expect(result.synthesis).toContain('API versioning strategy');
      expect(result.synthesis).toMatch(/\*\*Rounds:\*\*\s*2/);
      expect(result.synthesis).toMatch(/PRO-POSITION/);
      expect(result.synthesis).toMatch(/CONTRA-POSITION/);
    });

    it('should include all participant information in synthesis', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: `Detailed response from ${agent}`,
          executionTime: 100
        };
      });

      const result = await (brutalistServer as any).executeCLIDebate(
        'Container orchestration choice',
        1
      );

      expect(result.synthesis).toContain('CLAUDE');
      expect(result.synthesis).toContain('CODEX');
      expect(result.synthesis).toContain('GEMINI');
    });

    it('should handle synthesis of partial failures', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        if (agent === 'gemini') {
          return {
            agent,
            success: false,
            error: 'Gemini execution failed',
            executionTime: 0
          };
        }
        return {
          agent,
          success: true,
          output: `Successful response from ${agent}`,
          executionTime: 100
        };
      });

      const result = await (brutalistServer as any).executeCLIDebate(
        'Partial failure test',
        1
      );

      expect(result.synthesis).toBeDefined();
      expect(result.synthesis).toContain('CLAUDE');
      expect(result.synthesis).toContain('CODEX');
      // Should handle missing gemini gracefully
    });
  });

  describe('Model Configuration', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex', 'gemini'],
      });
    });

    it('should pass model configurations to CLI execution', async () => {
      const models = {
        claude: 'opus',
        codex: 'gpt-5.1-codex-max',
        gemini: 'gemini-3-pro-preview'
      };

      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'Model configuration test',
        1,
        undefined, // context
        undefined, // workingDirectory
        models
      );

      // Verify model configurations were passed
      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        'claude',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          models: { claude: 'opus' }
        })
      );

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        'codex',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          models: { codex: 'gpt-5.1-codex-max' }
        })
      );

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        'gemini',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          models: { gemini: 'gemini-3-pro-preview' }
        })
      );
    });

    it('should handle missing model configurations gracefully', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'No model config test',
        1
      );

      // Should work without model configurations
      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          models: undefined
        })
      );
    });
  });

  describe('Working Directory Handling', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex'],
      });
    });

    it('should pass working directory to CLI execution', async () => {
      const workingDir = '/custom/working/directory';
      
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'Working directory test',
        1,
        undefined, // context
        workingDir
      );

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          workingDirectory: workingDir
        })
      );
    });

    it('should use default working directory when none provided', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate(
        'Default directory test',
        1
      );

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          workingDirectory: expect.any(String)
        })
      );
    });
  });

  describe('Debate Continuation and Caching', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex'],
      });

      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: `Debate response from ${agent}: ${prompt.substring(0, 100)}...`,
          executionTime: 100
        };
      });
    });

    it('should return context_id in debate response', async () => {
      const result = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'Should we adopt microservices?',
        debateRounds: 1
      });

      // The response should be formatted and include context_id
      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Context ID');
    });

    it('should throw error when resume is true without context_id', async () => {
      const result = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'Follow-up question',
        resume: true
        // No context_id provided
      });

      expect(result.content[0].text).toContain('requires a \'context_id\'');
    });

    it('should throw error when resume is true with invalid context_id', async () => {
      const result = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'Follow-up question',
        resume: true,
        context_id: 'non-existent-id'
      });

      expect(result.content[0].text).toContain('not found in cache');
    });

    it('should cache debate results for pagination', async () => {
      // First call - creates cached result
      const firstResult = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'Should we use GraphQL?',
        debateRounds: 1
      });

      // Extract context_id from response
      const contextIdMatch = firstResult.content[0].text.match(/Context ID:\*\*\s*([a-f0-9-]+)/i);
      expect(contextIdMatch).toBeTruthy();
      const contextId = contextIdMatch![1];

      // Second call with same context_id (pagination) - should return cached
      const secondResult = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'Should we use GraphQL?',
        context_id: contextId,
        offset: 0
      });

      // Should return cached content without re-executing
      expect(secondResult.content[0].text).toBeDefined();
      // CLI should not have been called again for pagination
      const callCountBeforePagination = mockOrchestrator.executeSingleCLI.mock.calls.length;

      await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'Should we use GraphQL?',
        context_id: contextId,
        offset: 1000
      });

      // No new CLI calls for pagination
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(callCountBeforePagination);
    });

    it('should support conversation continuation with resume flag', async () => {
      // Initial debate
      const initialResult = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'Should we migrate to Kubernetes?',
        debateRounds: 1
      });

      const contextIdMatch = initialResult.content[0].text.match(/Context ID:\*\*\s*([a-f0-9-]+)/i);
      expect(contextIdMatch).toBeTruthy();
      const contextId = contextIdMatch![1];

      const callCountAfterInitial = mockOrchestrator.executeSingleCLI.mock.calls.length;

      // Continue the debate with resume flag
      const continuationResult = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'What about the security implications?',
        context_id: contextId,
        resume: true,
        debateRounds: 1
      });

      // Should have made new CLI calls for continuation
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBeGreaterThan(callCountAfterInitial);
      expect(continuationResult.content[0].text).toBeDefined();
    });

    it('should inject previous debate context when resuming', async () => {
      // Initial debate
      const initialResult = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'REST vs GraphQL for our API',
        debateRounds: 1
      });

      const contextIdMatch = initialResult.content[0].text.match(/Context ID:\*\*\s*([a-f0-9-]+)/i);
      const contextId = contextIdMatch![1];

      // Clear mock calls to check new calls
      mockOrchestrator.executeSingleCLI.mockClear();

      // Continue with a follow-up
      await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'But what about caching strategies?',
        context_id: contextId,
        resume: true,
        debateRounds: 1
      });

      // Check that the prompts include previous debate context
      const calls = mockOrchestrator.executeSingleCLI.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // At least one call should contain the previous debate context indicator
      const hasContextInjection = calls.some((call: any[]) => {
        const prompt = call[1] as string;
        return prompt.includes('Previous Debate Context') || prompt.includes('Follow-up Question');
      });
      expect(hasContextInjection).toBe(true);
    });

    it('should require new content when resume is true', async () => {
      // Initial debate
      const initialResult = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: 'Initial debate topic',
        debateRounds: 1
      });

      const contextIdMatch = initialResult.content[0].text.match(/Context ID:\*\*\s*([a-f0-9-]+)/i);
      const contextId = contextIdMatch![1];

      // Try to resume without content
      const result = await (brutalistServer as any).handleDebateToolExecution({
        targetPath: '', // Empty content
        context_id: contextId,
        resume: true
      });

      expect(result.content[0].text).toContain('requires a new prompt');
    });
  });
});