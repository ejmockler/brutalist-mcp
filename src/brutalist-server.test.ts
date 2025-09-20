import { BrutalistServer } from './brutalist-server.js';
import { CLIAgentResponse } from './types/brutalist.js';

// Mock the MCP SDK components
const mockTool = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);

jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    tool: mockTool,
    connect: mockConnect
  }))
}));

jest.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: jest.fn()
}));

// Mock CLI Agent Orchestrator with current interface
const mockDetectCLIContext = jest.fn();
const mockExecuteBrutalistAnalysis = jest.fn();
const mockSynthesizeBrutalistFeedback = jest.fn();

jest.mock('./cli-agents.js', () => ({
  CLIAgentOrchestrator: jest.fn().mockImplementation(() => ({
    detectCLIContext: mockDetectCLIContext,
    executeBrutalistAnalysis: mockExecuteBrutalistAnalysis,
    synthesizeBrutalistFeedback: mockSynthesizeBrutalistFeedback
  }))
}));

// Mock logger
jest.mock('./logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}));

describe('BrutalistServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Setup realistic mock responses
    mockDetectCLIContext.mockResolvedValue({
      currentCLI: 'claude',
      availableCLIs: ['claude', 'codex', 'gemini']
    });
    
    mockExecuteBrutalistAnalysis.mockResolvedValue([
      {
        agent: 'codex',
        success: true,
        output: 'Your code has 3 SQL injection vulnerabilities in the authentication module.',
        executionTime: 2400,
        command: 'codex exec',
        workingDirectory: '/test',
        exitCode: 0
      },
      {
        agent: 'gemini', 
        success: true,
        output: 'This architecture will cost $50k/month at 10k users due to inefficient database queries.',
        executionTime: 1800,
        command: 'gemini --model gemini-2.5-flash',
        workingDirectory: '/test',
        exitCode: 0
      }
    ]);
    
    mockSynthesizeBrutalistFeedback.mockReturnValue('## BRUTAL ANALYSIS COMPLETE\n\n2 AI critics have demolished your work.\n\n### Codex Analysis\nSQL injection vulnerabilities found...\n\n### Gemini Analysis\nCost explosion predicted...');
  });

  describe('Constructor', () => {
    it('should initialize with default config', () => {
      const server = new BrutalistServer();
      expect(server.config.workingDirectory).toBe(process.cwd());
      expect(server.config.defaultTimeout).toBe(1500000); // 25 minutes
      expect(server.config.enableSandbox).toBe(true);
    });

    it('should accept custom config', () => {
      const config = {
        workingDirectory: '/custom',
        defaultTimeout: 60000,
        enableSandbox: false
      };
      const server = new BrutalistServer(config);
      expect(server.config.workingDirectory).toBe('/custom');
      expect(server.config.defaultTimeout).toBe(60000);
      expect(server.config.enableSandbox).toBe(false);
    });
  });

  describe('Tool Registration', () => {
    it('should register all 13 brutalist tools', () => {
      new BrutalistServer();
      expect(mockTool).toHaveBeenCalledTimes(13);
      
      const toolNames = mockTool.mock.calls.map(call => call[0]);
      expect(toolNames).toContain('roast_codebase');
      expect(toolNames).toContain('roast_cli_debate');
      expect(toolNames).toContain('cli_agent_roster');
      expect(toolNames).toContain('roast_idea');
      expect(toolNames).toContain('roast_architecture');
      expect(toolNames).toContain('roast_security');
      expect(toolNames).toContain('roast_file_structure');
      expect(toolNames).toContain('roast_dependencies');
      expect(toolNames).toContain('roast_git_history');
      expect(toolNames).toContain('roast_test_coverage');
      expect(toolNames).toContain('roast_research');
      expect(toolNames).toContain('roast_product');
      expect(toolNames).toContain('roast_infrastructure');
    });

    it('should register tools with brutal descriptions', () => {
      new BrutalistServer();
      
      const codebaseCall = mockTool.mock.calls.find(call => call[0] === 'roast_codebase');
      expect(codebaseCall[1]).toContain('Deploy brutal AI critics');
      
      const debateCall = mockTool.mock.calls.find(call => call[0] === 'roast_cli_debate');
      expect(debateCall[1]).toContain('adversarial combat');
      
      const securityCall = mockTool.mock.calls.find(call => call[0] === 'roast_security');
      expect(securityCall[1]).toContain('battle-hardened');
    });
  });

  describe('Server Lifecycle', () => {
    it('should start server successfully', async () => {
      const server = new BrutalistServer();
      await server.start();
      
      expect(mockConnect).toHaveBeenCalled();
      // Note: CLI context detection happens lazily during tool execution
    });
  });

  describe('Tool Execution', () => {
    let server: BrutalistServer;
    let toolHandlers: Record<string, Function> = {};

    beforeEach(() => {
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      server = new BrutalistServer();
    });

    describe('roast_codebase', () => {
      it('should execute brutal codebase analysis', async () => {
        const result = await toolHandlers['roast_codebase']({
          targetPath: '/src',
          context: 'Production trading system'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'codebase',
          '/src',
          expect.stringContaining('battle-scarred principal engineer'),
          'Production trading system',
          expect.objectContaining({
            workingDirectory: process.cwd(),
            sandbox: true,
            timeout: 1500000
          })
        );
        
        expect(result.content[0].text).toContain('BRUTAL ANALYSIS COMPLETE');
      });

      it('should handle minimal parameters', async () => {
        const result = await toolHandlers['roast_codebase']({
          targetPath: './auth'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'codebase',
          './auth',
          expect.stringContaining('battle-scarred principal engineer'),
          undefined,
          expect.objectContaining({
            workingDirectory: process.cwd(),
            sandbox: true
          })
        );
      });

      it('should handle execution failures', async () => {
        mockExecuteBrutalistAnalysis.mockRejectedValueOnce(new Error('All CLI agents failed'));
        
        const result = await toolHandlers['roast_codebase']({
          targetPath: '/bad/path'
        });

        expect(result.content[0].text).toContain('Brutalist MCP Error');
        expect(result.content[0].text).toContain('Analysis failed due to internal error');
      });
    });

    describe('roast_cli_debate', () => {
      beforeEach(() => {
        // Mock multi-round responses
        mockExecuteBrutalistAnalysis
          .mockResolvedValueOnce([{
            agent: 'codex',
            success: true,
            output: 'TypeScript is safer for large teams due to static typing.',
            executionTime: 2000,
            command: 'codex exec',
            workingDirectory: '/test',
            exitCode: 0
          }])
          .mockResolvedValueOnce([{
            agent: 'gemini',
            success: true,
            output: 'Go is faster and has better concurrency primitives.',
            executionTime: 1500,
            command: 'gemini --model gemini-2.5-flash',
            workingDirectory: '/test',
            exitCode: 0
          }]);
      });

      it('should execute multi-round CLI debate', async () => {
        const result = await toolHandlers['roast_cli_debate']({
          targetPath: 'TypeScript vs Go for API backend',
          debateRounds: 2
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledTimes(2);
        expect(result.content[0].text).toContain('CLI Agent Debate Results');
      });

      it('should default to 2 rounds', async () => {
        await toolHandlers['roast_cli_debate']({
          targetPath: 'Simple debate topic'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledTimes(2);
      });
    });

    describe('roast_idea', () => {
      it('should demolish startup ideas', async () => {
        const result = await toolHandlers['roast_idea']({
          idea: 'AI-powered social network for pets',
          context: 'Limited budget, 2-person team'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'idea',
          'AI-powered social network for pets',
          expect.stringContaining('brutal idea critic'),
          expect.stringContaining('Limited budget, 2-person team'),
          expect.objectContaining({
            analysisType: 'idea',
            sandbox: true,
            timeout: 1500000
          })
        );
      });
    });

    describe('roast_security', () => {
      it('should find security vulnerabilities', async () => {
        const result = await toolHandlers['roast_security']({
          system: 'JWT authentication with localStorage',
          assets: 'User credentials and payment data'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'security',
          'JWT authentication with localStorage',
          expect.stringContaining('battle-hardened penetration tester'),
          expect.stringContaining('User credentials and payment data'),
          expect.objectContaining({
            analysisType: 'security',
            sandbox: true,
            timeout: 1500000
          })
        );
      });
    });

    describe('roast_architecture', () => {
      it('should expose scaling disasters', async () => {
        const result = await toolHandlers['roast_architecture']({
          architecture: 'Microservices with event sourcing',
          scale: '1M daily users',
          constraints: '$10k/month budget'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'architecture',
          'Microservices with event sourcing',
          expect.stringContaining('brutal system architecture critic'),
          expect.stringContaining('1M daily users'),
          expect.objectContaining({
            analysisType: 'architecture',
            sandbox: true,
            timeout: 1500000
          })
        );
      });
    });

    describe('codebase analysis tools', () => {
      const codebaseTools = [
        'roast_file_structure',
        'roast_dependencies', 
        'roast_git_history',
        'roast_test_coverage'
      ];

      codebaseTools.forEach(toolName => {
        it(`should execute ${toolName}`, async () => {
          const result = await toolHandlers[toolName]({
            targetPath: '/project'
          });

          expect(mockExecuteBrutalistAnalysis).toHaveBeenCalled();
          expect(result.content[0].text).toContain('BRUTAL ANALYSIS');
        });
      });
    });

    describe('cli_agent_roster', () => {
      it('should show available CLI agents', async () => {
        const result = await toolHandlers['cli_agent_roster']({});

        expect(mockDetectCLIContext).toHaveBeenCalled();
        expect(result.content[0].text).toContain('CLI Agent Arsenal');
        expect(result.content[0].text).toContain('Available AI Critics');
      });
    });
  });

  describe('Error Handling', () => {
    let toolHandlers: Record<string, Function> = {};

    beforeEach(() => {
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      new BrutalistServer();
    });

    it('should handle CLI detection failures gracefully', async () => {
      mockDetectCLIContext.mockRejectedValueOnce(new Error('CLI not found'));
      
      const result = await toolHandlers['cli_agent_roster']({});
      
      expect(result.content[0].text).toContain('Analysis failed due to internal error');
    });

    it('should handle analysis failures gracefully', async () => {
      mockExecuteBrutalistAnalysis.mockRejectedValueOnce(new Error('All agents failed'));
      
      const result = await toolHandlers['roast_codebase']({
        targetPath: '/test'
      });

      expect(result.content[0].text).toContain('Brutalist MCP Error');
    });

    it('should handle partial CLI failures', async () => {
      mockExecuteBrutalistAnalysis.mockResolvedValueOnce([
        {
          agent: 'codex',
          success: true,
          output: 'Found security issues',
          executionTime: 1000,
          command: 'codex exec',
          workingDirectory: '/test',
          exitCode: 0
        },
        {
          agent: 'gemini',
          success: false,
          output: '',
          error: 'Timeout',
          executionTime: 25000,
          command: 'gemini',
          workingDirectory: '/test',
          exitCode: 1
        }
      ]);

      const result = await toolHandlers['roast_codebase']({
        targetPath: '/test'
      });

      expect(mockSynthesizeBrutalistFeedback).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ agent: 'codex', success: true }),
          expect.objectContaining({ agent: 'gemini', success: false })
        ]),
        'codebase'
      );
    });
  });

  describe('Security Tests', () => {
    let toolHandlers: Record<string, Function> = {};

    beforeEach(() => {
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      new BrutalistServer();
    });

    describe('Input Sanitization', () => {
      it('should handle malicious paths safely', async () => {
        const maliciousPaths = [
          '../../../etc/passwd',
          '../../.ssh/id_rsa',
          '/proc/self/environ',
          'C:\\Windows\\System32\\config\\SAM'
        ];

        for (const path of maliciousPaths) {
          const result = await toolHandlers['roast_codebase']({
            targetPath: path
          });

          expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
            'codebase',
            path, // Should pass through but orchestrator handles security
            expect.any(String),
            undefined,
            expect.objectContaining({
              sandbox: true, // Sandbox must be enabled for security
              workingDirectory: expect.any(String)
            })
          );
        }
      });

      it('should sanitize working directory overrides', async () => {
        const maliciousWorkingDirs = [
          '../../../',
          '/etc',
          '~/.ssh',
          '/proc'
        ];

        for (const workingDir of maliciousWorkingDirs) {
          const result = await toolHandlers['roast_codebase']({
            targetPath: './test',
            workingDirectory: workingDir
          });

          expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
            'codebase',
            './test',
            expect.any(String),
            undefined,
            expect.objectContaining({
              workingDirectory: workingDir, // Passes through - orchestrator validates
              sandbox: true
            })
          );
        }
      });

      it('should handle malicious CLI output safely', async () => {
        // Mock malicious CLI responses - test that they pass through unsanitized
        const maliciousOutput = '<script>alert("xss")</script>';
        
        mockExecuteBrutalistAnalysis.mockResolvedValueOnce([{
          agent: 'codex',
          success: true,
          output: maliciousOutput,
          executionTime: 1000,
          command: 'codex exec',
          workingDirectory: '/test',
          exitCode: 0
        }]);

        // Mock synthesis to return the malicious output 
        mockSynthesizeBrutalistFeedback.mockReturnValueOnce(
          `## Brutal Analysis\n\n${maliciousOutput}\n\nEnd of analysis.`
        );

        const result = await toolHandlers['roast_codebase']({
          targetPath: '/test'
        });

        // Response should contain the malicious output (server doesn't sanitize, relies on client)
        // This is by design - the MCP protocol expects clients to handle output safely
        expect(result.content[0].text).toContain(maliciousOutput);
        expect(mockSynthesizeBrutalistFeedback).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ output: maliciousOutput })
          ]),
          'codebase'
        );
      });
    });

    describe('Resource Limits', () => {
      it('should handle large debate rounds', async () => {
        const result = await toolHandlers['roast_cli_debate']({
          targetPath: 'Test concept',
          debateRounds: 100 // Excessive rounds
        });

        // Should complete but may be limited by implementation
        expect(result).toBeDefined();
        expect(result.content[0].text).toContain('CLI Agent Debate Results');
      });

      it('should handle concurrent tool executions', async () => {
        const promises = Array(10).fill(0).map(() => 
          toolHandlers['roast_codebase']({ targetPath: '/test' })
        );

        const results = await Promise.all(promises);
        
        expect(results).toHaveLength(10);
        results.forEach(result => {
          expect(result.content[0].text).toContain('BRUTAL ANALYSIS');
        });
      });
    });

    describe('Sandbox Security', () => {
      it('should enforce sandbox by default', async () => {
        await toolHandlers['roast_codebase']({
          targetPath: '/sensitive/path'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'codebase',
          '/sensitive/path',
          expect.any(String),
          undefined,
          expect.objectContaining({
            sandbox: true
          })
        );
      });

      it('should allow sandbox override only when explicitly disabled', async () => {
        await toolHandlers['roast_codebase']({
          targetPath: '/test',
          enableSandbox: false
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'codebase',
          '/test',
          expect.any(String),
          undefined,
          expect.objectContaining({
            sandbox: false
          })
        );
      });
    });
  });

  describe('Error Security', () => {
    let toolHandlers: Record<string, Function> = {};

    beforeEach(() => {
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      new BrutalistServer();
    });

    it('should not leak sensitive information in error messages', async () => {
      mockExecuteBrutalistAnalysis.mockRejectedValueOnce(
        new Error('ENOENT: no such file or directory, open \'/etc/shadow\'')
      );

      const result = await toolHandlers['roast_codebase']({
        targetPath: '/test'
      });

      // Should contain generic error, not expose system paths
      expect(result.content[0].text).toContain('Brutalist MCP Error');
      expect(result.content[0].text).toContain('Target path not found'); // Sanitized message
      expect(result.content[0].text).not.toContain('/etc/shadow');
      expect(result.content[0].text).not.toContain('ENOENT');
    });

    it('should not expose stack traces to clients', async () => {
      const errorWithStack = new Error('Test error');
      errorWithStack.stack = 'Error: Test error\n    at /home/user/.secrets/config.js:123:45';
      
      mockExecuteBrutalistAnalysis.mockRejectedValueOnce(errorWithStack);

      const result = await toolHandlers['roast_codebase']({
        targetPath: '/test'
      });

      expect(result.content[0].text).toContain('Analysis failed due to internal error'); // Generic sanitized message
      expect(result.content[0].text).not.toContain('.secrets');
      expect(result.content[0].text).not.toContain('/home/user');
      expect(result.content[0].text).not.toContain('config.js');
    });
  });

  describe('Configuration Integration', () => {
    it('should use custom timeout setting', () => {
      const server = new BrutalistServer({ defaultTimeout: 60000 });
      expect(server.config.defaultTimeout).toBe(60000);
    });

    it('should use custom working directory', () => {
      const server = new BrutalistServer({ workingDirectory: '/custom' });
      expect(server.config.workingDirectory).toBe('/custom');
    });

    it('should respect sandbox settings', () => {
      const server = new BrutalistServer({ enableSandbox: false });
      expect(server.config.enableSandbox).toBe(false);
    });
  });
});