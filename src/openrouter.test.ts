import { OpenRouterClient } from './openrouter.js';
import OpenAI from 'openai';

// Mock OpenAI
jest.mock('openai');

// Mock model-fetcher
jest.mock('./model-fetcher.js', () => ({
  modelFetcher: {
    getAvailableModels: jest.fn().mockResolvedValue([
      'model1',
      'model2',
      'model3',
      'model4',
      'model5'
    ])
  }
}));

describe('OpenRouterClient', () => {
  let client: OpenRouterClient;
  let mockCreate: jest.Mock;

  beforeEach(() => {
    mockCreate = jest.fn();
    (OpenAI as jest.MockedClass<typeof OpenAI>).mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate
        }
      }
    } as any));

    client = new OpenRouterClient('test-api-key');
  });

  describe('initialize', () => {
    it('should fetch available models on initialization', async () => {
      await client.initialize();
      
      const models = client.getAvailableModels();
      expect(models).toEqual(['model1', 'model2', 'model3', 'model4', 'model5']);
    });
  });

  describe('executePrompt', () => {
    beforeEach(async () => {
      await client.initialize();
    });

    it('should execute prompt with a single model using streaming', async () => {
      // Mock streaming response
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Test ' } }] };
          yield { choices: [{ delta: { content: 'response' } }] };
          yield { usage: { total_tokens: 100 } };
        }
      };
      mockCreate.mockResolvedValueOnce(mockStream);

      const result = await client.executePrompt('Test prompt', 'model1');
      
      expect(mockCreate).toHaveBeenCalledWith({
        model: 'model1',
        messages: [
          { role: 'user', content: 'Test prompt' }
        ],
        temperature: 0.7,
        max_tokens: 2000,
        stream: true
      });
      
      expect(result).toMatchObject({
        model: 'model1',
        persona: 'Brutal Critic (model1)',
        content: 'Test response',
        tokensUsed: 100
      });
    });

    it('should include context data when provided', async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Response' } }] };
        }
      };
      mockCreate.mockResolvedValueOnce(mockStream);

      await client.executePrompt('Prompt', 'model1', 'Context data');
      
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'Prompt\n\nContext: Context data' }
          ],
          stream: true
        })
      );
    });

    it('should handle streaming callback', async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Hello ' } }] };
          yield { choices: [{ delta: { content: 'world' } }] };
        }
      };
      mockCreate.mockResolvedValueOnce(mockStream);

      const chunks: string[] = [];
      const onStream = (chunk: string) => chunks.push(chunk);
      
      const result = await client.executePrompt('Test', 'model1', undefined, onStream);
      
      expect(chunks).toEqual(['Hello ', 'world']);
      expect(result.content).toBe('Hello world');
    });

    it('should handle API errors', async () => {
      mockCreate.mockRejectedValueOnce(new Error('API Error'));

      await expect(
        client.executePrompt('Test', 'model1')
      ).rejects.toThrow('OpenRouter API error for model model1: API Error');
    });
  });

  describe('executeMultiModel', () => {
    beforeEach(async () => {
      await client.initialize();
    });

    it('should execute with random models when none specified', async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Response' } }] };
          yield { usage: { total_tokens: 50 } };
        }
      };
      mockCreate.mockResolvedValue(mockStream);

      const results = await client.executeMultiModel('Test prompt', 2);
      
      expect(results).toHaveLength(2);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('should execute with specific models when provided', async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Response' } }] };
        }
      };
      mockCreate.mockResolvedValue(mockStream);

      const results = await client.executeMultiModel(
        'Test prompt',
        3,
        undefined,
        ['model1', 'model3']
      );
      
      expect(results).toHaveLength(2);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'model1', stream: true })
      );
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'model3', stream: true })
      );
    });

    it('should handle invalid models gracefully', async () => {
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Response' } }] };
        }
      };
      mockCreate.mockResolvedValue(mockStream);

      const results = await client.executeMultiModel(
        'Test prompt',
        3,
        undefined,
        ['invalid1', 'invalid2']
      );
      
      // Should fall back to random selection
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return partial results on some failures', async () => {
      const successStream1 = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Success' } }] };
        }
      };
      const successStream2 = {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'Success2' } }] };
        }
      };
      
      mockCreate
        .mockResolvedValueOnce(successStream1)
        .mockRejectedValueOnce(new Error('Failed'))
        .mockResolvedValueOnce(successStream2);

      const results = await client.executeMultiModel('Test', 3);
      
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe('Success');
      expect(results[1].content).toBe('Success2');
    });

    it('should throw error when no models available', async () => {
      // Reset with empty models
      jest.resetModules();
      jest.doMock('./model-fetcher.js', () => ({
        modelFetcher: {
          getAvailableModels: jest.fn().mockResolvedValue([])
        }
      }));
      
      const { OpenRouterClient: FreshClient } = await import('./openrouter.js');
      const emptyClient = new FreshClient('test-key');
      await emptyClient.initialize();

      await expect(
        emptyClient.executeMultiModel('Test', 3)
      ).rejects.toThrow('No valid models available for execution');
    });
  });

  describe('synthesizeResponses', () => {
    beforeEach(async () => {
      await client.initialize();
    });

    it('should handle empty responses', () => {
      const result = client.synthesizeResponses([], 'prompt');
      expect(result).toBe('No responses received from models.');
    });

    it('should format single response', () => {
      const responses = [{
        model: 'model1',
        persona: 'Critic',
        content: 'Feedback',
        responseTime: 100
      }];

      const result = client.synthesizeResponses(responses, 'prompt');
      expect(result).toContain('**Critic** (model1)');
      expect(result).toContain('Feedback');
    });

    it('should synthesize multiple responses', () => {
      const responses = [
        {
          model: 'model1',
          persona: 'Critic1',
          content: 'This will fail',
          responseTime: 100
        },
        {
          model: 'model2',
          persona: 'Critic2',
          content: 'Major problem here',
          responseTime: 150
        }
      ];

      const result = client.synthesizeResponses(responses, 'prompt');
      expect(result).toContain('# Brutalist Analysis: 2 AI Critics');
      expect(result).toContain('Critic1');
      expect(result).toContain('Critic2');
      expect(result).toContain('Key Themes Across Critics');
      expect(result).toContain('fail');
    });

    it('should include response times when available', () => {
      const responses = [
        {
          model: 'model1',
          persona: 'Critic1',
          content: 'Feedback1',
          responseTime: 100
        },
        {
          model: 'model2',
          persona: 'Critic2',
          content: 'Feedback2',
          responseTime: 200
        }
      ];

      const result = client.synthesizeResponses(responses, 'prompt');
      expect(result).toContain('100ms');
      expect(result).toContain('200ms');
    });
  });

  describe('getAvailableModels', () => {
    it('should return empty array before initialization', () => {
      const newClient = new OpenRouterClient('test-key');
      expect(newClient.getAvailableModels()).toEqual([]);
    });

    it('should return models after initialization', async () => {
      await client.initialize();
      expect(client.getAvailableModels()).toEqual([
        'model1', 'model2', 'model3', 'model4', 'model5'
      ]);
    });
  });
});