import { CLIAgentOrchestrator, BrutalistPromptType } from './cli-agents.js';

// Mock child_process exec
jest.mock('child_process');
jest.mock('util');

// Mock logger
jest.mock('./logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

describe.skip('CLIAgentOrchestrator', () => {
  let orchestrator: CLIAgentOrchestrator;
  let mockExecAsync: jest.MockedFunction<any>;

  beforeEach(() => {
    mockExecAsync = jest.fn();
    
    // Mock the imports
    const { promisify } = require('util');
    (promisify as jest.MockedFunction<any>).mockReturnValue(mockExecAsync);
    
    orchestrator = new CLIAgentOrchestrator();
    jest.clearAllMocks();
  });

  describe('CLI Context Detection', () => {
    it('should detect available CLIs', async () => {
      // Mock CLI version checks - some succeed, some fail
      mockExecAsync
        .mockResolvedValueOnce({ stdout: 'claude 1.0.0', stderr: '' }) // claude available
        .mockRejectedValueOnce(new Error('Command not found')) // codex not available  
        .mockResolvedValueOnce({ stdout: 'gemini 2.5.0', stderr: '' }); // gemini available

      const context = await orchestrator.detectCLIContext();

      expect(context.availableCLIs).toEqual(['claude', 'gemini']);
      expect(mockExecAsync).toHaveBeenCalledWith('claude --version', { timeout: 5000 });
      expect(mockExecAsync).toHaveBeenCalledWith('codex --version', { timeout: 5000 });
      expect(mockExecAsync).toHaveBeenCalledWith('gemini --version', { timeout: 5000 });
    });

    it('should detect current CLI from environment variables', async () => {
      const originalEnv = process.env;
      process.env = { ...originalEnv, CLAUDE_CODE_SESSION: 'active' };

      mockExecAsync.mockResolvedValue({ stdout: 'version', stderr: '' });

      const context = await orchestrator.detectCLIContext();

      expect(context.currentCLI).toBe('claude');
      
      process.env = originalEnv;
    });

    it('should handle CLI detection failures gracefully', async () => {
      mockExecAsync.mockRejectedValue(new Error('All CLIs unavailable'));

      const context = await orchestrator.detectCLIContext();

      expect(context.availableCLIs).toEqual([]);
      expect(context.currentCLI).toBeUndefined();
    });
  });

  describe('Smart CLI Selection', () => {
    beforeEach(async () => {
      // Setup context with all CLIs available, claude as current
      mockExecAsync.mockResolvedValue({ stdout: 'version', stderr: '' });
      const originalEnv = process.env;
      process.env = { ...originalEnv, CLAUDE_CODE_SESSION: 'active' };
      
      await orchestrator.detectCLIContext();
      
      process.env = originalEnv;
    });

    it('should exclude current CLI by default', () => {
      const selected = orchestrator.getSmartCLISelection(true);
      
      expect(selected).toEqual(['codex', 'gemini']);
      expect(selected).not.toContain('claude');
    });

    it('should include all CLIs when excludeCurrentCLI is false', () => {
      const selected = orchestrator.getSmartCLISelection(false);
      
      expect(selected).toEqual(['claude', 'codex', 'gemini']);
    });

    it('should fallback to all CLIs if no alternatives available', () => {
      // Setup context with only current CLI available
      (orchestrator as any).cliContext = {
        currentCLI: 'claude',
        availableCLIs: ['claude']
      };

      const selected = orchestrator.getSmartCLISelection(true);
      
      expect(selected).toEqual(['claude']);
    });
  });

  describe('CLI Execution with System Prompts', () => {
    describe('Claude Code', () => {
      it('should inject system prompt via command line parameter', async () => {
        mockExecAsync.mockResolvedValue({
          stdout: 'Claude analysis output',
          stderr: ''
        });

        const result = await orchestrator.executeClaudeCode(
          'Analyze this code',
          'codeAnalysis'
        );

        expect(mockExecAsync).toHaveBeenCalledWith(
          expect.stringContaining('--system-prompt'),
          expect.objectContaining({
            cwd: expect.any(String),
            timeout: expect.any(Number),
            encoding: 'utf8'
          })
        );

        const calledCommand = mockExecAsync.mock.calls[0][0];
        expect(calledCommand).toContain('battle-scarred principal engineer');
        expect(calledCommand).toContain('Analyze this code');
        expect(result.agent).toBe('claude');
        expect(result.success).toBe(true);
        expect(result.output).toBe('Claude analysis output');
      });

      it('should escape quotes in system prompts and user prompts', async () => {
        mockExecAsync.mockResolvedValue({ stdout: 'output', stderr: '' });

        await orchestrator.executeClaudeCode(
          'Code with "quotes" in it',
          'codeAnalysis'
        );

        const calledCommand = mockExecAsync.mock.calls[0][0];
        expect(calledCommand).toContain('\\"quotes\\"');
      });
    });

    describe('Codex', () => {
      it('should embed system prompt in user prompt', async () => {
        mockExecAsync.mockResolvedValue({
          stdout: 'Codex analysis output',
          stderr: ''
        });

        const result = await orchestrator.executeCodex(
          'Analyze this architecture',
          'architecture',
          { sandbox: true }
        );

        expect(mockExecAsync).toHaveBeenCalledWith(
          expect.stringContaining('codex exec --sandbox read-only'),
          expect.objectContaining({
            timeout: expect.any(Number),
            encoding: 'utf8'
          })
        );

        const calledCommand = mockExecAsync.mock.calls[0][0];
        expect(calledCommand).toContain('distinguished architect');
        expect(calledCommand).toContain('Now: Analyze this architecture');
        expect(result.agent).toBe('codex');
        expect(result.success).toBe(true);
      });

      it('should handle sandbox and directory options', async () => {
        mockExecAsync.mockResolvedValue({ stdout: 'output', stderr: '' });

        await orchestrator.executeCodex(
          'Test prompt',
          'idea',
          { 
            sandbox: true,
            workingDirectory: '/custom/path'
          }
        );

        const calledCommand = mockExecAsync.mock.calls[0][0];
        expect(calledCommand).toContain('--sandbox read-only');
        expect(calledCommand).toContain('--cd "/custom/path"');
      });
    });

    describe('Gemini CLI', () => {
      it('should inject system prompt via environment variable', async () => {
        mockExecAsync.mockResolvedValue({
          stdout: 'Gemini analysis output',
          stderr: ''
        });

        const result = await orchestrator.executeGemini(
          'Analyze this security design',
          'security'
        );

        expect(mockExecAsync).toHaveBeenCalledWith(
          expect.stringContaining('GEMINI_SYSTEM_MD=<(echo'),
          expect.objectContaining({
            shell: '/bin/bash',
            timeout: expect.any(Number),
            encoding: 'utf8'
          })
        );

        const calledCommand = mockExecAsync.mock.calls[0][0];
        expect(calledCommand).toContain('battle-hardened penetration tester');
        expect(calledCommand).toContain('--prompt "Analyze this security design"');
        expect(result.agent).toBe('gemini');
        expect(result.success).toBe(true);
      });

      it('should handle working directory changes', async () => {
        mockExecAsync.mockResolvedValue({ stdout: 'output', stderr: '' });

        await orchestrator.executeGemini(
          'Test prompt',
          'research',
          { workingDirectory: '/test/dir' }
        );

        const calledCommand = mockExecAsync.mock.calls[0][0];
        expect(calledCommand).toMatch(/^cd "\/test\/dir" && /);
      });
    });
  });

  describe('Brutalist Analysis Integration', () => {
    beforeEach(() => {
      // Mock smart CLI selection to return available CLIs
      jest.spyOn(orchestrator, 'getSmartCLISelection').mockReturnValue(['codex', 'gemini']);
    });

    it('should execute analysis with multiple CLI agents', async () => {
      mockExecAsync
        .mockResolvedValueOnce({ stdout: 'Codex brutal analysis', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'Gemini brutal analysis', stderr: '' });

      const responses = await orchestrator.executeBrutalistAnalysis(
        'codebase',
        '/project/src',
        'codeAnalysis',
        'Production critical code'
      );

      expect(responses).toHaveLength(2);
      expect(responses[0].agent).toBe('codex');
      expect(responses[1].agent).toBe('gemini');
      expect(responses[0].success).toBe(true);
      expect(responses[1].success).toBe(true);
    });

    it('should handle mixed success/failure responses', async () => {
      mockExecAsync
        .mockResolvedValueOnce({ stdout: 'Codex analysis', stderr: '' })
        .mockRejectedValueOnce(new Error('Gemini CLI failed'));

      const responses = await orchestrator.executeBrutalistAnalysis(
        'idea',
        'Revolutionary framework',
        'idea'
      );

      expect(responses).toHaveLength(2);
      expect(responses[0].success).toBe(true);
      expect(responses[1].success).toBe(false);
      expect(responses[1].error).toContain('Gemini CLI failed');
    });

    it('should synthesize responses into brutal feedback', () => {
      const responses = [
        {
          agent: 'codex' as const,
          success: true,
          output: 'This code will fail catastrophically',
          executionTime: 1500
        },
        {
          agent: 'gemini' as const,
          success: true,
          output: 'Architecture is fundamentally flawed',
          executionTime: 1200
        }
      ];

      const synthesis = orchestrator.synthesizeBrutalistFeedback(responses, 'codebase');

      expect(synthesis).toContain('Brutalist codebase Destruction Report');
      expect(synthesis).toContain('2 AI critics have systematically demolished');
      expect(synthesis).toContain('CODEX');
      expect(synthesis).toContain('GEMINI');
      expect(synthesis).toContain('This code will fail catastrophically');
      expect(synthesis).toContain('Architecture is fundamentally flawed');
    });
  });

  describe('System Prompt Library', () => {
    it('should have distinct prompts for each analysis type', () => {
      const promptTypes: BrutalistPromptType[] = [
        'codeAnalysis', 'architecture', 'idea', 'research', 'security',
        'product', 'infrastructure', 'fileStructure', 'dependencies',
        'gitHistory', 'testCoverage'
      ];

      const prompts = (orchestrator as any).brutalistSystemPrompts;

      promptTypes.forEach(type => {
        expect(prompts[type]).toBeDefined();
        expect(prompts[type]).toContain('battle-');
        expect(typeof prompts[type]).toBe('string');
        expect(prompts[type].length).toBeGreaterThan(50);
      });

      // Verify prompts are distinct
      const uniquePrompts = new Set(Object.values(prompts));
      expect(uniquePrompts.size).toBe(promptTypes.length);
    });

    it('should construct appropriate user prompts for different analysis types', () => {
      const testCases = [
        {
          type: 'codebase',
          path: '/src',
          expected: ['Analyze the codebase at /src', 'source files', 'architecture']
        },
        {
          type: 'file_structure', 
          path: '/project',
          expected: ['directory structure at /project', 'file organization']
        },
        {
          type: 'idea',
          path: 'AI-powered testing',
          expected: ['Analyze this idea: AI-powered testing', 'encounters reality']
        }
      ];

      testCases.forEach(({ type, path, expected }) => {
        const prompt = (orchestrator as any).constructUserPrompt(type, path);
        
        expected.forEach(expectedText => {
          expect(prompt.toLowerCase()).toContain(expectedText.toLowerCase());
        });
      });
    });
  });
});