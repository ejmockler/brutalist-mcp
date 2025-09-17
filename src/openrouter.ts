import OpenAI from 'openai';
import { ModelResponse } from './types/brutalist.js';
import { modelFetcher } from './model-fetcher.js';
import { logger } from './logger.js';
import { 
  OPENROUTER_BASE_URL, 
  GITHUB_REPO_URL, 
  DEFAULT_TEMPERATURE, 
  DEFAULT_MAX_TOKENS,
  SYNTHESIS_MAX_THEMES 
} from './constants.js';

export class OpenRouterClient {
  private client: OpenAI;
  private availableModels: string[] = [];
  
  constructor(apiKey: string) {
    this.client = new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey: apiKey,
      defaultHeaders: {
        "HTTP-Referer": GITHUB_REPO_URL,
        "X-Title": "Brutalist MCP"
      }
    });
  }

  async initialize(): Promise<void> {
    this.availableModels = await modelFetcher.getAvailableModels();
    logger.debug(`OpenRouter client initialized with ${this.availableModels.length} available models`);
  }


  private getRandomModels(count: number): string[] {
    if (this.availableModels.length === 0) {
      logger.warn("No models available, using empty array");
      return [];
    }
    const shuffled = [...this.availableModels].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, this.availableModels.length));
  }

  private getSpecificModels(requestedModels: string[]): string[] {
    // Validate requested models exist
    const validModels = requestedModels.filter(model => 
      this.availableModels.includes(model)
    );
    
    if (validModels.length === 0) {
      logger.warn(`None of the requested models are available: ${requestedModels.join(', ')}`);
      // Fall back to random selection
      return this.getRandomModels(Math.min(3, requestedModels.length));
    }
    
    if (validModels.length < requestedModels.length) {
      const invalid = requestedModels.filter(m => !this.availableModels.includes(m));
      logger.warn(`Some requested models not available: ${invalid.join(', ')}`);
    }
    
    return validModels;
  }

  async executePrompt(
    prompt: string, 
    model: string, 
    contextData?: string
  ): Promise<ModelResponse> {
    const startTime = Date.now();
    
    // No system prompt - let the LLM using MCP generate its own based on tool descriptions
    const userPrompt = prompt + (contextData ? `\n\nContext: ${contextData}` : '');
    
    try {
      const completion = await this.client.chat.completions.create({
        model: model,
        messages: [
          { role: "user", content: userPrompt }
        ],
        temperature: DEFAULT_TEMPERATURE,
        max_tokens: DEFAULT_MAX_TOKENS
      });

      const responseTime = Date.now() - startTime;
      const content = completion.choices[0]?.message?.content || '';
      
      return {
        model: model,
        persona: `Brutal Critic (${model})`,
        content: content,
        tokensUsed: completion.usage?.total_tokens,
        responseTime: responseTime
      };
    } catch (error) {
      throw new Error(`OpenRouter API error for model ${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async executeMultiModel(
    prompt: string,
    maxModels: number = 3,
    contextData?: string,
    specificModels?: string[]
  ): Promise<ModelResponse[]> {
    const selectedModels = specificModels 
      ? this.getSpecificModels(specificModels)
      : this.getRandomModels(maxModels);
    
    if (selectedModels.length === 0) {
      throw new Error("No valid models available for execution");
    }
    
    const promises = selectedModels.map(model => 
      this.executePrompt(prompt, model, contextData)
    );
    
    try {
      return await Promise.all(promises);
    } catch (error) {
      // If any model fails, still return partial results
      const results = await Promise.allSettled(promises);
      return results
        .filter((result): result is PromiseFulfilledResult<ModelResponse> => 
          result.status === 'fulfilled'
        )
        .map(result => result.value);
    }
  }

  getAvailableModels(): string[] {
    return this.availableModels;
  }


  synthesizeResponses(responses: ModelResponse[], originalPrompt: string): string {
    if (responses.length === 0) {
      return "No responses received from models.";
    }
    
    if (responses.length === 1) {
      return `**${responses[0].persona}** (${responses[0].model}):\n${responses[0].content}`;
    }

    let synthesis = `# Brutalist Analysis: ${responses.length} AI Critics\n\n`;
    
    // Group by persona for clarity
    responses.forEach((response, index) => {
      synthesis += `## ${response.persona} (${response.model})\n`;
      synthesis += `${response.content}\n\n`;
      
      if (response.responseTime) {
        synthesis += `*Response time: ${response.responseTime}ms*\n\n`;
      }
    });
    
    // Add summary if multiple perspectives
    if (responses.length > 1) {
      synthesis += `---\n\n**Key Themes Across Critics:**\n`;
      
      // Extract common themes (simple keyword analysis)
      const allContent = responses.map(r => r.content.toLowerCase()).join(' ');
      const criticalTerms = ['fail', 'problem', 'issue', 'vulnerable', 'slow', 'expensive', 'complex', 'difficult'];
      const foundTerms = criticalTerms.filter(term => allContent.includes(term));
      
      if (foundTerms.length > 0) {
        synthesis += `Multiple critics highlighted: ${foundTerms.slice(0, SYNTHESIS_MAX_THEMES).join(', ')}\n`;
      }
    }
    
    return synthesis;
  }
}