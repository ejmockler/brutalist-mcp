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

// Mock CLI Agent Orchestrator since we don't want to make actual CLI calls in tests
const mockDetectCLIContext = jest.fn();
const mockExecuteBrutalistAnalysis = jest.fn();
const mockSynthesizeBrutalistFeedback = jest.fn();
const mockGetSmartCLISelection = jest.fn();

jest.mock('./cli-agents.js', () => ({
  CLIAgentOrchestrator: jest.fn().mockImplementation(() => ({
    detectCLIContext: mockDetectCLIContext,
    executeBrutalistAnalysis: mockExecuteBrutalistAnalysis,
    synthesizeBrutalistFeedback: mockSynthesizeBrutalistFeedback,
    getSmartCLISelection: mockGetSmartCLISelection
  }))
}));

// Mock logger to avoid console output during tests
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
    // Reset mocks
    jest.clearAllMocks();
    
    // Setup default mock returns
    mockDetectCLIContext.mockResolvedValue({
      currentCLI: 'claude',
      availableCLIs: ['claude', 'codex', 'gemini']
    });
    
    mockGetSmartCLISelection.mockReturnValue(['codex', 'gemini']);
    
    mockExecuteBrutalistAnalysis.mockResolvedValue([
      {
        agent: 'codex',
        success: true,
        output: 'This code is vulnerable to injection attacks.',
        executionTime: 1500
      },
      {
        agent: 'gemini',
        success: true,
        output: 'The architecture has scaling bottlenecks.',
        executionTime: 1200
      }
    ]);
    
    mockSynthesizeBrutalistFeedback.mockReturnValue('Synthesized brutal feedback from CLI agents');
  });

  describe('Constructor', () => {
    it('should initialize with default config', () => {
      const server = new BrutalistServer();
      expect(server.config.workingDirectory).toBe(process.cwd());
      expect(server.config.defaultTimeout).toBe(180000); // Updated for CLI execution reliability
      expect(server.config.enableSandbox).toBe(true);
    });

    it('should accept custom config', () => {
      const customConfig = {
        workingDirectory: '/custom/path',
        defaultTimeout: 60000,
        enableSandbox: false
      };
      const server = new BrutalistServer(customConfig);
      expect(server.config.workingDirectory).toBe('/custom/path');
      expect(server.config.defaultTimeout).toBe(60000);
      expect(server.config.enableSandbox).toBe(false);
    });
  });

  describe('Tool Registration', () => {
    let server: BrutalistServer;

    beforeEach(() => {
      server = new BrutalistServer();
    });

    it('should register all 13 tools', () => {
      expect(mockTool).toHaveBeenCalledTimes(13);
    });

    it('should register roast_codebase tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_codebase',
        expect.stringContaining('Deploy brutal AI critics'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_cli_debate tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_cli_debate',
        expect.stringContaining('adversarial combat'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register cli_agent_roster tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'cli_agent_roster',
        expect.stringContaining('Know your weapons'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_idea tool', () => {
      const roastIdeaCalls = mockTool.mock.calls.filter(call => call[0] === 'roast_idea');
      expect(roastIdeaCalls.length).toBe(1);
      expect(roastIdeaCalls[0][1]).toContain('Deploy brutal AI critics');
    });

    it('should register roast_architecture tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_architecture',
        expect.stringContaining('architect'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_security tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_security',
        expect.stringContaining('battle-hardened penetration tester'),
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  describe('Server Lifecycle', () => {
    it('should start server successfully', async () => {
      const server = new BrutalistServer();
      await server.start();
      
      expect(mockDetectCLIContext).toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalled();
    });

    it('should handle CLI context detection failure gracefully', async () => {
      mockDetectCLIContext.mockRejectedValueOnce(new Error('CLI detection failed'));
      
      const server = new BrutalistServer();
      await server.start();
      
      // Should still connect even if CLI detection fails
      expect(mockConnect).toHaveBeenCalled();
    });
  });

  describe.skip('Tool Execution', () => {
    let server: BrutalistServer;
    let toolHandlers: Record<string, Function> = {};

    beforeEach(() => {
      // Capture tool handlers when registered
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      
      server = new BrutalistServer();
    });

    describe('roast_codebase', () => {
      it('should execute with all parameters', async () => {
        const result = await toolHandlers['roast_codebase']({
          targetPath: '/path/to/code',
          context: 'Production API',
          workingDirectory: '/custom/dir',
          enableSandbox: true
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'codebase',
          '/path/to/code',
          expect.stringContaining('brutal code critic'),
          'Production API',
          expect.objectContaining({
            workingDirectory: '/custom/dir',
            sandbox: true,
            timeout: 180000,
            preferredCLI: undefined,
            analysisType: 'codebase'
          })
        );
        expect(result.content[0].text).toBe('Synthesized brutal feedback from CLI agents');
      });

      it('should handle minimal parameters', async () => {
        const result = await toolHandlers['roast_codebase']({
          targetPath: './src'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'codebase',
          './src',
          expect.stringContaining('brutal code critic'),
          undefined,
          expect.objectContaining({
            workingDirectory: process.cwd(),
            sandbox: true,
            timeout: 180000,
            preferredCLI: undefined,
            analysisType: 'codebase'
          })
        );
        expect(result.content[0].text).toBe('Synthesized brutal feedback from CLI agents');
      });

      it('should handle errors gracefully', async () => {
        mockExecuteBrutalistAnalysis.mockRejectedValueOnce(new Error('CLI execution failed'));
        
        const result = await toolHandlers['roast_codebase']({
          targetPath: '/bad/path'
        });

        expect(result.content[0].text).toContain('Brutalist MCP Error: CLI execution failed');
      });
    });

    describe('roast_cli_debate', () => {
      beforeEach(() => {
        // Mock the CLI debate specific method
        mockGetSmartCLISelection.mockReturnValue(['codex', 'gemini']);
      });

      it('should execute debate with multiple rounds', async () => {
        const result = await toolHandlers['roast_cli_debate']({
          targetPath: 'Test concept',
          debateRounds: 3,
          context: 'Additional context'
        });

        // Should be called twice (once for initial analysis, once for counter-arguments per round after first)
        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledTimes(3);
        expect(result.content[0].text).toContain('CLI Agent Debate Results');
      });

      it('should use default 2 rounds', async () => {
        const result = await toolHandlers['roast_cli_debate']({
          targetPath: 'Simple debate topic'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledTimes(2);
      });

      it('should handle insufficient CLIs', async () => {
        mockGetSmartCLISelection.mockReturnValue(['claude']); // Only one CLI

        const result = await toolHandlers['roast_cli_debate']({
          targetPath: 'Test concept'
        });

        expect(result.content[0].text).toContain('CLI debate requires at least 2 CLIs');
      });
    });

    describe('cli_agent_roster', () => {
      it('should show available CLI agents and context', async () => {
        const result = await toolHandlers['cli_agent_roster']({});

        expect(mockDetectCLIContext).toHaveBeenCalled();
        expect(result.content[0].text).toContain('Brutalist CLI Agent Arsenal');
        expect(result.content[0].text).toContain('Available AI Critics (13 Tools Total)');
        expect(result.content[0].text).toContain('Current CLI Context');
      });
    });

    describe('roast_idea', () => {
      it('should execute with full context', async () => {
        const result = await toolHandlers['roast_idea']({
          idea: 'AI-powered code review',
          context: 'For open source projects',
          workingDirectory: '/project/root'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'idea',
          'AI-powered code review',
          'idea',
          expect.stringContaining('For open source projects'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });

      it('should handle idea with no context', async () => {
        const result = await toolHandlers['roast_idea']({
          idea: 'Revolutionary new framework'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'idea',
          'Revolutionary new framework',
          'idea',
          expect.stringContaining('Context: none'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_file_structure', () => {
      it('should execute with directory path', async () => {
        const result = await toolHandlers['roast_file_structure']({
          targetPath: '/project/src',
          context: 'Monorepo structure'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'file_structure',
          '/project/src',
          'fileStructure',
          expect.stringContaining('Monorepo structure'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_dependencies', () => {
      it('should execute with package file', async () => {
        const result = await toolHandlers['roast_dependencies']({
          targetPath: 'package.json'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'dependencies',
          'package.json',
          'dependencies',
          expect.stringContaining('Dependency analysis'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });

      it('should handle includeDevDeps parameter', async () => {
        const result = await toolHandlers['roast_dependencies']({
          targetPath: 'package.json',
          includeDevDeps: false
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'dependencies',
          'package.json',
          'dependencies',
          expect.stringContaining('dev deps: false'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_git_history', () => {
      it('should execute with default parameters', async () => {
        const result = await toolHandlers['roast_git_history']({
          targetPath: '/project/repo'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'git_history',
          '/project/repo',
          'gitHistory',
          expect.stringContaining('last 20 commits'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });

      it('should handle custom commit range', async () => {
        const result = await toolHandlers['roast_git_history']({
          targetPath: '/project/repo',
          commitRange: 'last 50 commits',
          context: 'Feature branch analysis'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'git_history',
          '/project/repo',
          'gitHistory',
          expect.stringContaining('last 50 commits'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_test_coverage', () => {
      it('should execute with default parameters', async () => {
        const result = await toolHandlers['roast_test_coverage']({
          targetPath: '/project/tests'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'test_coverage',
          '/project/tests',
          'testCoverage',
          expect.stringContaining('run coverage: true'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });

      it('should handle runCoverage parameter', async () => {
        const result = await toolHandlers['roast_test_coverage']({
          targetPath: '/project/tests',
          runCoverage: false,
          context: 'Manual test review'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'test_coverage',
          '/project/tests',
          'testCoverage',
          expect.stringContaining('run coverage: false'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_architecture', () => {
      it('should execute with architecture description', async () => {
        const result = await toolHandlers['roast_architecture']({
          architecture: 'Microservices with Event Sourcing',
          scale: '1M users',
          constraints: 'Limited budget'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'architecture',
          'Microservices with Event Sourcing',
          'architecture',
          expect.stringContaining('Scale: 1M users'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });

      it('should handle minimal parameters', async () => {
        const result = await toolHandlers['roast_architecture']({
          architecture: 'Simple REST API'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'architecture',
          'Simple REST API',
          'architecture',
          expect.stringContaining('Scale: unknown'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_research', () => {
      it('should execute with research parameters', async () => {
        const result = await toolHandlers['roast_research']({
          research: 'ML optimization study',
          field: 'Computer Science',
          claims: '10x performance improvement',
          data: 'Synthetic benchmarks'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'research',
          'ML optimization study',
          'research',
          expect.stringContaining('Field: Computer Science'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });

      it('should handle missing optional fields', async () => {
        const result = await toolHandlers['roast_research']({
          research: 'Basic study'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'research',
          'Basic study',
          'research',
          expect.stringContaining('Field: unspecified'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_security', () => {
      it('should execute with security parameters', async () => {
        const result = await toolHandlers['roast_security']({
          system: 'OAuth2 implementation',
          assets: 'User credentials',
          threatModel: 'Web application threats',
          compliance: 'GDPR, SOC2'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'security',
          'OAuth2 implementation',
          'security',
          expect.stringContaining('Assets: User credentials'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_product', () => {
      it('should execute with product parameters', async () => {
        const result = await toolHandlers['roast_product']({
          product: 'Developer productivity tool',
          users: 'Software engineers',
          competition: 'GitHub Copilot',
          metrics: 'Daily active users'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'product',
          'Developer productivity tool',
          'product',
          expect.stringContaining('Users: Software engineers'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });

    describe('roast_infrastructure', () => {
      it('should execute with infrastructure parameters', async () => {
        const result = await toolHandlers['roast_infrastructure']({
          infrastructure: 'Kubernetes on AWS',
          scale: '1000 pods',
          budget: '$50k/month',
          sla: '99.99% uptime'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          'infrastructure',
          'Kubernetes on AWS',
          'infrastructure',
          expect.stringContaining('Scale: 1000 pods'),
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      });
    });
  });

  describe.skip('CLI Context Integration', () => {
    let server: BrutalistServer;

    beforeEach(() => {
      server = new BrutalistServer();
    });

    it('should use smart CLI selection to exclude current CLI', async () => {
      mockDetectCLIContext.mockResolvedValue({
        currentCLI: 'claude',
        availableCLIs: ['claude', 'codex', 'gemini']
      });

      await (server as any).executeBrutalistAnalysis(
        'idea',
        'test concept',
        'idea'
      );

      expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
        'idea',
        'test concept',
        'idea',
        undefined,
        expect.objectContaining({
          excludeCurrentCLI: true
        })
      );
    });

    it('should handle empty CLI context gracefully', async () => {
      mockDetectCLIContext.mockResolvedValue({
        currentCLI: undefined,
        availableCLIs: []
      });

      mockExecuteBrutalistAnalysis.mockResolvedValue([{
        agent: 'claude',
        success: false,
        output: '',
        error: 'No CLIs available for analysis',
        executionTime: 0
      }]);

      const result = await (server as any).executeBrutalistAnalysis(
        'idea',
        'test concept',
        'idea'
      );

      expect(result.success).toBe(false);
    });
  });

  describe.skip('CLI Interface Validation', () => {
    let server: BrutalistServer;

    beforeEach(() => {
      server = new BrutalistServer();
    });

    it('should verify all tools use CLI agent orchestrator', async () => {
      // Create a server and start it to trigger CLI context detection
      const server = new BrutalistServer();
      await server.start();
      
      // Verify the orchestrator detectCLIContext was called during startup
      expect(mockDetectCLIContext).toHaveBeenCalled();
    });

    it('should verify system prompt types match tool categories', async () => {
      // File-system analysis tools should use appropriate prompt types
      const fileSystemTools = [
        { tool: 'roast_codebase', promptType: 'codeAnalysis', hasContext: false },
        { tool: 'roast_file_structure', promptType: 'fileStructure', hasContext: true },
        { tool: 'roast_dependencies', promptType: 'dependencies', hasContext: true },
        { tool: 'roast_git_history', promptType: 'gitHistory', hasContext: true },
        { tool: 'roast_test_coverage', promptType: 'testCoverage', hasContext: true }
      ];

      const toolHandlers: Record<string, Function> = {};
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      
      new BrutalistServer();

      for (const { tool, promptType, hasContext } of fileSystemTools) {
        mockExecuteBrutalistAnalysis.mockClear();
        
        await toolHandlers[tool]({
          targetPath: '/test/path'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          expect.any(String),
          '/test/path',
          promptType,
          hasContext ? expect.any(String) : undefined,
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      }
    });

    it('should verify abstract analysis tools use correct prompt types', async () => {
      const abstractTools = [
        { tool: 'roast_idea', promptType: 'idea', param: 'idea' },
        { tool: 'roast_architecture', promptType: 'architecture', param: 'architecture' },
        { tool: 'roast_research', promptType: 'research', param: 'research' },
        { tool: 'roast_security', promptType: 'security', param: 'system' },
        { tool: 'roast_product', promptType: 'product', param: 'product' },
        { tool: 'roast_infrastructure', promptType: 'infrastructure', param: 'infrastructure' }
      ];

      const toolHandlers: Record<string, Function> = {};
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      
      new BrutalistServer();

      for (const { tool, promptType, param } of abstractTools) {
        mockExecuteBrutalistAnalysis.mockClear();
        
        await toolHandlers[tool]({
          [param]: 'test input'
        });

        expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
          expect.any(String),
          'test input',
          promptType,
          expect.any(String), // Context string varies by tool
          expect.objectContaining({
            excludeCurrentCLI: true
          })
        );
      }
    });

    it('should verify CLI debate uses proper round-based execution', async () => {
      const toolHandlers: Record<string, Function> = {};
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      
      new BrutalistServer();

      mockGetSmartCLISelection.mockReturnValue(['codex', 'gemini']);
      
      await toolHandlers['roast_cli_debate']({
        targetPath: 'Test concept',
        debateRounds: 3
      });

      // Should call executeBrutalistAnalysis for each round
      expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledTimes(3);
      
      // First call should use 'idea' prompt type
      expect(mockExecuteBrutalistAnalysis).toHaveBeenNthCalledWith(1,
        'idea',
        'Test concept',
        'idea',
        expect.any(String),
        expect.objectContaining({
          excludeCurrentCLI: true
        })
      );
      
      // Subsequent calls should use 'research' prompt type for counter-arguments
      expect(mockExecuteBrutalistAnalysis).toHaveBeenNthCalledWith(2,
        'research',
        'Test concept',
        'research',
        expect.stringContaining('Previous analyses:'),
        expect.objectContaining({
          excludeCurrentCLI: true
        })
      );
    });

    it('should verify CLI context detection affects tool execution', async () => {
      mockDetectCLIContext.mockResolvedValue({
        currentCLI: 'claude',
        availableCLIs: ['claude', 'codex', 'gemini']
      });

      mockGetSmartCLISelection.mockReturnValue(['codex', 'gemini']); // Excludes claude

      const toolHandlers: Record<string, Function> = {};
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      
      new BrutalistServer();

      await toolHandlers['roast_codebase']({
        targetPath: '/test/path'
      });

      // Verify excludeCurrentCLI is passed correctly
      expect(mockExecuteBrutalistAnalysis).toHaveBeenCalledWith(
        'codebase',
        '/test/path',
        'codeAnalysis',
        undefined, // No context when only targetPath provided
        expect.objectContaining({
          excludeCurrentCLI: true
        })
      );
    });
  });
});