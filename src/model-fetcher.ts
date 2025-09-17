import { logger } from './logger.js';
import { MODEL_CACHE_DURATION_MS, OPENROUTER_MODELS_ENDPOINT } from './constants.js';

interface ModelData {
  id: string;
  name: string;
  pricing?: {
    prompt: string;
    completion: string;
  };
}

interface ModelsResponse {
  data: ModelData[];
}

export class ModelFetcher {
  private static instance: ModelFetcher;
  private cachedModels: string[] | null = null;
  private cacheTimestamp: number = 0;
  
  // Minimal fallback if API fails
  private readonly FALLBACK_MODELS = [
    "anthropic/claude-3.5-sonnet",
    "openai/gpt-4o",
    "google/gemini-2.5-pro",
    "meta-llama/llama-3.1-8b-instruct",
    "mistralai/mixtral-8x7b-instruct"
  ];

  private constructor() {}

  static getInstance(): ModelFetcher {
    if (!ModelFetcher.instance) {
      ModelFetcher.instance = new ModelFetcher();
    }
    return ModelFetcher.instance;
  }

  async getAvailableModels(): Promise<string[]> {
    // Check cache
    if (this.cachedModels && (Date.now() - this.cacheTimestamp < MODEL_CACHE_DURATION_MS)) {
      logger.debug("Using cached models", { count: this.cachedModels.length });
      return this.cachedModels;
    }

    try {
      logger.info("Fetching available models from OpenRouter");
      
      const response = await fetch(OPENROUTER_MODELS_ENDPOINT);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data: ModelsResponse = await response.json();
      
      if (!data.data || !Array.isArray(data.data)) {
        throw new Error("Invalid response format from OpenRouter API");
      }
      
      // Extract model IDs
      const models = data.data.map(model => model.id);
      
      if (models.length === 0) {
        throw new Error("No models returned from API");
      }
      
      // Update cache
      this.cachedModels = models;
      this.cacheTimestamp = Date.now();
      
      logger.info(`Successfully fetched ${models.length} available models from OpenRouter`);
      
      return models;
    } catch (error) {
      logger.error("Failed to fetch models from OpenRouter, using fallback", error);
      return this.FALLBACK_MODELS;
    }
  }

  async searchModels(query: string): Promise<string[]> {
    const allModels = await this.getAvailableModels();
    const lowerQuery = query.toLowerCase();
    
    return allModels.filter(model => 
      model.toLowerCase().includes(lowerQuery)
    );
  }

  async getModelsByProvider(provider: string): Promise<string[]> {
    const allModels = await this.getAvailableModels();
    const lowerProvider = provider.toLowerCase();
    
    return allModels.filter(model => 
      model.toLowerCase().startsWith(lowerProvider + "/")
    );
  }

  clearCache(): void {
    this.cachedModels = null;
    this.cacheTimestamp = 0;
    logger.debug("Model cache cleared");
  }
}

export const modelFetcher = ModelFetcher.getInstance();