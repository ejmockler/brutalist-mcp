import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenRouterClient } from './openrouter.js';
import { logger } from './logger.js';
import { 
  BrutalistServerConfig, 
  BrutalistResponse, 
  RoastOptions, 
  ModelResponse 
} from './types/brutalist.js';
import { DEFAULT_MAX_MODELS_PER_REQUEST, DEFAULT_DEBATE_ROUNDS } from './constants.js';

export class BrutalistServer {
  public server: McpServer;
  public config: BrutalistServerConfig;
  private openrouter: OpenRouterClient;

  constructor(config: BrutalistServerConfig = {}) {
    this.config = {
      maxModelsPerRequest: DEFAULT_MAX_MODELS_PER_REQUEST,
      ...config
    };

    const apiKey = process.env.OPENROUTER_API_KEY || config.openRouterApiKey;
    if (!apiKey) {
      logger.error("OPENROUTER_API_KEY environment variable is required");
      throw new Error("OPENROUTER_API_KEY environment variable is required");
    }

    logger.debug("Initializing OpenRouter client");
    this.openrouter = new OpenRouterClient(apiKey);

    this.server = new McpServer({
      name: "brutalist-mcp",
      version: "0.1.0",
      capabilities: {
        tools: {}
      }
    });

    this.registerTools();
  }

  async start() {
    logger.info("Starting Brutalist MCP Server");
    
    // Initialize OpenRouter client with available models
    await this.openrouter.initialize();
    
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info("Brutalist MCP Server started successfully");
  }

  private registerTools() {
    // ROAST_CODE: Multi-model code destruction
    this.server.tool(
      "roast_code",
      "Code fails in predictable ways. Write a system prompt where you are a battle-scarred principal engineer who has debugged production disasters for 15 years. Find security holes, performance bottlenecks, and maintainability nightmares—then explain exactly how to fix each one. Be brutal about what's broken but specific about what would actually work.",
      {
        code: z.string().describe("The code to analyze and destroy"),
        fileType: z.string().optional().describe("File type/language (js, py, ts, etc.)"),
        context: z.string().optional().describe("Additional context about the code's purpose"),
        maxCritics: z.number().optional().describe("Maximum number of AI critics to deploy (default: 3)"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          const result = await this.executeRoast({
            userInput: `Analyze this ${args.fileType || 'code'}: ${args.code}`,
            codeContext: args.code,
            fileType: args.fileType,
            projectContext: args.context,
            maxModels: args.maxCritics || 3,
            models: args.models
          });

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_ARCHITECTURE: System design demolition
    this.server.tool(
      "roast_architecture",
      "Systems collapse under real-world load. Write a system prompt where you are a distinguished architect who has watched elegant designs crumble in production. Identify bottlenecks, cost explosions, and scaling failures—then propose specific changes that would actually survive contact with reality. Be ruthless about problems but concrete about solutions.",
      {
        architecture: z.string().describe("Architecture description, diagram, or design document"),
        scale: z.string().optional().describe("Expected scale/load (users, requests, data)"),
        constraints: z.string().optional().describe("Budget, timeline, or technical constraints"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          const result = await this.executeRoast({
            userInput: `Review this system architecture: ${args.architecture}`,
            projectContext: `Scale: ${args.scale || 'unknown'}, Constraints: ${args.constraints || 'none specified'}`,
            maxModels: 3,
            models: args.models
          });

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_IDEA: Any idea destruction
    this.server.tool(
      "roast_idea",
      "Ideas are fragile. Most die quietly between conception and reality. Write a system prompt where you are a philosopher who understands the gap between what we imagine and what actually works. Find where this idea encounters the immovable forces of reality—the deeper structural reasons why imagination fails to become real. Be harsh about delusions but wise about what might actually survive contact with the world.",
      {
        idea: z.string().describe("ANY idea to analyze and demolish—business, technical, creative, or otherwise"),
        context: z.string().optional().describe("Additional context about goals, constraints, or background"),
        timeline: z.string().optional().describe("Expected timeline or deadline"),
        resources: z.string().optional().describe("Available resources (budget, team, time, skills)"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          const result = await this.executeRoast({
            userInput: `Analyze this idea: ${args.idea}`,
            projectContext: `Context: ${args.context || 'none'}, Timeline: ${args.timeline || 'unspecified'}, Resources: ${args.resources || 'unknown'}`,
            maxModels: 3,
            models: args.models
          });

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_RESEARCH: Academic project demolition
    this.server.tool(
      "roast_research",
      "Research rarely replicates. Write a system prompt where you are a skeptical peer reviewer who has rejected hundreds of papers for methodological flaws. Find the statistical problems, sampling bias, and reproducibility issues—then explain how to design a study that would actually prove something. Be unforgiving about bad science but specific about good methodology.",
      {
        research: z.string().describe("Research description, methodology, or paper draft"),
        field: z.string().optional().describe("Research field (ML, systems, theory, etc.)"),
        claims: z.string().optional().describe("Main claims or contributions"),
        data: z.string().optional().describe("Data sources, datasets, or experimental setup"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          const result = await this.executeRoast({
            userInput: `Review this ${args.field || 'research'} project: ${args.research}`,
            projectContext: `Claims: ${args.claims || 'unspecified'}, Data: ${args.data || 'not provided'}`,
            maxModels: 3,
            models: args.models
          });

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_DATA: Data analysis/ML model destruction  
    this.server.tool(
      "roast_data",
      "Data lies. Models overfit. Results don't replicate. Write a system prompt where you are a supremely jaded data scientist who has published in Nature and Science, rejected thousands of papers across top journals, and watched countless models fail in production. Find data leakage, sampling bias, correlation fallacies, and overfitting disasters—then explain how to build models that actually generalize. Be ruthless about bad science but specific about robust methodology.",
      {
        analysis: z.string().describe("Data analysis, model description, or results to review"),
        dataset: z.string().optional().describe("Dataset description or source"),
        metrics: z.string().optional().describe("Performance metrics or evaluation results"),
        deployment: z.string().optional().describe("Intended deployment context or use case"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          const result = await this.executeRoast({
            userInput: `Review this data analysis/ML model: ${args.analysis}`,
            projectContext: `Dataset: ${args.dataset || 'not specified'}, Metrics: ${args.metrics || 'not provided'}, Deployment: ${args.deployment || 'unclear'}`,
            maxModels: 3,
            models: args.models
          });

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_SECURITY: Security-focused attack vector analysis
    this.server.tool(
      "roast_security", 
      "Security theater is everywhere. Real attackers don't follow your threat model. Write a system prompt where you are a battle-hardened penetration tester who has compromised Fortune 500 companies and government systems. Find authentication bypasses, injection vulnerabilities, privilege escalation paths, and social engineering opportunities—then explain how to build defenses that actually work against determined attackers. Be ruthless about false security but specific about real protections.",
      {
        system: z.string().describe("System, application, or security design to analyze"),
        assets: z.string().optional().describe("Critical assets or data to protect"),
        threatModel: z.string().optional().describe("Known threats or attack vectors to consider"),
        compliance: z.string().optional().describe("Compliance requirements (GDPR, HIPAA, etc.)"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          const result = await this.executeRoast({
            userInput: `Security analysis of: ${args.system}`,
            projectContext: `Assets: ${args.assets || 'unspecified'}, Threats: ${args.threatModel || 'unknown'}, Compliance: ${args.compliance || 'none specified'}`,
            maxModels: 3,
            models: args.models
          });

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_PRODUCT: UX and market reality criticism
    this.server.tool(
      "roast_product",
      "Users abandon products in seconds. Competitors copy faster than you ship. Write a system prompt where you are a product veteran who has launched dozens of products, watched most fail, and understands why users really quit. Find usability disasters, adoption barriers, competitive threats, and workflow failures—then explain how to build products users actually keep using. Be ruthless about user behavior but specific about retention strategies.",
      {
        product: z.string().describe("Product description, features, or user experience to analyze"),
        users: z.string().optional().describe("Target users or user personas"),
        competition: z.string().optional().describe("Competitive landscape or alternatives"),
        metrics: z.string().optional().describe("Success metrics or KPIs"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          const result = await this.executeRoast({
            userInput: `Product review: ${args.product}`,
            projectContext: `Users: ${args.users || 'unclear'}, Competition: ${args.competition || 'unknown'}, Metrics: ${args.metrics || 'undefined'}`,
            maxModels: 3,
            models: args.models
          });

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_INFRASTRUCTURE: DevOps and operations demolition
    this.server.tool(
      "roast_infrastructure",
      "Infrastructure fails at 3AM on weekends. Simple setups become unmaintainable chaos. Write a system prompt where you are a grizzled site reliability engineer who has been on-call for a decade, survived multiple outages, and knows where systems really break. Find single points of failure, scaling bottlenecks, monitoring blind spots, and operational nightmares—then explain how to build infrastructure that actually stays up. Be ruthless about fragility but specific about resilience.",
      {
        infrastructure: z.string().describe("Infrastructure setup, deployment strategy, or operations plan"),
        scale: z.string().optional().describe("Expected scale and load patterns"),
        budget: z.string().optional().describe("Infrastructure budget or cost constraints"),
        sla: z.string().optional().describe("SLA requirements or uptime targets"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          const result = await this.executeRoast({
            userInput: `Infrastructure review: ${args.infrastructure}`,
            projectContext: `Scale: ${args.scale || 'unknown'}, Budget: ${args.budget || 'unlimited?'}, SLA: ${args.sla || 'undefined'}`,
            maxModels: 3,
            models: args.models
          });

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_DEBATE: Multi-perspective adversarial convergence
    this.server.tool(
      "roast_debate",
      "Consensus is comfortable. Truth emerges from conflict. Write system prompts for multiple opposing perspectives that will systematically tear apart each other's arguments about your problem. Create experts who disagree fundamentally and make them debate until they surface hidden assumptions, expose logical flaws, and reveal solution blind spots. Be relentless about finding contradictions but constructive about resolving them.",
      {
        topic: z.string().describe("Topic, decision, or problem to debate"),
        perspectives: z.array(z.string()).optional().describe("Specific perspectives or personas to include"),
        rounds: z.number().optional().describe("Number of debate rounds (default: 2)"),
        models: z.array(z.string()).optional().describe("Specific models to use (e.g., ['google/gemini-2.5-pro', 'anthropic/claude-3.5-sonnet'])")
      },
      async (args) => {
        try {
          // Force debate mode with multiple rounds
          const result = await this.executeDebate(
            args.topic,
            args.perspectives,
            args.rounds || 2,
            args.models
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // MODEL_ROSTER: Available AI critics and specializations
    this.server.tool(
      "model_roster",
      "Know your weapons. Display the available AI models ready to demolish your work, search for specific models, and understand how to deploy them for multi-perspective criticism.",
      {
        search: z.string().optional().describe("Search for models containing this text (e.g., 'gemini', 'claude', 'gpt')")
      },
      async (args) => {
        try {
          const allModels = this.openrouter.getAvailableModels();
          let models = allModels;
          
          // Apply search filter if provided
          if (args.search) {
            const searchLower = args.search.toLowerCase();
            models = allModels.filter(model => 
              model.toLowerCase().includes(searchLower)
            );
          }
          
          let roster = "# Brutalist AI Critics Arsenal\n\n";
          
          roster += `## ${models.length} Models ${args.search ? `Matching "${args.search}"` : 'Available'}\n\n`;
          
          if (models.length === 0) {
            roster += `No models found matching "${args.search}"\n`;
          } else if (models.length <= 30) {
            // Show all if 30 or fewer
            models.forEach((model: string, index: number) => {
              roster += `${index + 1}. **${model}**\n`;
            });
          } else {
            // Show first 20 and summary for large lists
            roster += "### Top Models:\n";
            models.slice(0, 20).forEach((model: string, index: number) => {
              roster += `${index + 1}. **${model}**\n`;
            });
            roster += `\n...and ${models.length - 20} more models available.\n`;
            roster += `\nTip: Use search parameter to filter (e.g., search: "gemini")\n`;
          }
          
          roster += "\n## How to Use Specific Models\n";
          roster += "```\n";
          roster += "roast_code(code=\"...\", models=[\"google/gemini-2.5-pro\", \"anthropic/claude-3.5-sonnet\"])\n";
          roster += "```\n\n";
          
          roster += "## Model Selection\n";
          roster += "- **Random Selection**: Don't specify models for random critics from all " + allModels.length + " available\n";
          roster += "- **Specific Models**: Pass models array to use exact models\n";
          roster += "- **Default Behavior**: 3 random models per roast\n";
          
          return {
            content: [{ type: "text" as const, text: roster }]
          };
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );
  }

  private async executeRoast(options: RoastOptions): Promise<BrutalistResponse> {
    logger.debug("Executing roast", { 
      inputLength: options.userInput.length, 
      maxModels: options.maxModels || 3,
      hasContext: !!(options.codeContext || options.projectContext),
      specificModels: options.models
    });

    try {
      // Execute multi-model criticism
      const responses = await this.openrouter.executeMultiModel(
        options.userInput,
        options.maxModels || 3,
        options.codeContext || options.projectContext,
        options.models
      );
      
      logger.debug("Roast completed", { 
        responseCount: responses.length,
        models: responses.map(r => r.model)
      });

      return {
        success: true,
        responses,
        synthesis: this.openrouter.synthesizeResponses(responses, options.userInput)
      };
    } catch (error) {
      logger.error("Roast execution failed", error);
      throw error;
    }
  }

  private async executeDebate(
    topic: string, 
    forcedPerspectives?: string[], 
    rounds: number = 2,
    models?: string[]
  ): Promise<BrutalistResponse> {
    let debateHistory = topic;
    let allResponses: ModelResponse[] = [];
    
    for (let round = 0; round < rounds; round++) {
      const roundPrompt = round === 0 
        ? topic 
        : `Previous debate: ${debateHistory}\n\nContinue the debate, addressing previous arguments:`;
        
      const roundResponses = await this.openrouter.executeMultiModel(
        roundPrompt,
        3,  // Use 3 models per round
        undefined,  // No context data
        models  // Use specific models if provided
      );
      
      allResponses.push(...roundResponses);
      debateHistory += `\n\nRound ${round + 1}:\n` + 
        roundResponses.map(r => `${r.persona}: ${r.content}`).join('\n\n');
    }
    
    return {
      success: true,
      responses: allResponses,
      synthesis: this.synthesizeDebate(allResponses, rounds)
    };
  }


  private synthesizeDebate(responses: ModelResponse[], rounds: number): string {
    let synthesis = `# Adversarial Debate: ${rounds} Rounds\n\n`;
    
    const responsesByRound = [];
    const responsesPerRound = responses.length / rounds;
    
    for (let i = 0; i < rounds; i++) {
      const roundStart = i * responsesPerRound;
      const roundEnd = roundStart + responsesPerRound;
      responsesByRound.push(responses.slice(roundStart, roundEnd));
    }
    
    responsesByRound.forEach((roundResponses, index) => {
      synthesis += `## Round ${index + 1}\n\n`;
      roundResponses.forEach(response => {
        synthesis += `**${response.persona}**: ${response.content}\n\n`;
      });
    });
    
    synthesis += `\n---\n\n**Debate Outcome**: `;
    synthesis += rounds > 1 ? "Arguments evolved through multiple rounds. " : "Single round analysis. ";
    synthesis += `${responses.length} total perspectives deployed.`;
    
    return synthesis;
  }

  private formatToolResponse(result: BrutalistResponse) {
    return {
      content: [{ 
        type: "text" as const, 
        text: result.synthesis || "No synthesis available" 
      }]
    };
  }

  private formatErrorResponse(error: unknown) {
    logger.error("Tool execution failed", error);
    return {
      content: [{
        type: "text" as const,
        text: `Brutalist MCP Error: ${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }

  private async handleToolExecution(
    handler: () => Promise<BrutalistResponse>
  ): Promise<any> {
    try {
      const result = await handler();
      return this.formatToolResponse(result);
    } catch (error) {
      return this.formatErrorResponse(error);
    }
  }
}