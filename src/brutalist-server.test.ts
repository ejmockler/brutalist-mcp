import { BrutalistServer } from './brutalist-server.js';

// Mock OpenRouter since we don't want to make actual API calls in tests
jest.mock('./openrouter.js', () => ({
  OpenRouterClient: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    getAvailableModels: jest.fn().mockReturnValue(['anthropic/claude-3.5-sonnet', 'google/gemini-2.5-pro']),
    executeMultiModel: jest.fn().mockResolvedValue([
      {
        model: 'anthropic/claude-3.5-sonnet',
        persona: 'Brutal Critic (anthropic/claude-3.5-sonnet)',
        content: 'This code is vulnerable to SQL injection attacks.',
        tokensUsed: 150,
        responseTime: 320
      }
    ]),
    synthesizeResponses: jest.fn().mockReturnValue('Synthesized brutal feedback')
  }))
}));

describe('BrutalistServer', () => {
  beforeEach(() => {
    // Set mock API key for tests
    process.env.OPENROUTER_API_KEY = 'test-key';
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
  });

  describe('Tool Registration', () => {
    it('should have MCP server instance', () => {
      const server = new BrutalistServer();
      expect(server.server).toBeDefined();
    });
  });

  describe('OpenRouter Integration', () => {
    it('should initialize OpenRouter client', () => {
      const server = new BrutalistServer();
      // The OpenRouter client is private, but if no error is thrown during construction,
      // it means the client was initialized successfully
      expect(server).toBeDefined();
    });
  });
});