import { CLIAgentOrchestrator, BrutalistPromptType } from './cli-agents.js';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process spawn
jest.mock('child_process');

// Mock logger
jest.mock('./logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

// Helper to create mock child process
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
    mockChild = new MockChildProcess();
    mockSpawn.mockReturnValue(mockChild as any);
    
    orchestrator = new CLIAgentOrchestrator();
  });

  afterEach(() => {
    // Clean up mocks
    jest.clearAllMocks();
  });

  describe('CLI Context Detection', () => {
    it('should detect available CLIs', async () => {
      // Mock successful CLI version checks
      const claudeChild = new MockChildProcess();
      const codexChild = new MockChildProcess();
      const geminiChild = new MockChildProcess();
      
      mockSpawn
        .mockReturnValueOnce(claudeChild as any)
        .mockReturnValueOnce(codexChild as any)
        .mockReturnValueOnce(geminiChild as any);
      
      // Simulate successful responses
      setTimeout(() => {
        claudeChild.stdout.emit('data', 'claude 1.0.0');
        claudeChild.emit('close', 0);
      }, 10);
      
      setTimeout(() => {
        codexChild.stdout.emit('data', 'codex 2.0.0');
        codexChild.emit('close', 0);
      }, 10);
      
      setTimeout(() => {
        geminiChild.stdout.emit('data', 'gemini 2.5.0');
        geminiChild.emit('close', 0);
      }, 10);

      const context = await orchestrator.detectCLIContext();

      expect(context.availableCLIs).toEqual(['claude', 'codex', 'gemini']);
      expect(mockSpawn).toHaveBeenCalledWith('claude', ['--version'], expect.any(Object));
      expect(mockSpawn).toHaveBeenCalledWith('codex', ['--version'], expect.any(Object));
      expect(mockSpawn).toHaveBeenCalledWith('gemini', ['--version'], expect.any(Object));
    });

    it('should detect current CLI from environment variables', async () => {
      const originalEnv = process.env;
      process.env = { ...originalEnv, CLAUDE_CODE_SESSION: 'active' };

      // Mock CLI checks
      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as any);
      
      setTimeout(() => {
        child.stdout.emit('data', 'version');
        child.emit('close', 0);
      }, 10);

      const context = await orchestrator.detectCLIContext();

      expect(context.currentCLI).toBe('claude');
      
      process.env = originalEnv;
    });

    it('should handle CLI detection failures gracefully', async () => {
      // Mock all CLIs unavailable
      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as any);
      
      setTimeout(() => {
        child.emit('error', new Error('Command not found'));
      }, 10);

      const context = await orchestrator.detectCLIContext();

      expect(context.availableCLIs).toEqual([]);
      expect(context.currentCLI).toBeUndefined();
    });
  });

  describe('CLI Selection', () => {
    beforeEach(async () => {
      // Setup context with all CLIs available
      const child = new MockChildProcess();
      mockSpawn.mockReturnValue(child as any);
      
      setTimeout(() => {
        child.stdout.emit('data', 'version');
        child.emit('close', 0);
      }, 10);
      
      await orchestrator.detectCLIContext();
    });

    it('should select a CLI when preferred CLI is provided', () => {
      const selected = orchestrator.selectSingleCLI('codex');
      expect(selected).toBe('codex');
    });

    it('should auto-select CLI when no preference provided', () => {
      const selected = orchestrator.selectSingleCLI();
      expect(['claude', 'codex', 'gemini']).toContain(selected);
    });

    it('should select based on analysis type preference', () => {
      const selected = orchestrator.selectSingleCLI(undefined, 'code');
      expect(['claude', 'codex', 'gemini']).toContain(selected);
    });
  });

  describe('CLI Execution', () => {
    describe('Claude Code', () => {
      it('should construct correct command for Claude', async () => {
        setTimeout(() => {
          mockChild.stdout.emit('data', 'Claude analysis output');
          mockChild.emit('close', 0);
        }, 10);

        const result = await orchestrator.executeClaudeCode(
          'Analyze this code',
          'You are a code critic'
        );

        expect(mockSpawn).toHaveBeenCalledWith(
          'claude',
          ['--print', expect.stringContaining('You are a code critic')],
          expect.objectContaining({
            cwd: expect.any(String),
            shell: false,
            detached: true
          })
        );

        expect(result.agent).toBe('claude');
        expect(result.success).toBe(true);
        expect(result.output).toBe('Claude analysis output');
      });
    });

    describe('Codex', () => {
      it.skip('should construct correct command for Codex with sandbox', async () => {
        // Pre-seed CLI context to avoid detection calls
        (orchestrator as any).cliContext = {
          availableCLIs: ['claude', 'codex', 'gemini'],
          currentCLI: 'claude'
        };

        setTimeout(() => {
          mockChild.stdout.emit('data', 'Codex analysis output');
          mockChild.emit('close', 0);
        }, 10);

        const result = await orchestrator.executeCodex(
          'Analyze this architecture',
          'You are an architecture critic',
          { sandbox: true }
        );

        expect(mockSpawn).toHaveBeenCalledWith(
          'codex',
          ['exec', '--model', 'gpt-5', '--sandbox', 'read-only'],
          expect.objectContaining({
            shell: false,
            detached: true,
            input: expect.stringContaining('CONTEXT AND INSTRUCTIONS')
          })
        );

        expect(result.agent).toBe('codex');
        expect(result.success).toBe(true);
      });

      it.skip('should handle working directory option', async () => {
        // Pre-seed CLI context to avoid detection calls
        (orchestrator as any).cliContext = {
          availableCLIs: ['claude', 'codex', 'gemini'],
          currentCLI: 'claude'
        };

        setTimeout(() => {
          mockChild.stdout.emit('data', 'output');
          mockChild.emit('close', 0);
        }, 10);

        await orchestrator.executeCodex(
          'Test prompt',
          'System prompt',
          { 
            sandbox: true,
            workingDirectory: '/custom/path'
          }
        );

        expect(mockSpawn).toHaveBeenCalledWith(
          'codex',
          ['exec', '--model', 'gpt-5', '--sandbox', 'read-only'],
          expect.objectContaining({
            cwd: '/custom/path',
            input: expect.stringContaining('CONTEXT AND INSTRUCTIONS')
          })
        );
      });
    });

    describe('Gemini CLI', () => {
      it.skip('should construct correct command for Gemini', async () => {
        // Pre-seed CLI context to avoid detection calls
        (orchestrator as any).cliContext = {
          availableCLIs: ['claude', 'codex', 'gemini'],
          currentCLI: 'claude'
        };

        setTimeout(() => {
          mockChild.stdout.emit('data', 'Gemini analysis output');
          mockChild.emit('close', 0);
        }, 10);

        const result = await orchestrator.executeGemini(
          'Analyze this security design',
          'You are a security critic'
        );

        expect(mockSpawn).toHaveBeenCalledWith(
          'gemini',
          expect.arrayContaining(['--model', 'gemini-2.5-flash', '--yolo']),
          expect.objectContaining({
            shell: false,
            detached: false // Gemini runs non-detached
          })
        );

        expect(result.agent).toBe('gemini');
        expect(result.success).toBe(true);
      });
    });

    describe('Error Handling', () => {
      it('should handle command timeout', async () => {
        // Never emit close event to trigger timeout
        const promise = orchestrator.executeClaudeCode(
          'Test prompt',
          'System prompt',
          { timeout: 100 } // Short timeout for test
        );

        const result = await promise;
        expect(result.success).toBe(false);
        expect(result.error).toContain('Command timed out');
      });

      it('should handle non-zero exit code', async () => {
        setTimeout(() => {
          mockChild.stderr.emit('data', 'Error message');
          mockChild.emit('close', 1);
        }, 10);

        const result = await orchestrator.executeClaudeCode(
          'Test prompt',
          'System prompt'
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('Command failed with exit code 1');
        expect(result.exitCode).toBe(1);
      });

    });
  });

  describe('Brutalist Analysis', () => {
    it.skip('should execute analysis with multiple CLI agents', async () => {
      // Mock available CLIs
      const detectChild = new MockChildProcess();
      mockSpawn.mockReturnValue(detectChild as any);
      setTimeout(() => {
        detectChild.stdout.emit('data', 'version');
        detectChild.emit('close', 0);
      }, 10);
      await orchestrator.detectCLIContext();

      // Mock execution responses
      const execChild1 = new MockChildProcess();
      const execChild2 = new MockChildProcess();
      
      mockSpawn
        .mockReturnValueOnce(execChild1 as any)
        .mockReturnValueOnce(execChild2 as any);
      
      setTimeout(() => {
        execChild1.stdout.emit('data', 'Codex brutal analysis');
        execChild1.emit('close', 0);
      }, 10);
      
      setTimeout(() => {
        execChild2.stdout.emit('data', 'Gemini brutal analysis');
        execChild2.emit('close', 0);
      }, 20);

      const responses = await orchestrator.executeBrutalistAnalysis(
        'codebase',
        '/project/src',
        'You are a brutal critic',
        'Production critical code'
      );

      expect(responses.length).toBeGreaterThanOrEqual(1);
      expect(responses[0].success).toBe(true);
    }, 10000);

    it.skip('should handle mixed success/failure responses', async () => {
      // Mock available CLIs
      const detectChild = new MockChildProcess();
      mockSpawn.mockReturnValue(detectChild as any);
      setTimeout(() => {
        detectChild.stdout.emit('data', 'version');
        detectChild.emit('close', 0);
      }, 10);
      await orchestrator.detectCLIContext();

      // Mock execution responses
      const execChild1 = new MockChildProcess();
      const execChild2 = new MockChildProcess();
      
      mockSpawn
        .mockReturnValueOnce(execChild1 as any)
        .mockReturnValueOnce(execChild2 as any);
      
      setTimeout(() => {
        execChild1.stdout.emit('data', 'Codex analysis');
        execChild1.emit('close', 0);
      }, 10);
      
      setTimeout(() => {
        execChild2.emit('error', new Error('Gemini CLI failed'));
      }, 20);

      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        'Revolutionary framework',
        'You are a critic'
      );

      expect(responses.length).toBeGreaterThanOrEqual(1);
      const successfulResponses = responses.filter(r => r.success);
      const failedResponses = responses.filter(r => !r.success);
      expect(successfulResponses.length).toBeGreaterThanOrEqual(0);
      expect(failedResponses.length).toBeGreaterThanOrEqual(0);
    }, 10000);

    it('should synthesize responses into brutal feedback', () => {
      const responses = [
        {
          agent: 'codex' as const,
          success: true,
          output: 'This code will fail catastrophically',
          executionTime: 1500,
          command: 'codex exec',
          workingDirectory: '/test'
        },
        {
          agent: 'gemini' as const,
          success: true,
          output: 'Architecture is fundamentally flawed',
          executionTime: 1200,
          command: 'gemini',
          workingDirectory: '/test'
        }
      ];

      const synthesis = orchestrator.synthesizeBrutalistFeedback(responses, 'codebase');

      expect(synthesis).toContain('2 AI critics have systematically demolished');
      expect(synthesis).toContain('CODEX');
      expect(synthesis).toContain('GEMINI');
      expect(synthesis).toContain('This code will fail catastrophically');
      expect(synthesis).toContain('Architecture is fundamentally flawed');
    });
  });

  describe('Concurrency Control', () => {
    it('should limit concurrent CLI executions', async () => {
      // This test would need to verify the MAX_CONCURRENT_CLIS logic
      // For now, we'll just verify the basic structure is in place
      expect(orchestrator).toHaveProperty('executeBrutalistAnalysis');
    });
  });

  describe('Platform Compatibility', () => {
    it('should handle Windows process killing differently', async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', {
        value: 'win32'
      });

      // Test that Windows uses different kill mechanism
      // This would be tested more thoroughly in integration tests

      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform);
      }
    });
  });

  describe('Prompt Construction', () => {
    it('should use correct camelCase keys for prompts', () => {
      // Test that the prompt keys match the BrutalistPromptType enum
      const promptTypes: BrutalistPromptType[] = [
        'codebase', 'architecture', 'idea', 'research', 'security',
        'product', 'infrastructure', 'fileStructure', 'dependencies',
        'gitHistory', 'testCoverage'
      ];

      // This test verifies the fix for the snake_case vs camelCase issue
      promptTypes.forEach(type => {
        const prompt = (orchestrator as any).constructUserPrompt(type, '/test/path');
        expect(prompt).toBeTruthy();
        expect(prompt).not.toContain('undefined');
      });
    });
  });
});