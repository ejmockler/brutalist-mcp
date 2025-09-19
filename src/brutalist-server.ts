import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CLIAgentOrchestrator, BrutalistPromptType } from './cli-agents.js';
import { logger } from './logger.js';
import { 
  BrutalistServerConfig, 
  BrutalistResponse, 
  RoastOptions, 
  CLIAgentResponse 
} from './types/brutalist.js';

// Package version - updated by build process
const PACKAGE_VERSION = "0.1.3";

export class BrutalistServer {
  public server: McpServer;
  public config: BrutalistServerConfig;
  private cliOrchestrator: CLIAgentOrchestrator;

  constructor(config: BrutalistServerConfig = {}) {
    this.config = {
      workingDirectory: process.cwd(),
      defaultTimeout: 30000,
      enableSandbox: true,
      ...config
    };

    logger.debug("Initializing CLI Agent Orchestrator");
    this.cliOrchestrator = new CLIAgentOrchestrator();

    this.server = new McpServer({
      name: "brutalist-mcp",
      version: PACKAGE_VERSION,
      capabilities: {
        tools: {}
      }
    });

    this.registerTools();
  }

  async start() {
    logger.info("Starting Brutalist MCP Server with CLI Agents");
    
    // Initialize CLI context detection
    try {
      await this.cliOrchestrator.detectCLIContext();
      logger.info("CLI context detection completed");
    } catch (error) {
      logger.warn("CLI context detection failed", error);
    }
    
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info("Brutalist MCP Server started successfully");
  }

  private registerTools() {
    // ROAST_CODEBASE: Systematic destruction of entire codebase
    this.server.tool(
      "roast_codebase",
      "Deploy brutal AI critics to systematically destroy your entire codebase. These AI agents will navigate your directories, read your actual files, and find every architectural disaster, security vulnerability, and maintainability nightmare lurking in your project. They treat this like code that will kill people if it fails.",
      {
        targetPath: z.string().describe("Path to analyze (file or directory)"),
        context: z.string().optional().describe("Additional context about the codebase purpose"),
        workingDirectory: z.string().optional().describe("Working directory to execute from"),
        enableSandbox: z.boolean().optional().describe("Enable sandbox mode for safe analysis (default: true)")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "codebase",
            args.targetPath,
            "codeAnalysis",
            args.context,
            args.workingDirectory,
            args.enableSandbox
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_FILE_STRUCTURE: Directory hierarchy demolition
    this.server.tool(
      "roast_file_structure",
      "Deploy brutal AI critics to systematically destroy your file organization. These agents will navigate your actual directory structure and expose every organizational disaster, naming convention failure, and structural nightmare that makes your codebase unmaintainable.",
      {
        targetPath: z.string().describe("Directory path to analyze"),
        depth: z.number().optional().describe("Maximum directory depth to analyze (default: 3)"),
        context: z.string().optional().describe("Additional context about the project structure"),
        workingDirectory: z.string().optional().describe("Working directory to execute from")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "file_structure",
            args.targetPath,
            "fileStructure",
            `Project structure analysis (depth: ${args.depth || 3}). ${args.context || ''}`,
            args.workingDirectory
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_DEPENDENCIES: Package management demolition
    this.server.tool(
      "roast_dependencies",
      "Deploy brutal AI critics to systematically destroy your dependency management. These agents will read your actual package files, analyze version conflicts, and expose every security vulnerability and compatibility nightmare in your dependency tree.",
      {
        targetPath: z.string().describe("Path to package file (package.json, requirements.txt, Cargo.toml, etc.)"),
        includeDevDeps: z.boolean().optional().describe("Include development dependencies in analysis (default: true)"),
        context: z.string().optional().describe("Additional context about the project dependencies"),
        workingDirectory: z.string().optional().describe("Working directory to execute from")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "dependencies",
            args.targetPath,
            "dependencies",
            `Dependency analysis (dev deps: ${args.includeDevDeps ?? true}). ${args.context || ''}`,
            args.workingDirectory
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_GIT_HISTORY: Version control demolition
    this.server.tool(
      "roast_git_history",
      "Deploy brutal AI critics to systematically destroy your git history and development practices. These agents will analyze your actual commit history, branching strategy, and code evolution to expose every workflow disaster and collaboration nightmare.",
      {
        targetPath: z.string().describe("Git repository path to analyze"),
        commitRange: z.string().optional().describe("Commit range to analyze (e.g., 'HEAD~10..HEAD', default: last 20 commits)"),
        context: z.string().optional().describe("Additional context about the development workflow"),
        workingDirectory: z.string().optional().describe("Working directory to execute from")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "git_history",
            args.targetPath,
            "gitHistory",
            `Git history analysis (range: ${args.commitRange || 'last 20 commits'}). ${args.context || ''}`,
            args.workingDirectory
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_TEST_COVERAGE: Testing infrastructure demolition
    this.server.tool(
      "roast_test_coverage",
      "Deploy brutal AI critics to systematically destroy your testing strategy. These agents will analyze your actual test files, run coverage reports, and expose every testing gap and quality assurance nightmare that will let bugs slip into production.",
      {
        targetPath: z.string().describe("Path to test directory or test configuration file"),
        runCoverage: z.boolean().optional().describe("Attempt to run coverage analysis (default: true)"),
        context: z.string().optional().describe("Additional context about the testing strategy"),
        workingDirectory: z.string().optional().describe("Working directory to execute from")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "test_coverage",
            args.targetPath,
            "testCoverage",
            `Test coverage analysis (run coverage: ${args.runCoverage ?? true}). ${args.context || ''}`,
            args.workingDirectory
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_IDEA: Any idea destruction
    this.server.tool(
      "roast_idea",
      "Deploy brutal AI critics to systematically destroy ANY idea - business, technical, creative, or otherwise. These critics understand the gap between imagination and reality, finding where your concept will encounter the immovable forces of the world. They are harsh about delusions but wise about what might actually survive.",
      {
        idea: z.string().describe("ANY idea to analyze and demolish - business, technical, creative, or otherwise"),
        context: z.string().optional().describe("Additional context about goals, constraints, or background"),
        timeline: z.string().optional().describe("Expected timeline or deadline"),
        resources: z.string().optional().describe("Available resources (budget, team, time, skills)")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "idea",
            args.idea,
            "idea",
            `Context: ${args.context || 'none'}, Timeline: ${args.timeline || 'unspecified'}, Resources: ${args.resources || 'unknown'}`
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_ARCHITECTURE: System design demolition
    this.server.tool(
      "roast_architecture", 
      "Deploy brutal AI critics to systematically destroy your system architecture. These critics have watched elegant designs collapse under real load, identifying every bottleneck, cost explosion, and scaling failure that will destroy your system. They are ruthless about why this won't survive production.",
      {
        architecture: z.string().describe("Architecture description, diagram, or design document"),
        scale: z.string().optional().describe("Expected scale/load (users, requests, data)"),
        constraints: z.string().optional().describe("Budget, timeline, or technical constraints"),
        deployment: z.string().optional().describe("Deployment environment and strategy")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "architecture",
            args.architecture,
            "architecture",
            `Scale: ${args.scale || 'unknown'}, Constraints: ${args.constraints || 'none specified'}, Deployment: ${args.deployment || 'unclear'}`
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_RESEARCH: Academic project demolition  
    this.server.tool(
      "roast_research",
      "Deploy brutal AI critics to systematically demolish your research methodology. These critics are supremely jaded peer reviewers who have rejected thousands of papers and watched countless studies fail to replicate. They find every statistical flaw, sampling bias, and reproducibility nightmare.",
      {
        research: z.string().describe("Research description, methodology, or paper draft"),
        field: z.string().optional().describe("Research field (ML, systems, theory, etc.)"),
        claims: z.string().optional().describe("Main claims or contributions"),
        data: z.string().optional().describe("Data sources, datasets, or experimental setup")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "research",
            args.research,
            "research",
            `Field: ${args.field || 'unspecified'}, Claims: ${args.claims || 'unclear'}, Data: ${args.data || 'not provided'}`
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_SECURITY: Security-focused attack vector analysis
    this.server.tool(
      "roast_security",
      "Deploy brutal AI critics to systematically annihilate your security design. These critics are battle-hardened penetration testers who find every authentication bypass, injection vulnerability, privilege escalation path, and social engineering opportunity that real attackers will exploit.",
      {
        system: z.string().describe("System, application, or security design to analyze"),
        assets: z.string().optional().describe("Critical assets or data to protect"),
        threatModel: z.string().optional().describe("Known threats or attack vectors to consider"),
        compliance: z.string().optional().describe("Compliance requirements (GDPR, HIPAA, etc.)")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "security",
            args.system,
            "security",
            `Assets: ${args.assets || 'unspecified'}, Threats: ${args.threatModel || 'unknown'}, Compliance: ${args.compliance || 'none specified'}`
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_PRODUCT: UX and market reality criticism
    this.server.tool(
      "roast_product",
      "Deploy brutal AI critics to systematically eviscerate your product concept. These critics are product veterans who understand why users really abandon things, finding every usability disaster, adoption barrier, and workflow failure that will drive users away in seconds.",
      {
        product: z.string().describe("Product description, features, or user experience to analyze"),
        users: z.string().optional().describe("Target users or user personas"),
        competition: z.string().optional().describe("Competitive landscape or alternatives"),
        metrics: z.string().optional().describe("Success metrics or KPIs")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "product",
            args.product,
            "product",
            `Users: ${args.users || 'unclear'}, Competition: ${args.competition || 'unknown'}, Metrics: ${args.metrics || 'undefined'}`
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_INFRASTRUCTURE: DevOps and operations demolition
    this.server.tool(
      "roast_infrastructure",
      "Deploy brutal AI critics to systematically obliterate your infrastructure design. These critics are grizzled site reliability engineers who find every single point of failure, scaling bottleneck, and operational nightmare that will cause outages when you least expect them.",
      {
        infrastructure: z.string().describe("Infrastructure setup, deployment strategy, or operations plan"),
        scale: z.string().optional().describe("Expected scale and load patterns"),
        budget: z.string().optional().describe("Infrastructure budget or cost constraints"),
        sla: z.string().optional().describe("SLA requirements or uptime targets")
      },
      async (args) => {
        try {
          const result = await this.executeBrutalistAnalysis(
            "infrastructure",
            args.infrastructure,
            "infrastructure",
            `Scale: ${args.scale || 'unknown'}, Budget: ${args.budget || 'unlimited?'}, SLA: ${args.sla || 'undefined'}`
          );

          return this.formatToolResponse(result);
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

    // ROAST_CLI_DEBATE: Adversarial analysis between different CLI agents
    this.server.tool(
      "roast_cli_debate",
      "Deploy two or more CLI agents in brutal adversarial combat. Watch Claude Code, Codex, and Gemini CLI tear apart your work from different angles, then debate each other's criticisms. The perfect storm of systematic destruction through AI agent disagreement.",
      {
        targetPath: z.string().describe("Path or concept to analyze"),
        debateRounds: z.number().optional().describe("Number of debate rounds (default: 2)"),
        context: z.string().optional().describe("Additional context for the debate"),
        workingDirectory: z.string().optional().describe("Working directory for analysis"),
        enableSandbox: z.boolean().optional().describe("Enable sandbox mode for security")
      },
      async (args) => {
        return this.handleToolExecution(async () => {
          const debateRounds = args.debateRounds || 2;
          const responses = await this.executeCLIDebate(
            args.targetPath,
            debateRounds,
            args.context,
            args.workingDirectory,
            args.enableSandbox
          );
          return responses;
        });
      }
    );

    // CLI_AGENT_ROSTER: Show available brutalist critics
    this.server.tool(
      "cli_agent_roster",
      "Know your weapons. Display the available CLI agent critics (Claude Code, Codex, Gemini CLI) ready to demolish your work, their capabilities, and how to deploy them for systematic destruction.",
      {},
      async (args) => {
        try {
          let roster = "# Brutalist CLI Agent Arsenal\n\n";
          
          roster += "## Available AI Critics (13 Tools Total)\n\n";
          roster += "**Abstract Analysis Tools (6):**\n";
          roster += "- `roast_idea` - Destroy any business/technical/creative concept\n";
          roster += "- `roast_architecture` - Demolish system designs\n";
          roster += "- `roast_research` - Tear apart academic methodologies\n";
          roster += "- `roast_security` - Annihilate security designs\n";
          roster += "- `roast_product` - Eviscerate UX and market concepts\n";
          roster += "- `roast_infrastructure` - Obliterate DevOps setups\n\n";
          
          roster += "**File-System Analysis Tools (5):**\n";
          roster += "- `roast_codebase` - Analyze actual source code\n";
          roster += "- `roast_file_structure` - Examine directory organization\n";
          roster += "- `roast_dependencies` - Review package management\n";
          roster += "- `roast_git_history` - Analyze version control workflow\n";
          roster += "- `roast_test_coverage` - Evaluate testing strategy\n\n";
          
          roster += "**Meta Tools (2):**\n";
          roster += "- `roast_cli_debate` - CLI vs CLI adversarial analysis\n";
          roster += "- `cli_agent_roster` - This tool (show capabilities)\n\n";
          
          roster += "## CLI Agent Capabilities\n";
          roster += "**Claude Code** - Advanced analysis with direct system prompt injection\n";
          roster += "**Codex** - Sandboxed execution with embedded brutal prompts\n";
          roster += "**Gemini CLI** - Workspace context with environment variable system prompts\n\n";
          
          // Add CLI context information
          const cliContext = await this.cliOrchestrator.detectCLIContext();
          roster += "## Current CLI Context\n";
          roster += `**Available CLIs:** ${cliContext.availableCLIs.join(', ') || 'None detected'}\n`;
          roster += `**Current CLI:** ${cliContext.currentCLI || 'Unknown'}\n`;
          roster += `**Smart Routing:** ${cliContext.currentCLI ? `Excludes ${cliContext.currentCLI} for analysis` : 'Uses all available CLIs'}\n\n`;
          
          roster += "## Brutalist Philosophy\n";
          roster += "*All tools use CLI agents with brutal system prompts for maximum reality-based criticism.*\n";
          
          return {
            content: [{ type: "text" as const, text: roster }]
          };
        } catch (error) {
          return this.formatErrorResponse(error);
        }
      }
    );

  }

  private async executeCLIDebate(
    targetPath: string,
    debateRounds: number,
    context?: string,
    workingDirectory?: string,
    enableSandbox?: boolean
  ): Promise<BrutalistResponse> {
    logger.debug("Executing CLI debate", { 
      targetPath,
      debateRounds,
      workingDirectory,
      enableSandbox
    });

    try {
      const availableCLIs = this.cliOrchestrator.getSmartCLISelection(true);
      
      if (availableCLIs.length < 2) {
        throw new Error(`CLI debate requires at least 2 CLIs, but only ${availableCLIs.length} available: ${availableCLIs.join(', ')}`);
      }

      const debateContext: CLIAgentResponse[] = [];
      let currentContext = context || `Initial analysis of: ${targetPath}`;

      // Round 1: Initial analysis from each CLI
      logger.debug(`Starting debate round 1: Initial analysis`);
      const initialResponses = await this.cliOrchestrator.executeBrutalistAnalysis(
        'idea', // Start with idea analysis for debates
        targetPath,
        'idea',
        currentContext,
        {
          workingDirectory: workingDirectory || this.config.workingDirectory,
          sandbox: enableSandbox ?? this.config.enableSandbox,
          timeout: this.config.defaultTimeout,
          excludeCurrentCLI: true
        }
      );
      
      debateContext.push(...initialResponses);

      // Subsequent rounds: Counter-arguments and rebuttals
      for (let round = 2; round <= debateRounds; round++) {
        logger.debug(`Starting debate round ${round}: Counter-arguments`);
        
        // Build context from previous responses
        const previousAnalyses = debateContext
          .filter(r => r.success)
          .map(r => `${r.agent.toUpperCase()}: ${r.output.substring(0, 500)}...`)
          .join('\n\n');
        
        currentContext = `Previous analyses:\n${previousAnalyses}\n\nNow provide counter-arguments and rebuttals to the above analyses for: ${targetPath}`;

        const counterResponses = await this.cliOrchestrator.executeBrutalistAnalysis(
          'research', // Use research for more methodical counter-arguments
          targetPath,
          'research',
          currentContext,
          {
            workingDirectory: workingDirectory || this.config.workingDirectory,
            sandbox: enableSandbox ?? this.config.enableSandbox,
            timeout: this.config.defaultTimeout,
            excludeCurrentCLI: true
          }
        );
        
        debateContext.push(...counterResponses);
      }

      const synthesis = this.synthesizeDebate(debateContext, targetPath, debateRounds);

      return {
        success: debateContext.some(r => r.success),
        responses: debateContext,
        synthesis,
        analysisType: 'cli_debate',
        targetPath
      };
    } catch (error) {
      logger.error("CLI debate execution failed", error);
      throw error;
    }
  }

  private synthesizeDebate(responses: CLIAgentResponse[], targetPath: string, rounds: number): string {
    const successfulResponses = responses.filter(r => r.success);
    
    if (successfulResponses.length === 0) {
      return `# CLI Debate Failed\n\nEven our brutal critics couldn't engage in proper adversarial combat.\n\nErrors:\n${responses.map(r => `- ${r.agent}: ${r.error}`).join('\n')}`;
    }

    let synthesis = `# Brutalist CLI Agent Debate Results\n\n`;
    synthesis += `**Target:** ${targetPath}\n`;
    synthesis += `**Rounds:** ${rounds}\n`;
    synthesis += `**Participants:** ${Array.from(new Set(successfulResponses.map(r => r.agent))).join(', ')}\n\n`;

    // Group responses by round
    const responsesByRound = [];
    const responsesPerRound = successfulResponses.length / rounds;
    
    for (let i = 0; i < rounds; i++) {
      const start = Math.floor(i * responsesPerRound);
      const end = Math.floor((i + 1) * responsesPerRound);
      responsesByRound.push(successfulResponses.slice(start, end));
    }

    responsesByRound.forEach((roundResponses, index) => {
      synthesis += `## Round ${index + 1}: ${index === 0 ? 'Initial Analysis' : 'Counter-Arguments'}\n\n`;
      
      roundResponses.forEach((response) => {
        synthesis += `### ${response.agent.toUpperCase()} (${response.executionTime}ms)\n`;
        synthesis += `${response.output}\n\n`;
        synthesis += `---\n\n`;
      });
    });

    synthesis += `## Debate Synthesis\n`;
    synthesis += `After ${rounds} rounds of brutal adversarial analysis involving ${Array.from(new Set(successfulResponses.map(r => r.agent))).length} CLI agents, `;
    synthesis += `your work has been systematically demolished from multiple perspectives. `;
    synthesis += `The convergent criticisms above represent the collective wisdom of AI agents that disagree on methods but agree on destruction.\n\n`;
    
    if (responses.some(r => !r.success)) {
      synthesis += `*Note: ${responses.filter(r => !r.success).length} debate contributions failed - probably casualties of the intellectual warfare.*`;
    }

    return synthesis;
  }

  private async executeBrutalistAnalysis(
    analysisType: string,
    targetPath: string, 
    systemPromptType: BrutalistPromptType,
    context?: string,
    workingDirectory?: string,
    enableSandbox?: boolean
  ): Promise<BrutalistResponse> {
    logger.debug("Executing brutalist analysis", { 
      targetPath,
      analysisType,
      systemPromptType,
      workingDirectory,
      enableSandbox
    });

    try {
      // Execute CLI agent analysis with system prompt injection
      const responses = await this.cliOrchestrator.executeBrutalistAnalysis(
        analysisType,
        targetPath,
        systemPromptType,
        context,
        {
          workingDirectory: workingDirectory || this.config.workingDirectory,
          sandbox: enableSandbox ?? this.config.enableSandbox,
          timeout: this.config.defaultTimeout,
          excludeCurrentCLI: true // Enable smart routing to avoid current CLI
        }
      );
      
      logger.debug("Brutalist analysis completed", { 
        responseCount: responses.length,
        agents: responses.map(r => r.agent),
        successCount: responses.filter(r => r.success).length
      });

      return {
        success: responses.some(r => r.success),
        responses,
        synthesis: this.cliOrchestrator.synthesizeBrutalistFeedback(responses, analysisType),
        analysisType,
        targetPath
      };
    } catch (error) {
      logger.error("Brutalist analysis execution failed", error);
      throw error;
    }
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