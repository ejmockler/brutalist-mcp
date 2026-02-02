/**
 * Debate Tool Tests
 * Complete coverage of multi-agent debate functionality with constitutional position anchoring
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
        (brutalistServer as any).executeCLIDebate({
          topic: 'Should we migrate to microservices?',
          proPosition: 'Microservices provide scalability and team autonomy',
          conPosition: 'Monoliths are simpler and sufficient for most use cases',
          rounds: 2
        })
      ).rejects.toThrow('Need at least 2 CLI agents for debate');
    });

    it('should use exactly 2 agents with constitutional position anchoring', async () => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex', 'gemini'],
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

      await (brutalistServer as any).executeCLIDebate({
        topic: 'Should we adopt GraphQL?',
        proPosition: 'GraphQL provides flexible, efficient data fetching',
        conPosition: 'REST is simpler, better understood, and sufficient',
        rounds: 1
      });

      // Should have exactly 2 prompts (one per agent per round)
      expect(capturedPrompts).toHaveLength(2);

      // Check that prompts contain constitutional anchoring with explicit positions
      const proPrompt = capturedPrompts.find(p => p.includes('PRO position'));
      const conPrompt = capturedPrompts.find(p => p.includes('CON position'));

      expect(proPrompt).toBeDefined();
      expect(conPrompt).toBeDefined();

      // Verify constitutional rules are present
      expect(proPrompt).toContain('CONSTITUTIONAL RULES');
      expect(conPrompt).toContain('CONSTITUTIONAL RULES');
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
      const proPosition = 'A rewrite allows modern architecture and removes tech debt';
      const conPosition = 'Incremental refactoring is safer and preserves business logic';
      const context = 'Our current system has 10 years of technical debt';

      await (brutalistServer as any).executeCLIDebate({
        topic,
        proPosition,
        conPosition,
        rounds: 1,
        context
      });

      capturedPrompts.forEach(prompt => {
        expect(prompt).toContain(topic);
        expect(prompt).toContain(context);
      });

      // One prompt should have PRO position thesis
      const hasProThesis = capturedPrompts.some(p => p.includes(proPosition));
      expect(hasProThesis).toBe(true);

      // One prompt should have CON position thesis
      const hasConThesis = capturedPrompts.some(p => p.includes(conPosition));
      expect(hasConThesis).toBe(true);
    });

    it('should allow user to specify exactly 2 agents', async () => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex', 'gemini'],
      });

      let agentsCalled: string[] = [];
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        agentsCalled.push(agent);
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate({
        topic: 'User-specified agents test',
        proPosition: 'Pro position',
        conPosition: 'Con position',
        agents: ['codex', 'gemini'], // Explicitly specify 2 agents
        rounds: 1
      });

      // Should only call the specified agents
      expect(agentsCalled).toContain('codex');
      expect(agentsCalled).toContain('gemini');
      expect(agentsCalled).not.toContain('claude');
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

      const result = await (brutalistServer as any).executeCLIDebate({
        topic: 'GraphQL vs REST debate',
        proPosition: 'GraphQL is more efficient',
        conPosition: 'REST is simpler',
        rounds: 2
      });

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledTimes(4); // 2 agents * 2 rounds
      expect(result.success).toBe(true);
      expect(result.responses).toHaveLength(4);
    });

    it('should build confrontational context in subsequent rounds', async () => {
      let roundPrompts: string[] = [];

      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        roundPrompts.push(prompt);

        // Return different responses for each agent
        if (agent === 'claude') {
          return {
            agent,
            success: true,
            output: mockCLIResponses.claude.proPosition,
            executionTime: 100
          };
        } else {
          return {
            agent,
            success: true,
            output: mockCLIResponses.codex.contraPosition,
            executionTime: 100
          };
        }
      });

      await (brutalistServer as any).executeCLIDebate({
        topic: 'Microservices architecture decision',
        proPosition: 'Microservices enable scaling',
        conPosition: 'Monoliths are simpler',
        rounds: 2
      });

      // Round 2 prompts should contain opponent's previous arguments
      const round2Prompts = roundPrompts.filter(p => p.includes('Round 2'));
      expect(round2Prompts.length).toBeGreaterThan(0);

      round2Prompts.forEach(prompt => {
        // Should contain previous round context
        expect(prompt).toContain('OPPONENT');
      });
    });

    it('should maintain agent positions across rounds', async () => {
      let agentPositions: Map<string, string> = new Map();

      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        // Track positions from initial assignment
        if (prompt.includes('PRO position')) {
          agentPositions.set(agent, 'PRO');
        } else if (prompt.includes('CON position')) {
          agentPositions.set(agent, 'CON');
        }

        return {
          agent,
          success: true,
          output: `Position-consistent response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate({
        topic: 'Technology adoption strategy',
        proPosition: 'Early adoption gains competitive edge',
        conPosition: 'Proven technology reduces risk',
        rounds: 3
      });

      // Each agent should maintain the same position throughout
      expect(agentPositions.size).toBe(2);
      expect([...agentPositions.values()]).toContain('PRO');
      expect([...agentPositions.values()]).toContain('CON');
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

      const result = await (brutalistServer as any).executeCLIDebate({
        topic: 'Database migration strategy',
        proPosition: 'Migrate to new database',
        conPosition: 'Stay with current database',
        rounds: 2
      });

      expect(result.success).toBe(true); // Should succeed if at least one agent succeeds
      expect(result.responses.some((r: any) => r.success)).toBe(true);
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

      const result = await (brutalistServer as any).executeCLIDebate({
        topic: 'Failed debate topic',
        proPosition: 'Pro position',
        conPosition: 'Con position',
        rounds: 1
      });

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

      const result = await (brutalistServer as any).executeCLIDebate({
        topic: 'Empty response test',
        proPosition: 'Pro',
        conPosition: 'Con',
        rounds: 1
      });

      // Empty responses are technically successful executions, but may be treated as debate failures
      // The synthesis should still be generated even if content is empty
      expect(result.synthesis).toBeDefined();
      // The responses array should contain the execution results
      expect(result.responses).toBeDefined();
    });

    it('should handle maximum debate rounds', async () => {
      let executionCount = 0;
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        executionCount++;
        return {
          agent,
          success: true,
          output: `Response ${executionCount} from ${agent}`,
          executionTime: 100
        };
      });

      // Test maximum rounds (3 as per new design)
      const result = await (brutalistServer as any).executeCLIDebate({
        topic: 'Extended debate topic',
        proPosition: 'Pro position',
        conPosition: 'Con position',
        rounds: 3
      });

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledTimes(6); // 2 agents * 3 rounds
      expect(result.success).toBe(true);
      expect(result.responses).toHaveLength(6);
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

      await (brutalistServer as any).executeCLIDebate({
        topic: 'Timeout test topic',
        proPosition: 'Pro',
        conPosition: 'Con',
        rounds: 1
      });

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
        availableCLIs: ['claude', 'codex'],
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

      const result = await (brutalistServer as any).executeCLIDebate({
        topic: 'API versioning strategy',
        proPosition: 'Use URL versioning for clarity',
        conPosition: 'Use header versioning for cleaner URLs',
        rounds: 2,
        context: 'Legacy API needs updating'
      });

      expect(result.synthesis).toBeDefined();
      expect(result.synthesis).toContain('Brutalist CLI Agent Debate Results');
      expect(result.synthesis).toContain('API versioning strategy');
      expect(result.synthesis).toMatch(/\*\*Rounds:\*\*\s*2/);
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

      const result = await (brutalistServer as any).executeCLIDebate({
        topic: 'Container orchestration choice',
        proPosition: 'Kubernetes is the standard',
        conPosition: 'Docker Swarm is simpler',
        rounds: 1
      });

      expect(result.synthesis).toContain('CLAUDE');
      expect(result.synthesis).toContain('CODEX');
    });

    it('should handle synthesis of partial failures', async () => {
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        if (agent === 'codex') {
          return {
            agent,
            success: false,
            error: 'Codex execution failed',
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

      const result = await (brutalistServer as any).executeCLIDebate({
        topic: 'Partial failure test',
        proPosition: 'Pro',
        conPosition: 'Con',
        rounds: 1
      });

      expect(result.synthesis).toBeDefined();
      expect(result.synthesis).toContain('CLAUDE');
      // Should handle missing codex gracefully
    });
  });

  describe('Model Configuration', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex'],
      });
    });

    it('should pass model configurations to CLI execution', async () => {
      const models = {
        claude: 'opus',
        codex: 'gpt-5.1-codex-max'
      };

      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent: any, prompt: any, systemPrompt?: any, options?: any) => {
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate({
        topic: 'Model configuration test',
        proPosition: 'Pro',
        conPosition: 'Con',
        rounds: 1,
        models
      });

      // Verify model configurations were passed
      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        'claude',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          models: expect.objectContaining({ claude: 'opus' })
        })
      );

      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalledWith(
        'codex',
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          models: expect.objectContaining({ codex: 'gpt-5.1-codex-max' })
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

      await (brutalistServer as any).executeCLIDebate({
        topic: 'No model config test',
        proPosition: 'Pro',
        conPosition: 'Con',
        rounds: 1
      });

      // Should work without model configurations
      expect(mockOrchestrator.executeSingleCLI).toHaveBeenCalled();
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

      await (brutalistServer as any).executeCLIDebate({
        topic: 'Working directory test',
        proPosition: 'Pro',
        conPosition: 'Con',
        rounds: 1,
        workingDirectory: workingDir
      });

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

      await (brutalistServer as any).executeCLIDebate({
        topic: 'Default directory test',
        proPosition: 'Pro',
        conPosition: 'Con',
        rounds: 1
      });

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
        topic: 'Should we adopt microservices?',
        proPosition: 'Microservices enable scaling',
        conPosition: 'Monoliths are simpler',
        rounds: 1
      });

      // The response should be formatted and include context_id
      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Context ID');
    });

    it('should throw error when resume is true without context_id', async () => {
      const result = await (brutalistServer as any).handleDebateToolExecution({
        topic: 'Follow-up question',
        proPosition: 'Pro',
        conPosition: 'Con',
        resume: true
        // No context_id provided
      });

      expect(result.content[0].text).toContain('requires a \'context_id\'');
    });

    it('should throw error when resume is true with invalid context_id', async () => {
      const result = await (brutalistServer as any).handleDebateToolExecution({
        topic: 'Follow-up question',
        proPosition: 'Pro',
        conPosition: 'Con',
        resume: true,
        context_id: 'non-existent-id'
      });

      expect(result.content[0].text).toContain('not found in cache');
    });

    it('should cache debate results for pagination', async () => {
      // First call - creates cached result
      const firstResult = await (brutalistServer as any).handleDebateToolExecution({
        topic: 'Should we use GraphQL?',
        proPosition: 'GraphQL is flexible',
        conPosition: 'REST is simpler',
        rounds: 1
      });

      // Extract context_id from response
      const contextIdMatch = firstResult.content[0].text.match(/Context ID:\*\*\s*([a-f0-9-]+)/i);
      expect(contextIdMatch).toBeTruthy();
      const contextId = contextIdMatch![1];

      // Second call with same context_id (pagination) - should return cached
      const secondResult = await (brutalistServer as any).handleDebateToolExecution({
        topic: 'Should we use GraphQL?',
        proPosition: 'GraphQL is flexible',
        conPosition: 'REST is simpler',
        context_id: contextId,
        offset: 0
      });

      // Should return cached content without re-executing
      expect(secondResult.content[0].text).toBeDefined();
      // CLI should not have been called again for pagination
      const callCountBeforePagination = mockOrchestrator.executeSingleCLI.mock.calls.length;

      await (brutalistServer as any).handleDebateToolExecution({
        topic: 'Should we use GraphQL?',
        proPosition: 'GraphQL is flexible',
        conPosition: 'REST is simpler',
        context_id: contextId,
        offset: 1000
      });

      // No new CLI calls for pagination
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBe(callCountBeforePagination);
    });

    it('should support conversation continuation with resume flag', async () => {
      // Initial debate
      const initialResult = await (brutalistServer as any).handleDebateToolExecution({
        topic: 'Should we migrate to Kubernetes?',
        proPosition: 'K8s is the standard',
        conPosition: 'Simpler solutions exist',
        rounds: 1
      });

      const contextIdMatch = initialResult.content[0].text.match(/Context ID:\*\*\s*([a-f0-9-]+)/i);
      expect(contextIdMatch).toBeTruthy();
      const contextId = contextIdMatch![1];

      const callCountAfterInitial = mockOrchestrator.executeSingleCLI.mock.calls.length;

      // Continue the debate with resume flag
      const continuationResult = await (brutalistServer as any).handleDebateToolExecution({
        topic: 'What about the security implications?',
        proPosition: 'K8s has mature security',
        conPosition: 'Complexity increases attack surface',
        context_id: contextId,
        resume: true,
        rounds: 1
      });

      // Should have made new CLI calls for continuation
      expect(mockOrchestrator.executeSingleCLI.mock.calls.length).toBeGreaterThan(callCountAfterInitial);
      expect(continuationResult.content[0].text).toBeDefined();
    });

    it('should inject previous debate context when resuming', async () => {
      // Initial debate
      const initialResult = await (brutalistServer as any).handleDebateToolExecution({
        topic: 'REST vs GraphQL for our API',
        proPosition: 'GraphQL reduces overfetching',
        conPosition: 'REST is more cacheable',
        rounds: 1
      });

      const contextIdMatch = initialResult.content[0].text.match(/Context ID:\*\*\s*([a-f0-9-]+)/i);
      const contextId = contextIdMatch![1];

      // Clear mock calls to check new calls
      mockOrchestrator.executeSingleCLI.mockClear();

      // Continue with a follow-up
      await (brutalistServer as any).handleDebateToolExecution({
        topic: 'But what about caching strategies?',
        proPosition: 'GraphQL can use persisted queries',
        conPosition: 'HTTP caching is more mature',
        context_id: contextId,
        resume: true,
        rounds: 1
      });

      // Check that the prompts include previous debate context
      const calls = mockOrchestrator.executeSingleCLI.mock.calls;
      expect(calls.length).toBeGreaterThan(0);

      // At least one call should contain the previous debate context indicator
      const hasContextInjection = calls.some((call: any[]) => {
        const prompt = call[1] as string;
        return prompt.includes('Previous Debate Context') || prompt.includes('Follow-up');
      });
      expect(hasContextInjection).toBe(true);
    });

    it('should require topic when resume is true', async () => {
      // Initial debate
      const initialResult = await (brutalistServer as any).handleDebateToolExecution({
        topic: 'Initial debate topic',
        proPosition: 'Pro',
        conPosition: 'Con',
        rounds: 1
      });

      const contextIdMatch = initialResult.content[0].text.match(/Context ID:\*\*\s*([a-f0-9-]+)/i);
      const contextId = contextIdMatch![1];

      // Try to resume without topic
      const result = await (brutalistServer as any).handleDebateToolExecution({
        topic: '', // Empty topic
        proPosition: 'Pro',
        conPosition: 'Con',
        context_id: contextId,
        resume: true
      });

      expect(result.content[0].text).toContain('requires a new prompt');
    });
  });

  describe('Constitutional Position Anchoring', () => {
    beforeEach(() => {
      mockOrchestrator.detectCLIContext.mockResolvedValue({
        availableCLIs: ['claude', 'codex'],
      });
    });

    it('should include constitutional rules in every prompt', async () => {
      let capturedPrompts: string[] = [];
      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        capturedPrompts.push(prompt);
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate({
        topic: 'Test debate',
        proPosition: 'For the motion',
        conPosition: 'Against the motion',
        rounds: 1
      });

      // All prompts should contain constitutional rules
      capturedPrompts.forEach(prompt => {
        expect(prompt).toContain('CONSTITUTIONAL RULES');
        expect(prompt).toContain('MUST maintain your position');
        expect(prompt).toContain('MUST NOT agree to compromise');
      });
    });

    it('should embed explicit thesis in each agent prompt', async () => {
      let capturedPrompts: string[] = [];
      const proThesis = 'Functional programming leads to fewer bugs';
      const conThesis = 'OOP is more intuitive and maintainable';

      mockOrchestrator.executeSingleCLI.mockImplementation(async (agent, prompt) => {
        capturedPrompts.push(prompt);
        return {
          agent,
          success: true,
          output: `Response from ${agent}`,
          executionTime: 100
        };
      });

      await (brutalistServer as any).executeCLIDebate({
        topic: 'FP vs OOP',
        proPosition: proThesis,
        conPosition: conThesis,
        rounds: 1
      });

      // One prompt should contain the PRO thesis
      const proPrompt = capturedPrompts.find(p => p.includes(proThesis));
      expect(proPrompt).toBeDefined();
      expect(proPrompt).toContain('YOUR THESIS');

      // One prompt should contain the CON thesis
      const conPrompt = capturedPrompts.find(p => p.includes(conThesis));
      expect(conPrompt).toBeDefined();
      expect(conPrompt).toContain('YOUR THESIS');
    });
  });
});
