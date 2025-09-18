import { OpenRouterClient } from './openrouter';
import { BrutalistServer } from './brutalist-server';
import { ModelFetcher } from './model-fetcher';
import { BrutalistResponse } from './types/brutalist';

// Skip these tests in normal test runs, only run with INTEGRATION_TEST=true
const describeIntegration = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;

describeIntegration('Integration Tests', () => {
  const API_KEY = process.env.OPENROUTER_API_KEY;
  if (!API_KEY) {
    throw new Error('OPENROUTER_API_KEY environment variable is required for integration tests');
  }
  let client: OpenRouterClient;
  let server: BrutalistServer;

  beforeAll(() => {
    client = new OpenRouterClient(API_KEY);
    server = new BrutalistServer({ openRouterApiKey: API_KEY });
  });

  describe('Model Fetcher', () => {
    it('should fetch available models from OpenRouter', async () => {
      const fetcher = ModelFetcher.getInstance();
      const models = await fetcher.getAvailableModels();
      
      expect(models).toBeDefined();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(100); // Should have 325+ models
      
      // Check for specific popular models
      expect(models).toEqual(expect.arrayContaining([
        expect.stringContaining('gemini'),
        expect.stringContaining('gpt'),
        expect.stringContaining('claude')
      ]));
    }, 30000); // 30 second timeout for API call

    it('should filter models by search term', async () => {
      const fetcher = ModelFetcher.getInstance();
      const models = await fetcher.getAvailableModels();
      
      const geminiModels = models.filter(m => 
        m.toLowerCase().includes('gemini')
      );
      
      expect(geminiModels.length).toBeGreaterThan(0);
      expect(geminiModels.every(m => 
        m.toLowerCase().includes('gemini')
      )).toBe(true);
    });
  });

  describe('OpenRouter Client', () => {
    beforeEach(async () => {
      await client.initialize();
    }, 30000);

    it('should execute a simple roast with gemini-2.0-flash', async () => {
      // Check what models are actually available
      const availableModels = client.getAvailableModels();
      console.log('Available models:', availableModels.slice(0, 10)); // Log first 10
      
      // Find a working Gemini model
      const geminiModel = availableModels.find(m => m.includes('gemini') && m.includes('flash'));
      const modelToUse = geminiModel || 'google/gemini-2.0-flash-exp:free';
      console.log('Using model:', modelToUse);
      
      const result = await client.executeMultiModel(
        'I want to build another todo app',
        1,
        undefined,
        [modelToUse]
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(1);
      expect(result[0].model).toBe(modelToUse);
      expect(result[0].content).toBeTruthy();
      expect(result[0].content.length).toBeGreaterThan(50);
    }, 30000);

    it('should execute multi-model roast', async () => {
      const availableModels = client.getAvailableModels();
      const geminiModel = availableModels.find(m => m.includes('gemini')) || availableModels[0];
      const llamaModel = availableModels.find(m => m.includes('llama')) || availableModels[1];
      
      const result = await client.executeMultiModel(
        'We are using 47 microservices for our startup MVP',
        2,
        undefined,
        [geminiModel, llamaModel]
      );

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      
      // Check each model responded
      const modelIds = result.map(r => r.model);
      expect(modelIds).toContain(geminiModel);
      expect(modelIds).toContain(llamaModel);
    }, 30000);

    it('should handle code roasting with context', async () => {
      const badCode = `
function processData(d) {
  var x = d;
  for (var i = 0; i < x.length; i++) {
    if (x[i] == null) {
      x[i] = 0;
    }
  }
  return x;
}`;

      const availableModels = client.getAvailableModels();
      const modelToUse = availableModels.find(m => m.includes('gemini')) || availableModels[0];
      
      const result = await client.executeMultiModel(
        badCode,
        1,
        'File type: javascript',
        [modelToUse]
      );

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toBeDefined();
      expect(result[0].content).toBeTruthy();
      
      const criticism = result[0].content.toLowerCase();
      expect(
        criticism.includes('var') || 
        criticism.includes('naming') || 
        criticism.includes('mutation') ||
        criticism.includes('variable') ||
        criticism.includes('clarity')
      ).toBe(true);
    }, 30000);

    it('should handle rate limiting gracefully', async () => {
      const availableModels = client.getAvailableModels();
      // Try to make multiple concurrent requests
      const promises = Array(3).fill(null).map((_, i) => 
        client.executeMultiModel(
          `Idea ${i}: AI-powered fortune telling app`,
          1,
          undefined,
          [availableModels[0] || 'google/gemini-2.0-flash-exp:free']
        )
      );

      const results = await Promise.allSettled(promises);
      
      // At least some should succeed
      const successful = results.filter(r => r.status === 'fulfilled');
      expect(successful.length).toBeGreaterThan(0);
      
      // If any failed, they should have proper error messages
      const failed = results.filter(r => r.status === 'rejected');
      failed.forEach(r => {
        if (r.status === 'rejected') {
          expect(r.reason).toBeDefined();
        }
      });
    }, 60000); // 60 second timeout for multiple requests
  });

  describe('Brutalist Server Tools', () => {
    it('should handle roast_debate with multiple models', async () => {
      const debate = await server['executeRoast']({
        userInput: 'Should we use TypeScript or JavaScript for our new project?',
        maxModels: 2,
        models: ['google/gemini-2.0-flash-exp:free', 'meta-llama/llama-3.2-3b-instruct:free']
      });

      expect(debate).toBeDefined();
      expect(debate.success).toBe(true);
      expect(debate.responses).toBeDefined();
      expect(debate.responses.length).toBeGreaterThanOrEqual(2); // At least initial responses
      
      // Check for debate structure
      const hasDebateRounds = debate.responses.some(r => 
        r.content.includes('Round') || 
        r.content.includes('response') ||
        r.content.includes('argument')
      );
      expect(hasDebateRounds).toBe(true);
    }, 60000);

    it('should handle model_roster tool', async () => {
      await client.initialize();
      const models = await client.getAvailableModels();
      
      expect(models).toBeDefined();
      expect(models.length).toBeGreaterThan(100);
      
      // Test searching for gemini models
      const geminiModels = models.filter(m => 
        m.toLowerCase().includes('gemini')
      );
      expect(geminiModels.length).toBeGreaterThan(0);
    }, 30000);

    it('should handle errors gracefully', async () => {
      // Test with invalid model
      const result = await client.executeMultiModel(
        'Test idea',
        1,
        undefined,
        ['invalid-model-that-does-not-exist']
      );

      // Should either skip invalid model or return empty array
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    }, 30000);

    it('should respect max models configuration', async () => {
      const result = await server['executeRoast']({
        userInput: 'console.log("hello")',
        maxModels: 1
      });

      expect(result.success).toBe(true);
      expect(result.responses.length).toBe(1);
    }, 30000);
  });

  describe('Real-world scenarios', () => {
    it('should provide meaningful architecture criticism', async () => {
      const availableModels = client.getAvailableModels();
      const modelToUse = availableModels.find(m => m.includes('gemini')) || availableModels[0];
      
      const result = await client.executeMultiModel(
        `Our architecture:
        - 47 microservices for 10 users
        - Each service has its own database
        - No API gateway
        - No service discovery
        - Manual deployment via FTP`,
        1,
        undefined,
        [modelToUse]
      );

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toBeDefined();
      expect(result[0].content).toBeDefined();
      
      const criticism = result[0].content.toLowerCase();
      
      // Should identify major issues
      expect(
        criticism.includes('microservice') ||
        criticism.includes('complex') ||
        criticism.includes('overhead') ||
        criticism.includes('overkill')
      ).toBe(true);
      
      expect(
        criticism.includes('database') ||
        criticism.includes('consistency') ||
        criticism.includes('transaction')
      ).toBe(true);
    }, 30000);

    it('should provide meaningful security criticism', async () => {
      const availableModels = client.getAvailableModels();
      const modelToUse = availableModels.find(m => m.includes('gemini')) || availableModels[0];
      
      const result = await client.executeMultiModel(
        `Our security approach:
        - Passwords stored in plain text
        - No HTTPS, just HTTP
        - API keys hardcoded in frontend
        - No rate limiting
        - SQL queries built with string concatenation`,
        1,
        undefined,
        [modelToUse]
      );

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toBeDefined();
      expect(result[0].content).toBeDefined();
      
      const criticism = result[0].content.toLowerCase();
      
      // Should identify critical security issues
      expect(
        criticism.includes('plain') ||
        criticism.includes('hash') ||
        criticism.includes('bcrypt') ||
        criticism.includes('password')
      ).toBe(true);
      
      expect(
        criticism.includes('sql') ||
        criticism.includes('injection') ||
        criticism.includes('parameterized')
      ).toBe(true);
    }, 30000);
  });
});

// Add a simple smoke test that always runs
describe('Smoke Tests', () => {
  it('should create server instance', () => {
    const server = new BrutalistServer({ 
      openRouterApiKey: 'test-key' 
    });
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });

  it('should create client instance', () => {
    const client = new OpenRouterClient('test-key');
    expect(client).toBeDefined();
  });
});