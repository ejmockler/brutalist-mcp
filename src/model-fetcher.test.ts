import { ModelFetcher } from './model-fetcher.js';

// Mock fetch globally
global.fetch = jest.fn();

describe('ModelFetcher', () => {
  let fetcher: ModelFetcher;

  beforeEach(() => {
    // Clear singleton instance for each test
    (ModelFetcher as any).instance = null;
    fetcher = ModelFetcher.getInstance();
    jest.clearAllMocks();
    // Clear cache
    fetcher.clearCache();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ModelFetcher.getInstance();
      const instance2 = ModelFetcher.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getAvailableModels', () => {
    const mockResponse = {
      data: [
        { id: 'model1', name: 'Model 1' },
        { id: 'model2', name: 'Model 2' },
        { id: 'model3', name: 'Model 3' }
      ]
    };

    it('should fetch models from API', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const models = await fetcher.getAvailableModels();
      
      expect(fetch).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models');
      expect(models).toEqual(['model1', 'model2', 'model3']);
    });

    it('should use cached models on second call', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse
      });

      const models1 = await fetcher.getAvailableModels();
      const models2 = await fetcher.getAvailableModels();
      
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(models1).toEqual(models2);
    });

    it('should return fallback models on API error', async () => {
      (fetch as jest.Mock).mockRejectedValueOnce(new Error('Network error'));

      const models = await fetcher.getAvailableModels();
      
      expect(models).toEqual([
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "google/gemini-2.5-pro",
        "meta-llama/llama-3.1-8b-instruct",
        "mistralai/mixtral-8x7b-instruct"
      ]);
    });

    it('should return fallback models on invalid response', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ invalid: 'response' })
      });

      const models = await fetcher.getAvailableModels();
      
      expect(models).toContain("anthropic/claude-3.5-sonnet");
    });

    it('should return fallback models on HTTP error', async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 500
      });

      const models = await fetcher.getAvailableModels();
      
      expect(models).toContain("google/gemini-2.5-pro");
    });
  });

  describe('searchModels', () => {
    beforeEach(async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'google/gemini-pro' },
            { id: 'google/gemini-flash' },
            { id: 'anthropic/claude-3' },
            { id: 'openai/gpt-4' }
          ]
        })
      });
    });

    it('should filter models by search query', async () => {
      const results = await fetcher.searchModels('gemini');
      
      expect(results).toEqual([
        'google/gemini-pro',
        'google/gemini-flash'
      ]);
    });

    it('should be case insensitive', async () => {
      const results = await fetcher.searchModels('GEMINI');
      
      expect(results).toHaveLength(2);
      expect(results[0]).toContain('gemini');
    });

    it('should return empty array for no matches', async () => {
      const results = await fetcher.searchModels('nonexistent');
      
      expect(results).toEqual([]);
    });
  });

  describe('getModelsByProvider', () => {
    beforeEach(async () => {
      (fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'google/gemini-pro' },
            { id: 'google/gemini-flash' },
            { id: 'anthropic/claude-3' },
            { id: 'openai/gpt-4' }
          ]
        })
      });
    });

    it('should filter models by provider', async () => {
      const results = await fetcher.getModelsByProvider('google');
      
      expect(results).toEqual([
        'google/gemini-pro',
        'google/gemini-flash'
      ]);
    });

    it('should be case insensitive', async () => {
      const results = await fetcher.getModelsByProvider('GOOGLE');
      
      expect(results).toHaveLength(2);
    });
  });

  describe('clearCache', () => {
    it('should clear cached models', async () => {
      (fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ id: 'model1' }]
        })
      });

      await fetcher.getAvailableModels();
      expect(fetch).toHaveBeenCalledTimes(1);
      
      fetcher.clearCache();
      
      await fetcher.getAvailableModels();
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });
});