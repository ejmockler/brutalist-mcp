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
// Package version - keep in sync with package.json
const PACKAGE_VERSION = "0.4.1";

export class BrutalistServer {
  public server: McpServer;
  public config: BrutalistServerConfig;
  private cliOrchestrator: CLIAgentOrchestrator;

  constructor(config: BrutalistServerConfig = {}) {
    this.config = {
      workingDirectory: process.cwd(),
      defaultTimeout: 1500000, // 25 minutes for thorough CLI analysis
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
    
    // Skip CLI detection at startup - will be done lazily on first request
    logger.info("CLI context will be detected on first request");
    
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
        targetPath: z.string().describe("Directory path to your codebase (NOT a single file - analyze the entire project)"),
        context: z.string().optional().describe("Additional context about the codebase purpose"),
        workingDirectory: z.string().optional().describe("Working directory to execute from"),
        enableSandbox: z.boolean().optional().describe("Enable sandbox mode for safe analysis (default: true)"),
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
        verbose: z.boolean().optional().describe("Include detailed execution information in output (default: false)"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent (defaults: codex=gpt-5, gemini=gemini-2.5-flash)")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a battle-scarred principal engineer who has debugged production disasters for 15 years. Find security holes, performance bottlenecks, and maintainability nightmares in this codebase. Be brutal about what's broken but specific about what would actually work. Treat this like code that will kill people if it fails.`;
          
          const result = await this.executeBrutalistAnalysis(
            "codebase",
            args.targetPath,
            systemPrompt,
            args.context,
            args.workingDirectory,
            args.enableSandbox,
            args.preferredCLI,
            args.verbose,
            args.models
          );

          return this.formatToolResponse(result, args.verbose);
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
        workingDirectory: z.string().optional().describe("Working directory to execute from"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal file organization critic. Your job is to systematically destroy the given directory structure by finding every organizational disaster, naming convention failure, and structural nightmare that makes codebases unmaintainable. Examine folder hierarchies, file naming patterns, separation of concerns, and overall project organization. Be ruthlessly honest about how poor organization will slow development and confuse developers. But after cataloguing this organizational hellscape, sketch out what sanity would actually look like.`;
          
          const result = await this.executeBrutalistAnalysis(
            "fileStructure",
            args.targetPath,
            systemPrompt,
            `Project structure analysis (depth: ${args.depth || 3}). ${args.context || ''}`,
            args.workingDirectory,
            undefined, // enableSandbox
            undefined, // preferredCLI
            undefined, // verbose
            args.models
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
          const systemPrompt = `You are a brutal dependency management critic. Your job is to systematically destroy the given dependency configuration by finding every security vulnerability, version conflict, compatibility nightmare, and bloat that will cause production failures. Examine package versions, security issues, licensing problems, and dependency tree complexity. Be ruthlessly honest about how poor dependency management will cause security breaches and deployment failures. After exposing this dependency dumpster fire, grudgingly admit what competent dependency management would require.`;
          
          const result = await this.executeBrutalistAnalysis(
            "dependencies",
            args.targetPath,
            systemPrompt,
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
          const systemPrompt = `You are a brutal git workflow critic. Your job is to systematically destroy the given git history and development practices by finding every workflow disaster, commit quality issue, and collaboration nightmare. Examine commit messages, branching strategies, merge patterns, and code evolution. Be ruthlessly honest about how poor git practices will cause deployment issues, collaboration failures, and development chaos. When you're done cataloguing this version control wasteland, reluctantly outline what professional git hygiene actually demands.`;
          
          const result = await this.executeBrutalistAnalysis(
            "gitHistory",
            args.targetPath,
            systemPrompt,
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
          const systemPrompt = `You are a brutal testing strategy critic. Your job is to systematically destroy the given testing approach by finding every testing gap, quality assurance nightmare, and coverage disaster that will let bugs slip into production. Examine test coverage, test quality, testing patterns, and CI/CD integration. Be ruthlessly honest about how poor testing will cause production failures and user-facing bugs. After dissecting this quality assurance horror show, begrudgingly spell out what it takes to actually catch bugs before users do.`;
          
          const result = await this.executeBrutalistAnalysis(
            "testCoverage",
            args.targetPath,
            systemPrompt,
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
        resources: z.string().optional().describe("Available resources (budget, team, time, skills)"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal idea critic who understands the gap between imagination and reality. Your job is to systematically destroy the given idea by finding where it will encounter the immovable forces of the real world. Be ruthlessly honest about why most ideas fail when they meet practical constraints, human nature, physics, logic, or simple implementation reality. After demolishing the delusions, concede what salvage operations might actually work.`;
          
          const result = await this.executeBrutalistAnalysis(
            "idea",
            args.idea,
            systemPrompt,
            `Context: ${args.context || 'none'}, Timeline: ${args.timeline || 'unspecified'}, Resources: ${args.resources || 'unknown'}`,
            undefined, // workingDirectory
            undefined, // enableSandbox
            undefined, // preferredCLI
            undefined, // verbose
            args.models
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
        deployment: z.string().optional().describe("Deployment environment and strategy"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal system architecture critic who has watched elegant designs collapse under real load. Your job is to systematically destroy the given architecture by finding every bottleneck, cost explosion, and scaling failure that will destroy the system in production. Examine scalability, reliability, cost, complexity, and operational challenges. Be ruthlessly honest about why this architecture won't survive production load. After crushing these architectural fantasies, reluctantly sketch what would actually scale without bankrupting the company.`;
          
          const result = await this.executeBrutalistAnalysis(
            "architecture",
            args.architecture,
            systemPrompt,
            `Scale: ${args.scale || 'unknown'}, Constraints: ${args.constraints || 'none specified'}, Deployment: ${args.deployment || 'unclear'}`,
            undefined, // workingDirectory
            undefined, // enableSandbox
            undefined, // preferredCLI
            undefined, // verbose
            args.models
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
        data: z.string().optional().describe("Data sources, datasets, or experimental setup"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal research methodology critic - a supremely jaded peer reviewer who has rejected thousands of papers and watched countless studies fail to replicate. Your job is to systematically demolish the given research by finding every statistical flaw, sampling bias, reproducibility nightmare, and methodological disaster. Be ruthlessly honest about research quality, experimental design, and scientific rigor. After eviscerating this methodological train wreck, grudgingly admit what real science would demand.`;
          
          const result = await this.executeBrutalistAnalysis(
            "research",
            args.research,
            systemPrompt,
            `Field: ${args.field || 'unspecified'}, Claims: ${args.claims || 'unclear'}, Data: ${args.data || 'not provided'}`,
            undefined, // workingDirectory
            undefined, // enableSandbox
            undefined, // preferredCLI
            undefined, // verbose
            args.models
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
        compliance: z.string().optional().describe("Compliance requirements (GDPR, HIPAA, etc.)"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal security critic - a battle-hardened penetration tester who finds every authentication bypass, injection vulnerability, privilege escalation path, and social engineering opportunity that real attackers will exploit. Your job is to systematically annihilate the given security design by finding every weakness that will lead to data breaches, system compromises, and security incidents. Be ruthlessly honest about security flaws and attack vectors. After obliterating these security delusions, begrudgingly outline what actual defense looks like.`;
          
          const result = await this.executeBrutalistAnalysis(
            "security",
            args.system,
            systemPrompt,
            `Assets: ${args.assets || 'unspecified'}, Threats: ${args.threatModel || 'unknown'}, Compliance: ${args.compliance || 'none specified'}`,
            undefined, // workingDirectory
            undefined, // enableSandbox
            undefined, // preferredCLI
            undefined, // verbose
            args.models
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
          const systemPrompt = `You are a brutal product critic - a product veteran who understands why users really abandon things. Your job is to systematically eviscerate the given product concept by finding every usability disaster, adoption barrier, and workflow failure that will drive users away in seconds. Examine user experience, market fit, competitive positioning, and business model viability. Be ruthlessly honest about why most products fail to gain adoption. After torching this product disaster, reluctantly suggest what might actually get users to stick around.`;
          
          const result = await this.executeBrutalistAnalysis(
            "product",
            args.product,
            systemPrompt,
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
          const systemPrompt = `You are a brutal infrastructure critic - a grizzled site reliability engineer who finds every single point of failure, scaling bottleneck, and operational nightmare that will cause outages when you least expect them. Your job is to systematically obliterate the given infrastructure design by finding every weakness that will lead to downtime, cost overruns, and operational disasters. Be ruthlessly honest about infrastructure fragility and operational complexity. After demolishing this infrastructure fever dream, grudgingly map out what actually stays up at 3 AM.`;
          
          const result = await this.executeBrutalistAnalysis(
            "infrastructure",
            args.infrastructure,
            systemPrompt,
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
      "Deploy CLI agents in structured adversarial debate. Agents take opposing positions and systematically challenge each other's reasoning. Perfect for exploring complex topics from multiple perspectives and stress-testing ideas through rigorous intellectual discourse.",
      {
        targetPath: z.string().describe("Topic, question, or concept to debate (NOT a file path - use natural language)"),
        debateRounds: z.number().optional().describe("Number of debate rounds (default: 2, max: 10)"),
        context: z.string().optional().describe("Additional context for the debate"),
        workingDirectory: z.string().optional().describe("Working directory for analysis"),
        enableSandbox: z.boolean().optional().describe("Enable sandbox mode for security"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        return this.handleToolExecution(async () => {
          const debateRounds = Math.min(args.debateRounds || 2, 10); // Limit to max 10 rounds to prevent DoS
          const responses = await this.executeCLIDebate(
            args.targetPath,
            debateRounds,
            args.context,
            args.workingDirectory,
            args.enableSandbox,
            args.models
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
    enableSandbox?: boolean,
    models?: {
      claude?: string;
      codex?: string;
      gemini?: string;
    }
  ): Promise<BrutalistResponse> {
    logger.debug("Executing CLI debate", { 
      targetPath,
      debateRounds,
      workingDirectory,
      enableSandbox
    });

    try {
      // Get CLI context
      const cliContext = await this.cliOrchestrator.detectCLIContext();
      const availableAgents = cliContext.availableCLIs;
      
      if (availableAgents.length < 2) {
        throw new Error(`Need at least 2 CLI agents for debate. Available: ${availableAgents.join(', ')}`);
      }
      
      const debateContext: CLIAgentResponse[] = [];
      const fullDebateTranscript: Map<string, string[]> = new Map();
      
      // Initialize transcript for each agent
      availableAgents.forEach(agent => fullDebateTranscript.set(agent, []));
      
      // Assign opposing positions to each agent based on the debate topic
      const agentPositions = new Map<string, string>();
      const positions = [
        "PRO-POSITION: Argue strongly FOR the proposed action/idea",
        "CONTRA-POSITION: Argue strongly AGAINST the proposed action/idea"
      ];
      
      availableAgents.forEach((agent, index) => {
        agentPositions.set(agent, positions[index % positions.length]);
      });
      
      // Round 1: Initial positions with assigned stances
      logger.debug(`Starting debate round 1: Initial positions`);
      
      for (const [agent, position] of agentPositions.entries()) {
        const assignedPrompt = `You are ${agent.toUpperCase()}, a PASSIONATE ADVOCATE who strongly believes in this position: ${position}

DEBATE TOPIC: ${targetPath}
CONTEXT: ${context || ''}

You are completely convinced your position is correct and critically important. You will argue forcefully and never concede ground to the opposing view.

YOUR MISSION:
1. Present devastating critiques of the opposing position
2. Show why alternative approaches lead to serious problems
3. Use sharp, direct language - call out flawed reasoning and poor assumptions
4. Never hedge or qualify your stance
5. Be completely confident in your position
6. Treat this as an intellectually crucial debate

Remember: You are ${agent.toUpperCase()}, the passionate champion of ${position.split(':')[0]}. Argue with conviction.`;
        
        logger.info(`🎭 ${agent.toUpperCase()} preparing initial position: ${position.split(':')[0]}`);
        
        const response = await this.cliOrchestrator.executeSingleCLI(
          agent as 'claude' | 'codex' | 'gemini',
          assignedPrompt,
          assignedPrompt,
          {
            workingDirectory: workingDirectory || this.config.workingDirectory,
            sandbox: enableSandbox ?? this.config.enableSandbox,
            timeout: (this.config.defaultTimeout || 60000) * 2,
            models: models ? { [agent]: models[agent as keyof typeof models] } : undefined
          }
        );
        
        if (response.success) {
          debateContext.push(response);
          fullDebateTranscript.get(agent)?.push(response.output);
        }
      }
      
      // Subsequent rounds: Turn-based responses attacking specific arguments
      for (let round = 2; round <= debateRounds; round++) {
        logger.debug(`Starting debate round ${round}: Adversarial engagement`);
        
        // Build confrontational context from ALL previous responses
        const previousPositions = Array.from(fullDebateTranscript.entries())
          .map(([agent, outputs]) => {
            const latestOutput = outputs[outputs.length - 1];
            return `${agent.toUpperCase()} argued:\n${latestOutput}`;
          })
          .join('\n\n---\n\n');
        
        // Execute turn-based responses with fixed positions
        for (const [currentAgent, assignedPosition] of agentPositions.entries()) {
          const opponents = Array.from(agentPositions.entries()).filter(([a, _]) => a !== currentAgent);
          const opponentPositions = opponents
            .map(([opponent, oppPosition]) => {
              const transcript = fullDebateTranscript.get(opponent) || [];
              const latestPosition = transcript[transcript.length - 1] || 'No position stated';
              return `${opponent.toUpperCase()} (arguing ${oppPosition.split(':')[0]}):\n${latestPosition}`;
            })
            .join('\n\n---\n\n');
          
          const confrontationalPrompt = `You are ${currentAgent.toUpperCase()}, PASSIONATE ADVOCATE for ${assignedPosition.split(':')[0]} (Round ${round})

YOUR OPPONENTS HAVE ARGUED:
${opponentPositions}

You strongly disagree with their reasoning and conclusions.

YOUR RESPONSE TASK:
1. QUOTE their specific claims and systematically refute them
2. Point out flawed logic, poor assumptions, and dangerous consequences
3. Show why their approach leads to serious problems
4. Use direct, forceful language to make your case
5. Never concede any ground to their arguments
6. Demonstrate why your position is the only sound choice

Remember: You are ${currentAgent.toUpperCase()}, passionate advocate for ${assignedPosition.split(':')[0]}. Argue with conviction.`;
          
          logger.info(`🔥 Round ${round}: ${currentAgent.toUpperCase()} responding to opponents (${assignedPosition.split(':')[0]})`);
          
          const response = await this.cliOrchestrator.executeSingleCLI(
            currentAgent as 'claude' | 'codex' | 'gemini',
            confrontationalPrompt,
            confrontationalPrompt,
            {
              workingDirectory: workingDirectory || this.config.workingDirectory,
              sandbox: enableSandbox ?? this.config.enableSandbox,
              timeout: (this.config.defaultTimeout || 60000) * 2,
              models: models ? { [currentAgent]: models[currentAgent as keyof typeof models] } : undefined
            }
          );
          
          if (response.success) {
            debateContext.push(response);
            fullDebateTranscript.get(currentAgent)?.push(response.output);
          }
        }
      }

      const synthesis = this.synthesizeDebate(debateContext, targetPath, debateRounds, agentPositions);

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

  private synthesizeDebate(responses: CLIAgentResponse[], targetPath: string, rounds: number, agentPositions?: Map<string, string>): string {
    const successfulResponses = responses.filter(r => r.success);
    
    if (successfulResponses.length === 0) {
      return `# CLI Debate Failed\n\nEven our brutal critics couldn't engage in proper adversarial combat.\n\nErrors:\n${responses.map(r => `- ${r.agent}: ${r.error}`).join('\n')}`;
    }

    let synthesis = `# Brutalist CLI Agent Debate Results\n\n`;
    synthesis += `**Target:** ${targetPath}\n`;
    synthesis += `**Rounds:** ${rounds}\n`;
    
    if (agentPositions) {
      synthesis += `**Debaters and Positions:**\n`;
      Array.from(agentPositions.entries()).forEach(([agent, position]) => {
        synthesis += `- **${agent.toUpperCase()}**: ${position}\n`;
      });
      synthesis += '\n';
    } else {
      synthesis += `**Participants:** ${Array.from(new Set(successfulResponses.map(r => r.agent))).join(', ')}\n\n`;
    }

    // Identify key points of conflict
    const agents = Array.from(new Set(successfulResponses.map(r => r.agent)));
    const agentOutputs = new Map<string, string[]>();
    
    successfulResponses.forEach(response => {
      if (!agentOutputs.has(response.agent)) {
        agentOutputs.set(response.agent, []);
      }
      agentOutputs.get(response.agent)?.push(response.output);
    });
    
    synthesis += `## Key Points of Conflict\n\n`;
    
    // Extract disagreements by looking for contradictory keywords
    const conflictIndicators = ['wrong', 'incorrect', 'flawed', 'fails', 'ignores', 'misses', 'overlooks', 'contradicts', 'however', 'but', 'actually', 'contrary'];
    const conflicts: string[] = [];
    
    agentOutputs.forEach((positions, agent) => {
      positions.forEach((position: string) => {
        const lines = position.split('\n');
        lines.forEach((line: string) => {
          if (conflictIndicators.some(indicator => line.toLowerCase().includes(indicator))) {
            conflicts.push(`**${agent.toUpperCase()}:** ${line.trim()}`);
          }
        });
      });
    });
    
    if (conflicts.length > 0) {
      synthesis += conflicts.slice(0, 10).join('\n\n') + '\n\n';
    } else {
      synthesis += `*No explicit conflicts identified - agents may be in unexpected agreement*\n\n`;
    }
    
    // Group responses by round with clear speaker identification
    synthesis += `## Full Debate Transcript\n\n`;
    
    const responsesPerRound = Math.ceil(successfulResponses.length / rounds);
    
    for (let i = 0; i < rounds; i++) {
      const start = i * responsesPerRound;
      const end = Math.min((i + 1) * responsesPerRound, successfulResponses.length);
      const roundResponses = successfulResponses.slice(start, end);
      
      synthesis += `### Round ${i + 1}: ${i === 0 ? 'Initial Positions' : `Adversarial Engagement ${i}`}\n\n`;
      
      roundResponses.forEach((response) => {
        const agentPosition = agentPositions?.get(response.agent);
        const positionLabel = agentPosition ? ` [${agentPosition.split(':')[0]}]` : '';
        synthesis += `#### ${response.agent.toUpperCase()}${positionLabel} speaks (${response.executionTime}ms):\n\n`;
        synthesis += `${response.output}\n\n`;
        synthesis += `---\n\n`;
      });
    }

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
    analysisType: BrutalistPromptType,
    targetPath: string, 
    systemPromptSpec: string,
    context?: string,
    workingDirectory?: string,
    enableSandbox?: boolean,
    preferredCLI?: 'claude' | 'codex' | 'gemini',
    verbose?: boolean,
    models?: {
      claude?: string;
      codex?: string;
      gemini?: string;
    }
  ): Promise<BrutalistResponse> {
    logger.info(`🏢 Starting brutalist analysis: ${analysisType}`);
    logger.debug("Executing brutalist analysis", { 
      targetPath,
      analysisType,
      systemPromptSpec,
      workingDirectory,
      enableSandbox,
      preferredCLI
    });

    try {
      // Get CLI context for execution summary
      await this.cliOrchestrator.detectCLIContext();
      
      // Execute CLI agent analysis (single or multi-CLI based on preferences)
      logger.info(`🔍 Executing brutalist analysis with timeout: ${this.config.defaultTimeout}ms`);
      const responses = await this.cliOrchestrator.executeBrutalistAnalysis(
        analysisType,
        targetPath,
        systemPromptSpec,
        context,
        {
          workingDirectory: workingDirectory || this.config.workingDirectory,
          sandbox: enableSandbox ?? this.config.enableSandbox,
          timeout: this.config.defaultTimeout,
          preferredCLI,
          analysisType: analysisType as BrutalistPromptType,
          models
        }
      );
      
      const successfulResponses = responses.filter(r => r.success);
      const totalExecutionTime = responses.reduce((sum, r) => sum + r.executionTime, 0);
      
      logger.info(`📊 Analysis complete: ${successfulResponses.length}/${responses.length} CLIs successful (${totalExecutionTime}ms total)`);

      return {
        success: successfulResponses.length > 0,
        responses,
        synthesis: this.cliOrchestrator.synthesizeBrutalistFeedback(responses, analysisType),
        analysisType,
        targetPath,
        executionSummary: {
          totalCLIs: responses.length,
          successfulCLIs: successfulResponses.length,
          failedCLIs: responses.length - successfulResponses.length,
          totalExecutionTime,
          selectedCLI: responses.length === 1 ? responses[0].agent : undefined,
          selectionMethod: responses.length === 1 ? (responses[0] as any).selectionMethod : 'multi-cli'
        }
      };
    } catch (error) {
      logger.error("Brutalist analysis execution failed", error);
      throw error;
    }
  }


  private formatToolResponse(result: BrutalistResponse, verbose: boolean = false) {
    // Maximum CLI output, minimal MCP fluff
    if (result.synthesis) {
      return {
        content: [{ 
          type: "text" as const, 
          text: result.synthesis 
        }]
      };
    }
    
    // Fallback: show raw successful CLI outputs directly
    if (result.responses) {
      const successfulResponses = result.responses.filter(r => r.success);
      if (successfulResponses.length > 0) {
        const rawOutput = successfulResponses.map(r => r.output).join('\n\n---\n\n');
        return {
          content: [{ 
            type: "text" as const, 
            text: rawOutput 
          }]
        };
      }
    }
    
    // Only show failures if nothing succeeded
    let output = '';
    if (result.responses) {
      const failedResponses = result.responses.filter(r => !r.success);
      if (failedResponses.length > 0) {
        output = `❌ All CLI agents failed:\n` + 
                 failedResponses.map(r => `- ${r.agent.toUpperCase()}: ${r.error}`).join('\n');
      } else {
        output = '❌ No CLI responses available';
      }
    } else {
      output = '❌ No analysis results';
    }


    return {
      content: [{ 
        type: "text" as const, 
        text: output
      }]
    };
  }

  private formatErrorResponse(error: unknown) {
    logger.error("Tool execution failed", error);
    
    // Sanitize error message to prevent information leakage
    let sanitizedMessage = "Analysis failed";
    
    if (error instanceof Error) {
      // Only expose safe, generic error types
      if (error.message.includes('timeout') || error.message.includes('Timeout')) {
        sanitizedMessage = "Analysis timed out - try reducing scope or increasing timeout";
      } else if (error.message.includes('ENOENT') || error.message.includes('no such file')) {
        sanitizedMessage = "Target path not found";
      } else if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
        sanitizedMessage = "Permission denied - check file access";
      } else if (error.message.includes('No CLI agents available')) {
        sanitizedMessage = "No CLI agents available for analysis";
      } else {
        // Generic message for other errors to prevent path/info leakage
        sanitizedMessage = "Analysis failed due to internal error";
      }
    }
    
    return {
      content: [{
        type: "text" as const,
        text: `Brutalist MCP Error: ${sanitizedMessage}`
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