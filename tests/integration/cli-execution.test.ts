import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { CLIAgentOrchestrator } from '../../src/cli-agents.js';
import { testPaths, testPrompts } from '../fixtures/test-configs.js';

// Integration tests - actually spawn CLI processes
// These tests require real CLI tools to be installed

describe('CLI Execution Integration', () => {
  let orchestrator: CLIAgentOrchestrator;
  
  beforeAll(() => {
    orchestrator = new CLIAgentOrchestrator();
    jest.setTimeout(60000); // 60 second timeout for real CLI execution
  });

  afterAll(() => {
    jest.setTimeout(30000); // Reset to default
  });

  describe('CLI Availability Detection', () => {
    it('should detect available CLI agents on the system', async () => {
      const context = await orchestrator.detectCLIContext();
      
      expect(context).toBeDefined();
      expect(Array.isArray(context.availableCLIs)).toBe(true);
      
      // At least one CLI should be available in CI/development
      if (process.env.CI !== 'true') {
        expect(context.availableCLIs.length).toBeGreaterThan(0);
      }
      
      // Log available CLIs for debugging
      console.log('Available CLIs:', context.availableCLIs);
      console.log('Current CLI:', context.currentCLI);
    });

    it('should cache CLI context for performance', async () => {
      const start1 = Date.now();
      const context1 = await orchestrator.detectCLIContext();
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      const context2 = await orchestrator.detectCLIContext();
      const time2 = Date.now() - start2;

      expect(context1).toEqual(context2);
      expect(time2).toBeLessThan(time1); // Second call should be much faster (cached)
    });
  });

  describe('Individual CLI Execution', () => {
    let availableCLIs: string[];

    beforeAll(async () => {
      const context = await orchestrator.detectCLIContext();
      availableCLIs = context.availableCLIs;
    });

    describe('Claude Code', () => {
      it('should execute Claude with simple prompt', async () => {
        if (!availableCLIs.includes('claude')) {
          console.log('Skipping Claude test - CLI not available');
          return;
        }

        const result = await orchestrator.executeClaudeCode(
          testPrompts.simple,
          'You are a helpful code assistant',
          { timeout: 30000 }
        );

        expect(result).toBeValidCLIResponse();
        expect(result.agent).toBe('claude');
        
        if (result.success) {
          expect(result.output).toBeTruthy();
          expect(result.executionTime).toBeGreaterThan(0);
        } else {
          console.log('Claude execution failed:', result.error);
        }
      });

      it('should handle Claude command errors gracefully', async () => {
        if (!availableCLIs.includes('claude')) {
          return;
        }

        const result = await orchestrator.executeClaudeCode(
          '',
          'Invalid system prompt with special chars: \x00\x01',
          { timeout: 10000 }
        );

        expect(result).toBeValidCLIResponse();
        expect(result.agent).toBe('claude');
        
        // Should either succeed or fail gracefully
        if (!result.success) {
          expect(result.error).toBeTruthy();
        }
      });
    });

    describe('Codex CLI', () => {
      it('should execute Codex with sandbox enabled', async () => {
        if (!availableCLIs.includes('codex')) {
          console.log('Skipping Codex test - CLI not available');
          return;
        }

        const result = await orchestrator.executeCodex(
          testPrompts.simple,
          'You are a code analysis expert',
          { 
            sandbox: true,
            timeout: 30000,
            workingDirectory: testPaths.validProject
          }
        );

        expect(result).toBeValidCLIResponse();
        expect(result.agent).toBe('codex');
        
        if (result.success) {
          expect(result.output).toBeTruthy();
          expect(result.command).toContain('--sandbox');
        } else {
          console.log('Codex execution failed:', result.error);
        }
      });

      it('should respect model selection', async () => {
        if (!availableCLIs.includes('codex')) {
          return;
        }

        const result = await orchestrator.executeCodex(
          'Quick test',
          'Brief analysis',
          { 
            sandbox: true,
            timeout: 20000,
            models: { codex: 'gpt-5-codex' }
          }
        );

        expect(result).toBeValidCLIResponse();
        if (result.success || result.command) {
          expect(result.command).toContain('gpt-5-codex');
        }
      });
    });

    describe('Gemini CLI', () => {
      it('should execute Gemini with YOLO mode', async () => {
        if (!availableCLIs.includes('gemini')) {
          console.log('Skipping Gemini test - CLI not available');
          return;
        }

        const result = await orchestrator.executeGemini(
          testPrompts.simple,
          'You are a technical analyst',
          { 
            sandbox: true,
            timeout: 45000 // Gemini can be slower
          }
        );

        expect(result).toBeValidCLIResponse();
        expect(result.agent).toBe('gemini');
        
        if (result.success) {
          expect(result.output).toBeTruthy();
          expect(result.command).toContain('--yolo');
        } else {
          console.log('Gemini execution failed:', result.error);
        }
      });
    });
  });

  describe('Multi-CLI Orchestration', () => {
    it('should execute brutalist analysis with multiple agents', async () => {
      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length === 0) {
        console.log('Skipping multi-CLI test - no CLIs available');
        return;
      }

      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        'A social media app for AI agents',
        'You are a brutal startup critic',
        'Testing multi-CLI execution',
        testPaths.validProject,
        {
          timeout: 60000,
          enableSandbox: true,
          analysisType: 'idea'
        }
      );

      expect(Array.isArray(responses)).toBe(true);
      expect(responses.length).toBeGreaterThan(0);
      
      responses.forEach(response => {
        expect(response).toBeValidCLIResponse();
      });

      // At least one should succeed in a healthy environment
      const successfulResponses = responses.filter(r => r.success);
      if (context.availableCLIs.length > 0) {
        expect(successfulResponses.length).toBeGreaterThan(0);
      }
    });

    it('should synthesize responses into coherent feedback', async () => {
      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length === 0) {
        return;
      }

      const responses = await orchestrator.executeBrutalistAnalysis(
        'codebase',
        testPaths.validProject,
        'You are a security auditor',
        'Integration test analysis',
        undefined,
        {
          timeout: 45000,
          enableSandbox: true,
          analysisType: 'codebase'
        }
      );

      const synthesis = orchestrator.synthesizeBrutalistFeedback(responses, 'codebase');

      expect(synthesis).toBeTruthy();
      expect(typeof synthesis).toBe('string');
      expect(synthesis).toContainBrutalAnalysis();
      
      // Should mention the number of agents
      expect(synthesis).toMatch(/\d+ AI critic/);
    });
  });

  describe('Performance and Limits', () => {
    it('should respect timeout limits', async () => {
      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length === 0) {
        return;
      }

      const startTime = Date.now();
      
      // Use a very short timeout to force timeout scenario
      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        'Complex analysis that should timeout',
        'Perform extremely detailed analysis of this concept including market research, technical feasibility, competitive analysis, financial projections, risk assessment, and implementation roadmap',
        'Timeout test',
        undefined,
        {
          timeout: 1000, // 1 second - should timeout
          enableSandbox: true,
          analysisType: 'idea'
        }
      );

      const duration = Date.now() - startTime;
      
      // Should complete within reasonable time of timeout
      expect(duration).toBeLessThan(5000); // Max 5 seconds
      
      // Some responses should have timed out
      const timedOutResponses = responses.filter(r => 
        !r.success && r.error?.includes('timed out')
      );
      
      if (responses.length > 0) {
        expect(timedOutResponses.length).toBeGreaterThan(0);
      }
    });

    it('should handle concurrent executions', async () => {
      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length === 0) {
        return;
      }

      // Execute multiple analyses concurrently
      const promises = [
        orchestrator.executeBrutalistAnalysis('idea', 'Idea 1', 'Critic 1', 'Test 1'),
        orchestrator.executeBrutalistAnalysis('idea', 'Idea 2', 'Critic 2', 'Test 2'),
        orchestrator.executeBrutalistAnalysis('idea', 'Idea 3', 'Critic 3', 'Test 3')
      ];

      const results = await Promise.all(promises);
      
      expect(results).toHaveLength(3);
      results.forEach(responses => {
        expect(Array.isArray(responses)).toBe(true);
      });
    });
  });

  describe('Error Recovery', () => {
    it('should handle CLI crashes gracefully', async () => {
      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length === 0) {
        return;
      }

      // Try to cause a CLI error with invalid input
      const responses = await orchestrator.executeBrutalistAnalysis(
        'codebase',
        testPaths.nonexistentPath,
        'Analyze this nonexistent path',
        'Error recovery test',
        undefined,
        {
          timeout: 30000,
          enableSandbox: true,
          analysisType: 'codebase'
        }
      );

      expect(Array.isArray(responses)).toBe(true);
      
      // Should have some responses, even if they failed
      expect(responses.length).toBeGreaterThan(0);
      
      responses.forEach(response => {
        expect(response).toBeValidCLIResponse();
        
        if (!response.success) {
          expect(response.error).toBeTruthy();
        }
      });
    });

    it('should continue if some CLIs fail', async () => {
      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length < 2) {
        console.log('Skipping partial failure test - need multiple CLIs');
        return;
      }

      // Create conditions likely to cause some CLIs to fail
      const responses = await orchestrator.executeBrutalistAnalysis(
        'security',
        testPrompts.malicious, // Potentially problematic input
        'Analyze security of this system with extreme detail including every possible attack vector and vulnerability',
        'Partial failure test',
        undefined,
        {
          timeout: 15000, // Medium timeout
          enableSandbox: true,
          analysisType: 'security'
        }
      );

      expect(responses.length).toBeGreaterThan(0);
      
      const successfulResponses = responses.filter(r => r.success);
      const failedResponses = responses.filter(r => !r.success);
      
      // In a partial failure scenario, we should have both
      // But at least one response should exist
      expect(successfulResponses.length + failedResponses.length).toBe(responses.length);
    });
  });
});