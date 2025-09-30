import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { CLIAgentOrchestrator, BrutalistPromptType, StreamingEvent } from './cli-agents.js';
import { logger } from './logger.js';
import { 
  BrutalistServerConfig, 
  BrutalistResponse, 
  RoastOptions, 
  CLIAgentResponse,
  PaginationParams
} from './types/brutalist.js';
import { 
  extractPaginationParams, 
  parseCursor,
  PAGINATION_DEFAULTS,
  ResponseChunker,
  createPaginationMetadata,
  formatPaginationStatus,
  estimateTokenCount
} from './utils/pagination.js';
// Use environment variable or fallback to manual version
const PACKAGE_VERSION = process.env.npm_package_version || "0.4.4";

export class BrutalistServer {
  public server: McpServer;
  public config: BrutalistServerConfig;
  private cliOrchestrator: CLIAgentOrchestrator;
  private httpTransport?: StreamableHTTPServerTransport;

  constructor(config: BrutalistServerConfig = {}) {
    this.config = {
      workingDirectory: process.cwd(),
      defaultTimeout: 1500000, // 25 minutes for thorough CLI analysis
      enableSandbox: true,
      transport: 'stdio', // Default to stdio for backward compatibility
      httpPort: 3000,
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

  private handleStreamingEvent = (event: StreamingEvent) => {
    // Send streaming event via MCP server (works for both stdio and HTTP transports)
    try {
      logger.debug(`🔄 Streaming event: ${event.type} from ${event.agent} - ${event.content?.substring(0, 100)}...`);
      
      // Convert streaming event to MCP notification format
      this.server.sendLoggingMessage({
        level: 'info',
        data: event,
        logger: 'brutalist-mcp-streaming'
      });
      
      logger.debug(`✅ Sent logging message for ${event.type} event`);
    } catch (error) {
      logger.error("Failed to send streaming event", error);
    }
  };

  private handleProgressUpdate = (progressToken: string | number, progress: number, total: number, message: string) => {
    try {
      logger.debug(`📊 Progress update: ${progress}/${total} - ${message}`);
      
      // Send progress notification via MCP server
      this.server.server.notification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          total,
          message
        }
      });
      
      logger.debug(`✅ Sent progress notification: ${progress}/${total}`);
    } catch (error) {
      logger.error("Failed to send progress notification", error);
    }
  };

  async start() {
    logger.info("Starting Brutalist MCP Server with CLI Agents");
    
    // Skip CLI detection at startup - will be done lazily on first request
    logger.info("CLI context will be detected on first request");
    
    if (this.config.transport === 'http') {
      await this.startHttpServer();
    } else {
      await this.startStdioServer();
    }
    
    logger.info("Brutalist MCP Server started successfully");
  }

  private async startStdioServer() {
    logger.info("Starting with stdio transport");
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  private async startHttpServer() {
    logger.info(`Starting with HTTP streaming transport on port ${this.config.httpPort}`);
    
    // Create HTTP transport with streaming support
    this.httpTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false, // Force SSE streaming
      onsessioninitialized: (sessionId) => {
        logger.info(`New session initialized: ${sessionId}`);
      },
      onsessionclosed: (sessionId) => {
        logger.info(`Session closed: ${sessionId}`);
      }
    });

    // Connect the MCP server to the HTTP transport
    await this.server.connect(this.httpTransport);

    // Create Express app for HTTP handling
    const app = express();
    app.use(express.json({ limit: '10mb' })); // Add JSON size limit for security
    
    // Enable CORS for development
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }
      next();
    });

    // Route all MCP requests through the transport
    app.all('/mcp', async (req: Request, res: Response) => {
      try {
        await this.httpTransport!.handleRequest(req, res, req.body);
      } catch (error) {
        logger.error("HTTP request handling failed", error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal server error' });
        }
      }
    });

    // Health check endpoint
    app.get('/health', (req: Request, res: Response) => {
      res.json({ status: 'ok', transport: 'http-streaming', version: PACKAGE_VERSION });
    });

    // Start the HTTP server - bind to localhost only for security
    const port = this.config.httpPort || 3000;
    const server = app.listen(port, '127.0.0.1', () => {
      logger.info(`HTTP server listening on port ${port}`);
      logger.info(`MCP endpoint: http://localhost:${port}/mcp`);
      logger.info(`Health check: http://localhost:${port}/health`);
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      server.close(() => {
        logger.info('HTTP server closed');
        process.exit(0);
      });
    });
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
        }).optional().describe("Specific models to use for each CLI agent (defaults: codex=gpt-5, gemini=gemini-2.5-flash)"),
        // Pagination parameters for large responses
        offset: z.number().min(0).optional().describe("Character offset for response pagination (default: 0)"),
        limit: z.number().min(1000).max(100000).optional().describe("Maximum characters per response chunk (default: 25000, max: 100000)"),
        cursor: z.string().optional().describe("Pagination cursor from previous response (alternative to offset/limit)")
      },
      async (args, extra) => {
        try {
          const systemPrompt = `You are a battle-scarred principal engineer who has debugged production disasters for 15 years. Find security holes, performance bottlenecks, and maintainability nightmares in this codebase. Be brutal about what's broken but specific about what would actually work. Treat this like code that will kill people if it fails.`;
          
          // Extract progressToken from request metadata for real-time streaming
          const progressToken = extra._meta?.progressToken;
          
          // Extract pagination parameters
          const paginationParams = extractPaginationParams(args);
          if (args.cursor) {
            const cursorParams = parseCursor(args.cursor);
            Object.assign(paginationParams, cursorParams);
          }
          
          const result = await this.executeBrutalistAnalysis(
            "codebase",
            args.targetPath,
            systemPrompt,
            args.context,
            args.workingDirectory,
            args.enableSandbox,
            args.preferredCLI,
            args.verbose,
            args.models,
            progressToken
          );

          return this.formatToolResponse(result, args.verbose, paginationParams);
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
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
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
            args.preferredCLI,
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
        workingDirectory: z.string().optional().describe("Working directory to execute from"),
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal dependency management critic. Your job is to systematically destroy the given dependency configuration by finding every security vulnerability, version conflict, compatibility nightmare, and bloat that will cause production failures. Examine package versions, security issues, licensing problems, and dependency tree complexity. Be ruthlessly honest about how poor dependency management will cause security breaches and deployment failures. After exposing this dependency dumpster fire, grudgingly admit what competent dependency management would require.`;
          
          const result = await this.executeBrutalistAnalysis(
            "dependencies",
            args.targetPath,
            systemPrompt,
            `Dependency analysis (dev deps: ${args.includeDevDeps ?? true}). ${args.context || ''}`,
            args.workingDirectory,
            undefined, // enableSandbox
            args.preferredCLI,
            undefined, // verbose
            args.models
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
        workingDirectory: z.string().optional().describe("Working directory to execute from"),
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal git workflow critic. Your job is to systematically destroy the given git history and development practices by finding every workflow disaster, commit quality issue, and collaboration nightmare. Examine commit messages, branching strategies, merge patterns, and code evolution. Be ruthlessly honest about how poor git practices will cause deployment issues, collaboration failures, and development chaos. When you're done cataloguing this version control wasteland, reluctantly outline what professional git hygiene actually demands.`;
          
          const result = await this.executeBrutalistAnalysis(
            "gitHistory",
            args.targetPath,
            systemPrompt,
            `Git history analysis (range: ${args.commitRange || 'last 20 commits'}). ${args.context || ''}`,
            args.workingDirectory,
            undefined, // enableSandbox
            args.preferredCLI,
            undefined, // verbose
            args.models
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
        workingDirectory: z.string().optional().describe("Working directory to execute from"),
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal testing strategy critic. Your job is to systematically destroy the given testing approach by finding every testing gap, quality assurance nightmare, and coverage disaster that will let bugs slip into production. Examine test coverage, test quality, testing patterns, and CI/CD integration. Be ruthlessly honest about how poor testing will cause production failures and user-facing bugs. After dissecting this quality assurance horror show, begrudgingly spell out what it takes to actually catch bugs before users do.`;
          
          const result = await this.executeBrutalistAnalysis(
            "testCoverage",
            args.targetPath,
            systemPrompt,
            `Test coverage analysis (run coverage: ${args.runCoverage ?? true}). ${args.context || ''}`,
            args.workingDirectory,
            undefined, // enableSandbox
            args.preferredCLI,
            undefined, // verbose
            args.models
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
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
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
            args.preferredCLI,
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
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
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
            args.preferredCLI,
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
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
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
            args.preferredCLI,
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
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
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
            args.preferredCLI,
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
        metrics: z.string().optional().describe("Success metrics or KPIs"),
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal product critic - a product veteran who understands why users really abandon things. Your job is to systematically eviscerate the given product concept by finding every usability disaster, adoption barrier, and workflow failure that will drive users away in seconds. Examine user experience, market fit, competitive positioning, and business model viability. Be ruthlessly honest about why most products fail to gain adoption. After torching this product disaster, reluctantly suggest what might actually get users to stick around.`;
          
          const result = await this.executeBrutalistAnalysis(
            "product",
            args.product,
            systemPrompt,
            `Users: ${args.users || 'unclear'}, Competition: ${args.competition || 'unknown'}, Metrics: ${args.metrics || 'undefined'}`,
            undefined, // workingDirectory
            undefined, // enableSandbox
            args.preferredCLI,
            undefined, // verbose
            args.models
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
        sla: z.string().optional().describe("SLA requirements or uptime targets"),
        preferredCLI: z.enum(["claude", "codex", "gemini"]).optional().describe("Preferred CLI agent to use (default: use all available CLIs)"),
        models: z.object({
          claude: z.string().optional().describe("Claude model: opus, sonnet, or full name like claude-opus-4-1-20250805"),
          codex: z.string().optional().describe("Codex model: gpt-5, gpt-5-codex, o3, o3-mini, o3-pro, o4-mini"),
          gemini: z.enum(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']).optional().describe("Gemini model")
        }).optional().describe("Specific models to use for each CLI agent")
      },
      async (args) => {
        try {
          const systemPrompt = `You are a brutal infrastructure critic - a grizzled site reliability engineer who finds every single point of failure, scaling bottleneck, and operational nightmare that will cause outages when you least expect them. Your job is to systematically obliterate the given infrastructure design by finding every weakness that will lead to downtime, cost overruns, and operational disasters. Be ruthlessly honest about infrastructure fragility and operational complexity. After demolishing this infrastructure fever dream, grudgingly map out what actually stays up at 3 AM.`;
          
          const result = await this.executeBrutalistAnalysis(
            "infrastructure",
            args.infrastructure,
            systemPrompt,
            `Scale: ${args.scale || 'unknown'}, Budget: ${args.budget || 'unlimited?'}, SLA: ${args.sla || 'undefined'}`,
            undefined, // workingDirectory
            undefined, // enableSandbox
            args.preferredCLI,
            undefined, // verbose
            args.models
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
    },
    progressToken?: string | number
  ): Promise<BrutalistResponse> {
    logger.info(`🏢 Starting brutalist analysis: ${analysisType}`);
    logger.info(`🔧 DEBUG: preferredCLI=${preferredCLI}, targetPath=${targetPath}`);
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
      logger.info(`🔧 DEBUG: About to detect CLI context`);
      await this.cliOrchestrator.detectCLIContext();
      logger.info(`🔧 DEBUG: CLI context detected successfully`);
      
      // Execute CLI agent analysis (single or multi-CLI based on preferences)
      logger.info(`🔍 Executing brutalist analysis with timeout: ${this.config.defaultTimeout}ms`);
      logger.info(`🔧 DEBUG: About to call cliOrchestrator.executeBrutalistAnalysis`);
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
          models,
          onStreamingEvent: this.handleStreamingEvent,
          progressToken,
          onProgress: progressToken ? this.handleProgressUpdate.bind(this, progressToken) : undefined
        }
      );
      logger.info(`🔧 DEBUG: cliOrchestrator.executeBrutalistAnalysis returned ${responses.length} responses`);
      
      const successfulResponses = responses.filter(r => r.success);
      const totalExecutionTime = responses.reduce((sum, r) => sum + r.executionTime, 0);
      
      logger.info(`📊 Analysis complete: ${successfulResponses.length}/${responses.length} CLIs successful (${totalExecutionTime}ms total)`);
      logger.info(`🔧 DEBUG: About to synthesize feedback`);
      const synthesis = this.cliOrchestrator.synthesizeBrutalistFeedback(responses, analysisType);
      logger.info(`🔧 DEBUG: Synthesis length: ${synthesis.length} characters`);

      const result = {
        success: successfulResponses.length > 0,
        responses,
        synthesis,
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
      logger.info(`🔧 DEBUG: Returning result with success=${result.success}`);
      return result;
    } catch (error) {
      logger.error("Brutalist analysis execution failed", error);
      throw error;
    }
  }


  private formatToolResponse(result: BrutalistResponse, verbose: boolean = false, paginationParams?: PaginationParams) {
    logger.info(`🔧 DEBUG: formatToolResponse called with synthesis length: ${result.synthesis?.length || 0}`);
    logger.info(`🔧 DEBUG: result.success=${result.success}, responses.length=${result.responses?.length || 0}`);
    logger.info(`🔧 DEBUG: pagination params:`, paginationParams);
    
    // Get the primary content to paginate
    let primaryContent = '';
    
    if (result.synthesis) {
      primaryContent = result.synthesis;
      logger.info(`🔧 DEBUG: Using synthesis content (${primaryContent.length} characters)`);
    } else if (result.responses) {
      const successfulResponses = result.responses.filter(r => r.success);
      if (successfulResponses.length > 0) {
        primaryContent = successfulResponses.map(r => r.output).join('\n\n---\n\n');
        logger.info(`🔧 DEBUG: Using raw CLI output (${primaryContent.length} characters)`);
      }
    }
    
    // Handle pagination if params provided and content is substantial
    if (paginationParams && primaryContent) {
      return this.formatPaginatedResponse(primaryContent, paginationParams, result, verbose);
    }
    
    // Non-paginated response (legacy behavior)
    if (primaryContent) {
      return {
        content: [{ 
          type: "text" as const, 
          text: primaryContent 
        }]
      };
    }
    
    // Error handling - no successful content
    let errorOutput = '';
    if (result.responses) {
      const failedResponses = result.responses.filter(r => !r.success);
      if (failedResponses.length > 0) {
        errorOutput = `❌ All CLI agents failed:\n` + 
                     failedResponses.map(r => `- ${r.agent.toUpperCase()}: ${r.error}`).join('\n');
      } else {
        errorOutput = '❌ No CLI responses available';
      }
    } else {
      errorOutput = '❌ No analysis results';
    }

    return {
      content: [{ 
        type: "text" as const, 
        text: errorOutput
      }]
    };
  }

  private formatPaginatedResponse(
    content: string, 
    paginationParams: PaginationParams, 
    result: BrutalistResponse, 
    verbose: boolean
  ) {
    // Using imported pagination utilities
    
    const offset = paginationParams.offset || 0;
    const limit = paginationParams.limit || PAGINATION_DEFAULTS.DEFAULT_LIMIT;
    
    logger.info(`🔧 DEBUG: Paginating content - offset: ${offset}, limit: ${limit}, total: ${content.length}`);
    
    // Simple character-based pagination for immediate Claude Code compatibility
    const endOffset = Math.min(offset + limit, content.length);
    const chunk = content.substring(offset, endOffset);
    
    // Create pagination metadata
    const pagination = createPaginationMetadata(content.length, paginationParams, limit);
    const statusLine = formatPaginationStatus(pagination);
    
    // Estimate token usage for user awareness
    const chunkTokens = estimateTokenCount(chunk);
    const totalTokens = estimateTokenCount(content);
    
    // Format response with pagination info
    let paginatedText = '';
    
    // Add pagination header
    paginatedText += `# Brutalist Analysis Results\n\n`;
    paginatedText += `**📊 Pagination Status:** ${statusLine}\n`;
    paginatedText += `**🔢 Token Estimate:** ~${chunkTokens.toLocaleString()} tokens (chunk) / ~${totalTokens.toLocaleString()} tokens (total)\n\n`;
    
    if (pagination.hasMore) {
      paginatedText += `**⏭️ Continue Reading:** Use \`offset: ${endOffset}\` for next chunk\n\n`;
    }
    
    paginatedText += `---\n\n`;
    
    // Add the actual content chunk
    paginatedText += chunk;
    
    // Add footer for continuation
    if (pagination.hasMore) {
      paginatedText += `\n\n---\n\n`;
      paginatedText += `📖 **End of chunk ${pagination.chunkIndex}/${pagination.totalChunks}**\n`;
      paginatedText += `🔄 To continue: Use same tool with \`offset: ${endOffset}\``;
    } else {
      paginatedText += `\n\n---\n\n`;
      paginatedText += `✅ **Complete analysis shown** (${content.length.toLocaleString()} characters total)`;
    }
    
    // Add verbose execution details if requested
    if (verbose && result.executionSummary) {
      paginatedText += `\n\n### Execution Summary\n`;
      paginatedText += `- **CLI Agents:** ${result.executionSummary.successfulCLIs}/${result.executionSummary.totalCLIs} successful\n`;
      paginatedText += `- **Total Time:** ${result.executionSummary.totalExecutionTime}ms\n`;
      if (result.executionSummary.selectedCLI) {
        paginatedText += `- **Selected CLI:** ${result.executionSummary.selectedCLI}\n`;
      }
    }
    
    logger.info(`🔧 DEBUG: Returning paginated chunk - ${chunk.length} chars (${chunkTokens} tokens)`);
    
    return {
      content: [{ 
        type: "text" as const, 
        text: paginatedText 
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