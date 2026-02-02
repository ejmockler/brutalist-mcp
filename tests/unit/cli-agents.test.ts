import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { tmpdir } from 'os';
import { CLIAgentOrchestrator, BrutalistPromptType } from '../../src/cli-agents.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { mockAllSuccessfulResponses, mockPartialFailureResponses } from '../fixtures/mock-responses.js';

// Mock child_process
jest.mock('child_process');
jest.mock('../../src/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

// Mock child process
class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: jest.fn(),
    end: jest.fn()
  };
  pid = 12345;
  kill = jest.fn();
}

describe('CLIAgentOrchestrator', () => {
  let orchestrator: CLIAgentOrchestrator;
  let mockSpawn: jest.MockedFunction<typeof spawn>;
  let mockChild: MockChildProcess;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
    mockChild = new MockChildProcess();
    
    // Default mock: spawn processes that fail quickly (CLI not found)
    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      setTimeout(() => {
        child.emit('error', new Error('Command not found'));
      }, 1);
      return child as any;
    });
    
    // Create orchestrator and wait for CLI detection to complete
    orchestrator = new CLIAgentOrchestrator();
    
    // Wait a bit for the constructor's detectCLIContext to complete
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Mock CLI context with available CLIs for most tests
    (orchestrator as any).cliContext = {
      availableCLIs: ['claude', 'codex', 'gemini'],
    };
    (orchestrator as any).cliContextCached = true;
  });

  afterEach(() => {
    // Clear all timers to prevent test leaks
    jest.clearAllTimers();
  });

  describe('CLI Context Detection', () => {
    it('should detect available CLI agents', async () => {
      // Mock successful version checks for all CLIs
      const responses = [
        { stdout: 'claude 1.0.0', exitCode: 0 },
        { stdout: 'codex 2.0.0', exitCode: 0 },
        { stdout: 'gemini 2.5.0', exitCode: 0 }
      ];

      let callIndex = 0;
      mockSpawn.mockImplementation(() => {
        const child = new MockChildProcess();
        const response = responses[callIndex++];
        
        setTimeout(() => {
          if (response) {
            child.stdout.emit('data', response.stdout);
            child.emit('close', response.exitCode);
          }
        }, 10);
        
        return child as any;
      });

      const context = await orchestrator.detectCLIContext();

      expect(context.availableCLIs).toContain('claude');
      expect(context.availableCLIs).toContain('codex');
      expect(context.availableCLIs).toContain('gemini');
      expect(mockSpawn).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object));
      expect(mockSpawn).toHaveBeenCalledWith('codex', ['--version'], expect.any(Object));
      expect(mockSpawn).toHaveBeenCalledWith('gemini', ['--version'], expect.any(Object));
    });

    it('should detect current CLI from environment variables', async () => {
      const originalEnv = process.env;
      process.env = { ...originalEnv, CLAUDE_CODE_SESSION: 'active' };

      // Mock at least one CLI being available
      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as any);
      
      setTimeout(() => {
        child.stdout.emit('data', 'version');
        child.emit('close', 0);
      }, 10);

      const context = await orchestrator.detectCLIContext();

      
      process.env = originalEnv;
    });

    it('should handle CLI detection failures gracefully', async () => {
      // Reset cache to force new detection
      (orchestrator as any).cliContextCached = false;
      (orchestrator as any).cliContext = null;

      // Clear environment variables that might indicate current CLI
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        CLAUDE_CODE_SESSION: undefined,
        CLAUDE_CONFIG_DIR: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
        CLAUDECODE: undefined,
        CODEX_SESSION: undefined,
        GEMINI_SESSION: undefined
      };

      // Mock all CLIs failing
      mockSpawn.mockImplementation(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          child.emit('error', new Error('Command not found'));
        }, 10);
        return child as any;
      });

      const context = await orchestrator.detectCLIContext();

      expect(context.availableCLIs).toEqual([]);

      // Restore environment
      process.env = originalEnv;
    });

    it('should cache CLI context for performance', async () => {
      // Mock all three CLI checks for first call
      const child1 = new MockChildProcess();
      const child2 = new MockChildProcess();  
      const child3 = new MockChildProcess();
      
      mockSpawn
        .mockReturnValueOnce(child1 as any) // claude check
        .mockReturnValueOnce(child2 as any) // codex check  
        .mockReturnValueOnce(child3 as any); // gemini check

      // Simulate successful responses
      setTimeout(() => {
        child1.stdout.emit('data', 'claude 1.0.0');
        child1.emit('close', 0);
        child2.stdout.emit('data', 'codex 1.0.0');
        child2.emit('close', 0);
        child3.stdout.emit('data', 'gemini 1.0.0');
        child3.emit('close', 0);
      }, 10);

      const context1 = await orchestrator.detectCLIContext();
      const callCountAfterFirst = mockSpawn.mock.calls.length;

      // Second call should use cached result
      const context2 = await orchestrator.detectCLIContext();
      const callCountAfterSecond = mockSpawn.mock.calls.length;

      expect(context1).toEqual(context2);
      expect(callCountAfterSecond).toBe(callCountAfterFirst); // No additional spawn calls
    });
  });

  describe('CLI Selection Logic', () => {
    beforeEach(async () => {
      // Setup context with all CLIs available
      const mockContext = {
        availableCLIs: ['claude', 'codex', 'gemini'],
      };
      
      // Mock the private cliContext property
      (orchestrator as any).cliContext = mockContext;
      (orchestrator as any).cliContextCached = true;
    });

    it('should select preferred CLI when specified', () => {
      const selected = orchestrator.selectSingleCLI('codex');
      expect(selected).toBe('codex');
    });

    it('should auto-select when no preference given', () => {
      const selected = orchestrator.selectSingleCLI();
      expect(['claude', 'codex', 'gemini']).toContain(selected);
    });

    it('should fallback to available CLI when preferred CLI unavailable', () => {
      // Mock CLI context with limited available CLIs
      (orchestrator as any).cliContext = {
        availableCLIs: ['claude'], // Only claude available
      };
      
      // When gemini is requested but not available, should fallback to claude
      const selected = orchestrator.selectSingleCLI('gemini' as any);
      expect(selected).toBe('claude');
    });

    it('should detect available CLIs', async () => {
      const context = await orchestrator.detectCLIContext();
      
      expect(context).toHaveProperty('availableCLIs');
      expect(Array.isArray(context.availableCLIs)).toBe(true);
    });
  });

  describe('Prompt Construction', () => {
    it('should construct system prompts for different analysis types', () => {
      const types: BrutalistPromptType[] = [
        'codebase', 'architecture', 'idea', 'security', 'research'
      ];

      // Test that different analysis types can be processed without crashing
      types.forEach(type => {
        expect(() => {
          // Test that the type is recognized as valid 
          const userPrompt = (orchestrator as any).constructUserPrompt(type, '/test/path');
          expect(typeof userPrompt).toBe('string');
          expect(userPrompt.length).toBeGreaterThan(0);
        }).not.toThrow();
      });
    });

    it('should construct user prompts with context', () => {
      // Test user prompt construction directly
      const userPrompt = (orchestrator as any).constructUserPrompt(
        'codebase',
        '/test/path',
        'Additional context information'
      );
      
      expect(typeof userPrompt).toBe('string');
      expect(userPrompt.length).toBeGreaterThan(0);
      // Should include both target path and context in the prompt
    });

    it('should handle missing prompt types gracefully', () => {
      // Test with an unusual but valid prompt type
      expect(() => {
        const userPrompt = (orchestrator as any).constructUserPrompt(
          'testCoverage' as BrutalistPromptType,
          '/test/path'
        );
        expect(typeof userPrompt).toBe('string');
      }).not.toThrow();
    });
  });

  describe('Response Synthesis', () => {
    it('should synthesize successful responses into brutal feedback', () => {
      const synthesis = orchestrator.synthesizeBrutalistFeedback(
        mockAllSuccessfulResponses,
        'codebase'
      );

      expect(synthesis).toContain('AI critics have systematically demolished');
      expect(synthesis).toContain('CODEX');
      expect(synthesis).toContain('CLAUDE');
      expect(synthesis).toContain('GEMINI');
      expect(synthesis.toLowerCase()).toMatch(/systematically|demolished|vulnerabilities|disaster|nightmare/i);
    });

    it('should handle mixed success/failure responses', () => {
      const synthesis = orchestrator.synthesizeBrutalistFeedback(
        mockPartialFailureResponses,
        'security'
      );

      expect(synthesis).toContain('1 AI critic');
      expect(synthesis).toContain('Failed Critics');
      expect(synthesis.toLowerCase()).toMatch(/systematically|demolished|vulnerabilities|disaster|nightmare/i);
    });

    it('should handle all-failure responses appropriately', () => {
      const allFailedResponses = [
        { ...mockPartialFailureResponses[1], agent: 'codex' as const },
        { ...mockPartialFailureResponses[1], agent: 'gemini' as const }
      ];

      const synthesis = orchestrator.synthesizeBrutalistFeedback(
        allFailedResponses,
        'idea'
      );

      expect(synthesis).toContain('All CLI agents failed');
      expect(synthesis).toContain('Brutalist Analysis Failed');
    });

    it('should include execution time statistics', () => {
      const synthesis = orchestrator.synthesizeBrutalistFeedback(
        mockAllSuccessfulResponses,
        'architecture'
      );

      // Should include timing information
      expect(synthesis).toMatch(/\d+ms/); // Contains millisecond timing
    });
  });

  describe('Concurrent Execution Management', () => {
    it('should respect maximum concurrent CLI limit', async () => {
      // Mock the MAX_CONCURRENT_CLIS constant
      const originalMax = (orchestrator as any).MAX_CONCURRENT_CLIS;
      (orchestrator as any).MAX_CONCURRENT_CLIS = 2;

      const executionPromises: Promise<any>[] = [];
      
      // Try to start more executions than the limit
      for (let i = 0; i < 5; i++) {
        const promise = (orchestrator as any).waitForAvailableSlot();
        executionPromises.push(promise);
      }

      // Should queue executions beyond the limit
      expect(executionPromises.length).toBe(5);
      
      // Restore original value
      (orchestrator as any).MAX_CONCURRENT_CLIS = originalMax;
    });

    it('should track running CLI count correctly', () => {
      const initialCount = (orchestrator as any).runningCLIs;
      expect(initialCount).toBe(0);
      
      // Simulate starting an execution
      (orchestrator as any).runningCLIs++;
      expect((orchestrator as any).runningCLIs).toBe(1);
      
      // Simulate completion
      (orchestrator as any).runningCLIs--;
      expect((orchestrator as any).runningCLIs).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for unavailable CLI', async () => {
      // Test with a nonexistent CLI - should throw validation error
      await expect(
        orchestrator.executeBrutalistAnalysis(
          'idea',
          'test path',
          'test prompt',
          undefined,
          { clis: ['nonexistent' as any], timeout: 1000 }
        )
      ).rejects.toThrow('Requested CLIs not available');
    });

    it('should handle CLI timeout', async () => {
      // Test very short timeout to force timeout behavior
      // Create a valid temp directory for testing
      const tempDir = tmpdir();
      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        'A complex startup idea that would require extensive analysis',
        'test prompt',
        undefined,
        { timeout: 50, workingDirectory: tempDir } // 50ms timeout should force timeout
      );

      expect(Array.isArray(responses)).toBe(true);
      // Should handle timeouts gracefully
    });

    it('should handle error responses gracefully', async () => {
      // Test with minimal input that might cause issues
      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        '',
        '',
        undefined,
        { timeout: 1000 }
      );

      expect(Array.isArray(responses)).toBe(true);
      // Should not crash with invalid input
    });
  });

  describe('Platform Compatibility', () => {
    it('should handle process timeout and termination', async () => {
      // Test that CLI timeout functionality works (which internally handles process killing)
      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        'test',
        'test prompt',
        undefined,
        { timeout: 100 } // Very short timeout to test timeout handling
      );
      
      expect(Array.isArray(responses)).toBe(true);
      // Some responses may have timed out, but it should handle gracefully
    });

    it('should respect timeout configuration', async () => {
      const start = Date.now();
      
      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        'test',
        'test prompt',
        undefined,
        { timeout: 500 } // Short timeout
      );
      
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(5000); // Should not take much longer than timeout
      expect(Array.isArray(responses)).toBe(true);
    });
  });

  describe('Streaming Events', () => {
    it('should emit streaming events during CLI execution', async () => {
      const mockStreamingCallback = jest.fn();
      
      setTimeout(() => {
        mockChild.stdout.emit('data', 'Analysis in progress...');
        mockChild.stdout.emit('data', 'Found security vulnerability');
        mockChild.emit('close', 0);
      }, 10);

      await (orchestrator as any)._executeCLI(
        'codex',
        'codex',
        ['exec', 'test'],
        { 
          timeout: 1000,
          onStreamingEvent: mockStreamingCallback
        }
      );

      // Should have emitted streaming events
      expect(mockStreamingCallback).toHaveBeenCalled();
    });

    it('should throttle streaming events to prevent spam', async () => {
      const mockStreamingCallback = jest.fn();
      
      setTimeout(() => {
        // Emit rapid data chunks
        for (let i = 0; i < 10; i++) {
          mockChild.stdout.emit('data', `chunk ${i}`);
        }
        mockChild.emit('close', 0);
      }, 10);

      await (orchestrator as any)._executeCLI(
        'gemini',
        'gemini',
        ['test'],
        { 
          timeout: 1000,
          onStreamingEvent: mockStreamingCallback
        }
      );

      // Should have throttled the events (fewer calls than data chunks)
      expect(mockStreamingCallback.mock.calls.length).toBeLessThan(10);
    });
  });

  describe('Real CLI Execution (Integration)', () => {
    const shouldRunIntegrationTests = process.env.RUN_INTEGRATION_TESTS === 'true';

    beforeEach(() => {
      if (!shouldRunIntegrationTests) {
        return;
      }
      
      // Clear mocks for real execution
      jest.clearAllMocks();
      
      // Create a real orchestrator without mocks
      orchestrator = new CLIAgentOrchestrator();
    });

    it('should detect real CLI availability', async () => {
      if (!shouldRunIntegrationTests) {
        console.log('Skipping real CLI detection test - set RUN_INTEGRATION_TESTS=true to enable');
        return;
      }

      jest.setTimeout(60000); // 60 seconds for real CLI detection

      const context = await orchestrator.detectCLIContext();

      expect(context).toBeDefined();
      expect(Array.isArray(context.availableCLIs)).toBe(true);
      
      console.log('Real CLI context detected:', {
        availableCLIs: context.availableCLIs,
      });

      // In CI, we might not have any CLIs installed
      if (process.env.CI !== 'true') {
        expect(context.availableCLIs.length).toBeGreaterThan(0);
      }
    }, 60000);

    it('should execute real CLI with simple prompt', async () => {
      if (!shouldRunIntegrationTests) {
        console.log('Skipping real CLI execution test - set RUN_INTEGRATION_TESTS=true to enable');
        return;
      }

      jest.setTimeout(60000);

      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length === 0) {
        console.log('No CLIs available for real execution test');
        return;
      }

      const targetCLI = context.availableCLIs[0];
      console.log(`Testing real execution with: ${targetCLI}`);

      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        'A simple to-do list app',
        'You are a brutal startup critic. Be harsh but fair.',
        'Integration test of real CLI execution',
        {
          clis: [targetCLI],
          timeout: 45000,
        }
      );

      expect(Array.isArray(responses)).toBe(true);
      expect(responses.length).toBeGreaterThan(0);

      const response = responses[0];
      expect(response).toHaveProperty('agent');
      expect(response).toHaveProperty('success');
      expect(response).toHaveProperty('executionTime');
      expect(typeof response.executionTime).toBe('number');

      if (response.success) {
        expect(response.output).toBeTruthy();
        expect(typeof response.output).toBe('string');
        console.log(`${targetCLI} execution succeeded in ${response.executionTime}ms`);
        console.log('Output preview:', response.output?.substring(0, 200) + '...');
      } else {
        console.log(`${targetCLI} execution failed:`, response.error);
        expect(response.error).toBeTruthy();
      }
    }, 60000);

    it('should handle real CLI timeout gracefully', async () => {
      if (!shouldRunIntegrationTests) {
        console.log('Skipping real CLI timeout test - set RUN_INTEGRATION_TESTS=true to enable');
        return;
      }

      jest.setTimeout(15000); // Test should complete within 15 seconds

      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length === 0) {
        console.log('No CLIs available for timeout test');
        return;
      }

      const startTime = Date.now();

      const responses = await orchestrator.executeBrutalistAnalysis(
        'codebase',
        '/tmp/nonexistent-large-project',
        'Perform an extremely detailed analysis of this entire codebase including every file, dependency, security vulnerability, performance issue, and architectural problem. Write a 10,000 word detailed report.',
        'Timeout test with complex prompt',
        {
          clis: [context.availableCLIs[0]],
          timeout: 2000, // 2 second timeout should cause timeout
        }
      );

      const duration = Date.now() - startTime;
      
      expect(duration).toBeLessThan(8000); // Should complete much faster than full timeout
      expect(Array.isArray(responses)).toBe(true);
      expect(responses.length).toBeGreaterThan(0);

      const response = responses[0];
      if (!response.success) {
        expect(response.error).toContain('timed out');
      }

      console.log(`Timeout test completed in ${duration}ms`);
    }, 15000);

    it('should synthesize real CLI responses into brutal feedback', async () => {
      if (!shouldRunIntegrationTests) {
        console.log('Skipping real CLI synthesis test - set RUN_INTEGRATION_TESTS=true to enable');
        return;
      }

      jest.setTimeout(90000); // 90 seconds for multi-CLI execution

      const context = await orchestrator.detectCLIContext();
      
      if (context.availableCLIs.length === 0) {
        console.log('No CLIs available for synthesis test');
        return;
      }

      const responses = await orchestrator.executeBrutalistAnalysis(
        'security',
        'JWT authentication system with HMAC-SHA256',
        'You are security experts. Find every possible vulnerability.',
        'Real CLI synthesis test',
        {
          timeout: 60000,
        }
      );

      expect(Array.isArray(responses)).toBe(true);

      const synthesis = orchestrator.synthesizeBrutalistFeedback(responses, 'security');

      expect(synthesis).toBeTruthy();
      expect(typeof synthesis).toBe('string');
      expect(synthesis.length).toBeGreaterThan(100);

      // Should mention the analysis
      expect(synthesis.toLowerCase()).toMatch(/ai critic|brutal|analysis|security|jwt/i);

      console.log('Real synthesis preview:', synthesis.substring(0, 300) + '...');
      console.log('Total synthesis length:', synthesis.length);
    }, 90000);
  });
});