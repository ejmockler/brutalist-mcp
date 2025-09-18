import { BrutalistServer } from './brutalist-server.js';
import { ModelResponse } from './types/brutalist.js';

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

// Mock OpenRouter since we don't want to make actual API calls in tests
const mockExecuteMultiModel = jest.fn();
const mockSynthesizeResponses = jest.fn();
const mockGetAvailableModels = jest.fn();
const mockInitialize = jest.fn().mockResolvedValue(undefined);

jest.mock('./openrouter.js', () => ({
  OpenRouterClient: jest.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    getAvailableModels: mockGetAvailableModels,
    executeMultiModel: mockExecuteMultiModel,
    synthesizeResponses: mockSynthesizeResponses
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
    // Set mock API key for tests
    process.env.OPENROUTER_API_KEY = 'test-key';
    
    // Reset mocks
    jest.clearAllMocks();
    
    // Setup default mock returns
    mockGetAvailableModels.mockReturnValue(['anthropic/claude-3.5-sonnet', 'google/gemini-2.5-pro']);
    mockExecuteMultiModel.mockResolvedValue([
      {
        model: 'anthropic/claude-3.5-sonnet',
        persona: 'Brutal Critic (anthropic/claude-3.5-sonnet)',
        content: 'This code is vulnerable to SQL injection attacks.',
        tokensUsed: 150,
        responseTime: 320
      }
    ]);
    mockSynthesizeResponses.mockReturnValue('Synthesized brutal feedback');
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
  });

  describe('Constructor', () => {
    it('should initialize with default config', () => {
      const server = new BrutalistServer();
      expect(server.config.maxModelsPerRequest).toBe(3);
    });

    it('should throw error without API key', () => {
      delete process.env.OPENROUTER_API_KEY;
      expect(() => new BrutalistServer()).toThrow('OPENROUTER_API_KEY environment variable is required');
    });

    it('should accept custom config', () => {
      const customConfig = {
        maxModelsPerRequest: 5
      };
      const server = new BrutalistServer(customConfig);
      expect(server.config.maxModelsPerRequest).toBe(5);
    });

    it('should use API key from config if provided', () => {
      delete process.env.OPENROUTER_API_KEY;
      const server = new BrutalistServer({ openRouterApiKey: 'config-key' });
      expect(server).toBeDefined();
    });
  });

  describe('Tool Registration', () => {
    let server: BrutalistServer;

    beforeEach(() => {
      server = new BrutalistServer();
    });

    it('should register all 10 tools', () => {
      expect(mockTool).toHaveBeenCalledTimes(10);
    });

    it('should register roast_code tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_code',
        expect.stringContaining('battle-scarred principal engineer'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_architecture tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_architecture',
        expect.stringContaining('distinguished architect'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_idea tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_idea',
        expect.stringContaining('philosopher who understands'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_research tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_research',
        expect.stringContaining('skeptical peer reviewer'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_data tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_data',
        expect.stringContaining('supremely jaded data scientist'),
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

    it('should register roast_product tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_product',
        expect.stringContaining('product veteran'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_infrastructure tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_infrastructure',
        expect.stringContaining('grizzled site reliability engineer'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register roast_debate tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'roast_debate',
        expect.stringContaining('Truth emerges from conflict'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should register model_roster tool', () => {
      expect(mockTool).toHaveBeenCalledWith(
        'model_roster',
        expect.stringContaining('Know your weapons'),
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  describe('Server Lifecycle', () => {
    it('should start server successfully', async () => {
      const server = new BrutalistServer();
      await server.start();
      
      expect(mockInitialize).toHaveBeenCalled();
      expect(mockConnect).toHaveBeenCalled();
    });
  });

  describe('Tool Execution', () => {
    let server: BrutalistServer;
    let toolHandlers: Record<string, Function> = {};

    beforeEach(() => {
      // Capture tool handlers when registered
      mockTool.mockImplementation((name, description, schema, handler) => {
        toolHandlers[name] = handler;
      });
      
      server = new BrutalistServer();
    });

    describe('roast_code', () => {
      it('should execute with all parameters', async () => {
        const result = await toolHandlers['roast_code']({
          code: 'function test() { return true; }',
          fileType: 'javascript',
          context: 'Unit test helper',
          maxCritics: 5,
          models: ['google/gemini-2.5-pro']
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('javascript'),
          5,
          'function test() { return true; }',
          ['google/gemini-2.5-pro']
        );
        expect(result.content[0].text).toBe('Synthesized brutal feedback');
      });

      it('should handle minimal parameters', async () => {
        const result = await toolHandlers['roast_code']({
          code: 'SELECT * FROM users'
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('SELECT * FROM users'),
          3,
          'SELECT * FROM users',
          undefined
        );
        expect(result.content[0].text).toBe('Synthesized brutal feedback');
      });

      it('should handle errors gracefully', async () => {
        mockExecuteMultiModel.mockRejectedValueOnce(new Error('API Error'));
        
        const result = await toolHandlers['roast_code']({
          code: 'bad code'
        });

        expect(result.content[0].text).toContain('Brutalist MCP Error: API Error');
      });
    });

    describe('roast_architecture', () => {
      it('should execute with all parameters', async () => {
        const result = await toolHandlers['roast_architecture']({
          architecture: 'Microservices with Kafka',
          scale: '1M requests/day',
          constraints: 'Budget: $10k/month',
          models: ['anthropic/claude-3.5-sonnet']
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('Microservices with Kafka'),
          3,
          expect.stringContaining('Budget: $10k/month'),
          ['anthropic/claude-3.5-sonnet']
        );
      });
    });

    describe('roast_idea', () => {
      it('should execute with full context', async () => {
        const result = await toolHandlers['roast_idea']({
          idea: 'AI-powered code review',
          context: 'For open source projects',
          timeline: '3 months',
          resources: 'Solo developer',
          models: ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet']
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('AI-powered code review'),
          3,
          expect.stringContaining('Timeline: 3 months'),
          ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet']
        );
      });

      it('should handle idea with no context', async () => {
        const result = await toolHandlers['roast_idea']({
          idea: 'Revolutionary new framework'
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('Revolutionary new framework'),
          3,
          expect.stringContaining('Context: none'),
          undefined
        );
      });
    });

    describe('roast_research', () => {
      it('should execute with research parameters', async () => {
        const result = await toolHandlers['roast_research']({
          research: 'Novel ML optimization technique',
          field: 'Machine Learning',
          claims: '10x faster training',
          data: 'MNIST and ImageNet'
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('Machine Learning'),
          3,
          expect.stringContaining('Claims: 10x faster training'),
          undefined
        );
      });
    });

    describe('roast_data', () => {
      it('should execute with data analysis parameters', async () => {
        const result = await toolHandlers['roast_data']({
          analysis: 'Customer churn prediction model',
          dataset: '100k customer records',
          metrics: 'AUC 0.95, Precision 0.92',
          deployment: 'Real-time scoring API'
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('Customer churn prediction'),
          3,
          expect.stringContaining('AUC 0.95'),
          undefined
        );
      });
    });

    describe('roast_security', () => {
      it('should execute with security parameters', async () => {
        const result = await toolHandlers['roast_security']({
          system: 'OAuth2 implementation',
          assets: 'User credentials and sessions',
          threatModel: 'MITM, token theft',
          compliance: 'GDPR, SOC2'
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('OAuth2 implementation'),
          3,
          expect.stringContaining('GDPR, SOC2'),
          undefined
        );
      });
    });

    describe('roast_product', () => {
      it('should execute with product parameters', async () => {
        const result = await toolHandlers['roast_product']({
          product: 'Developer productivity tool',
          users: 'Senior engineers',
          competition: 'GitHub Copilot',
          metrics: 'DAU, retention rate'
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('Developer productivity tool'),
          3,
          expect.stringContaining('GitHub Copilot'),
          undefined
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

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          expect.stringContaining('Kubernetes on AWS'),
          3,
          expect.stringContaining('99.99% uptime'),
          undefined
        );
      });
    });

    describe('roast_debate', () => {
      it('should execute debate with multiple rounds', async () => {
        const result = await toolHandlers['roast_debate']({
          topic: 'Microservices vs Monolith',
          rounds: 3,
          models: ['google/gemini-2.5-pro']
        });

        // Should be called once per round
        expect(mockExecuteMultiModel).toHaveBeenCalledTimes(3);
        expect(result.content[0].text).toContain('Adversarial Debate: 3 Rounds');
      });

      it('should use default 2 rounds', async () => {
        const result = await toolHandlers['roast_debate']({
          topic: 'TypeScript vs JavaScript'
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledTimes(2);
        expect(result.content[0].text).toContain('Adversarial Debate: 2 Rounds');
      });

      it('should build debate history', async () => {
        await toolHandlers['roast_debate']({
          topic: 'Initial topic',
          rounds: 2
        });

        // First round should get original topic
        expect(mockExecuteMultiModel).toHaveBeenNthCalledWith(1,
          'Initial topic',
          3,
          undefined,
          undefined
        );

        // Second round should include previous debate
        expect(mockExecuteMultiModel).toHaveBeenNthCalledWith(2,
          expect.stringContaining('Previous debate:'),
          3,
          undefined,
          undefined
        );
      });
    });

    describe('model_roster', () => {
      it('should list all available models', async () => {
        mockGetAvailableModels.mockReturnValue([
          'google/gemini-2.5-pro',
          'anthropic/claude-3.5-sonnet',
          'openai/gpt-4'
        ]);

        const result = await toolHandlers['model_roster']({});

        expect(result.content[0].text).toContain('3 Models Available');
        expect(result.content[0].text).toContain('google/gemini-2.5-pro');
        expect(result.content[0].text).toContain('anthropic/claude-3.5-sonnet');
        expect(result.content[0].text).toContain('openai/gpt-4');
      });

      it('should filter models by search term', async () => {
        mockGetAvailableModels.mockReturnValue([
          'google/gemini-2.5-pro',
          'google/gemini-1.5-flash',
          'anthropic/claude-3.5-sonnet',
          'openai/gpt-4'
        ]);

        const result = await toolHandlers['model_roster']({
          search: 'gemini'
        });

        expect(result.content[0].text).toContain('2 Models Matching "gemini"');
        expect(result.content[0].text).toContain('google/gemini-2.5-pro');
        expect(result.content[0].text).toContain('google/gemini-1.5-flash');
        // The example section will still show anthropic/claude in the usage example
        expect(result.content[0].text).toContain('How to Use Specific Models');
      });

      it('should handle no matching models', async () => {
        mockGetAvailableModels.mockReturnValue(['google/gemini-2.5-pro']);

        const result = await toolHandlers['model_roster']({
          search: 'nonexistent'
        });

        expect(result.content[0].text).toContain('No models found matching "nonexistent"');
      });

      it('should truncate large model lists', async () => {
        const manyModels = Array.from({ length: 50 }, (_, i) => `model-${i}`);
        mockGetAvailableModels.mockReturnValue(manyModels);

        const result = await toolHandlers['model_roster']({});

        expect(result.content[0].text).toContain('...and 30 more models available');
      });
    });
  });

  describe('Private Methods', () => {
    let server: BrutalistServer;

    beforeEach(() => {
      server = new BrutalistServer();
    });

    describe('executeRoast', () => {
      it('should execute with default options', async () => {
        const result = await (server as any).executeRoast({
          userInput: 'Test input'
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          'Test input',
          3,
          undefined,
          undefined
        );
        expect(result.success).toBe(true);
        expect(result.synthesis).toBe('Synthesized brutal feedback');
      });

      it('should use specific models when provided', async () => {
        await (server as any).executeRoast({
          userInput: 'Test input',
          models: ['specific-model-1', 'specific-model-2']
        });

        expect(mockExecuteMultiModel).toHaveBeenCalledWith(
          'Test input',
          3,
          undefined,
          ['specific-model-1', 'specific-model-2']
        );
      });

      it('should handle API errors', async () => {
        mockExecuteMultiModel.mockRejectedValueOnce(new Error('API failed'));

        await expect((server as any).executeRoast({
          userInput: 'Test input'
        })).rejects.toThrow('API failed');
      });
    });

    describe('synthesizeDebate', () => {
      it('should format debate results', () => {
        const responses: ModelResponse[] = [
          { model: 'model1', persona: 'Persona 1', content: 'Round 1 response 1' },
          { model: 'model2', persona: 'Persona 2', content: 'Round 1 response 2' },
          { model: 'model1', persona: 'Persona 1', content: 'Round 2 response 1' },
          { model: 'model2', persona: 'Persona 2', content: 'Round 2 response 2' }
        ];

        const synthesis = (server as any).synthesizeDebate(responses, 2);

        expect(synthesis).toContain('Adversarial Debate: 2 Rounds');
        expect(synthesis).toContain('Round 1');
        expect(synthesis).toContain('Round 2');
        expect(synthesis).toContain('4 total perspectives deployed');
      });
    });

    describe('formatToolResponse', () => {
      it('should format successful response', () => {
        const result = (server as any).formatToolResponse({
          success: true,
          responses: [],
          synthesis: 'Test synthesis'
        });

        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toBe('Test synthesis');
      });

      it('should handle missing synthesis', () => {
        const result = (server as any).formatToolResponse({
          success: true,
          responses: []
        });

        expect(result.content[0].text).toBe('No synthesis available');
      });
    });

    describe('formatErrorResponse', () => {
      it('should format error response', () => {
        const result = (server as any).formatErrorResponse(new Error('Test error'));

        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toBe('Brutalist MCP Error: Test error');
      });

      it('should handle non-Error objects', () => {
        const result = (server as any).formatErrorResponse('String error');

        expect(result.content[0].text).toBe('Brutalist MCP Error: String error');
      });
    });
  });
});