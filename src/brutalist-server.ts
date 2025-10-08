import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { CLIAgentOrchestrator, BrutalistPromptType, StreamingEvent } from './cli-agents.js';
import { logger } from './logger.js';
import { ToolConfig, BASE_ROAST_SCHEMA } from './types/tool-config.js';
import { TOOL_CONFIGS } from './tool-definitions.js';
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
import { ResponseCache } from './utils/response-cache.js';
// Use environment variable or fallback to manual version
const PACKAGE_VERSION = process.env.npm_package_version || "0.4.4";

export class BrutalistServer {
  public server: McpServer;
  public config: BrutalistServerConfig;
  private cliOrchestrator: CLIAgentOrchestrator;
  private httpTransport?: StreamableHTTPServerTransport;
  private responseCache: ResponseCache;
  private actualPort?: number;
  private shutdownHandler?: () => void;
  // Session tracking for security
  private activeSessions = new Map<string, {
    startTime: number;
    requestCount: number;
    lastActivity: number;
  }>();

  constructor(config: BrutalistServerConfig = {}) {
    this.config = {
      workingDirectory: process.cwd(),
      defaultTimeout: 1500000, // 25 minutes for thorough CLI analysis
      transport: 'stdio', // Default to stdio for backward compatibility
      httpPort: 3000,
      ...config
    };

    logger.debug("Initializing CLI Agent Orchestrator");
    this.cliOrchestrator = new CLIAgentOrchestrator();
    
    // Initialize response cache with configurable TTL
    const cacheTTLHours = parseInt(process.env.BRUTALIST_CACHE_TTL_HOURS || '2', 10);
    this.responseCache = new ResponseCache({
      ttlHours: cacheTTLHours,
      maxEntries: 50,
      maxTotalSizeMB: 500,
      maxEntrySizeMB: 10,
      compressionThresholdMB: 1
    });
    logger.info(`📦 Response cache initialized with ${cacheTTLHours} hour TTL`);

    this.server = new McpServer({
      name: "brutalist-mcp",
      version: PACKAGE_VERSION,
      capabilities: {
        tools: {},
        logging: {},
        experimental: {
          streaming: true
        }
      }
    });

    this.registerTools();
  }

  private handleStreamingEvent = (event: StreamingEvent) => {
    try {
      if (!event.sessionId) {
        logger.warn("⚠️ Streaming event without session ID - dropping for security");
        return;
      }
      
      logger.debug(`🔄 Session-scoped streaming: ${event.type} from ${event.agent} to session ${event.sessionId.substring(0, 8)}...`);
      
      // For HTTP transport: send session-specific notification
      if (this.httpTransport) {
        // Use MCP server's notification system with session context
        this.server.server.notification({
          method: "notifications/message",
          params: {
            level: 'info',
            data: {
              type: 'streaming_event',
              sessionId: event.sessionId,
              agent: event.agent,
              eventType: event.type,
              content: event.content?.substring(0, 1000), // Truncate for safety
              timestamp: event.timestamp
            },
            logger: 'brutalist-mcp-streaming'
          }
        });
      }
      // For STDIO transport: still send but with session info
      else {
        this.server.sendLoggingMessage({
          level: 'info',
          data: {
            sessionId: event.sessionId,
            agent: event.agent,
            type: event.type,
            content: event.content?.substring(0, 500) // More restrictive for stdio
          },
          logger: 'brutalist-mcp-streaming'
        });
      }
      
      // Update session activity
      if (this.activeSessions.has(event.sessionId)) {
        this.activeSessions.get(event.sessionId)!.lastActivity = Date.now();
      }
      
    } catch (error) {
      logger.error("💥 Failed to send session-scoped streaming event", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: event.sessionId?.substring(0, 8)
      });
    }
  };

  private handleProgressUpdate = (
    progressToken: string | number, 
    progress: number, 
    total: number, 
    message: string,
    sessionId?: string
  ) => {
    try {
      if (!sessionId) {
        logger.warn("⚠️ Progress update without session ID - dropping for security");
        return;
      }
      
      logger.debug(`📊 Session progress: ${progress}/${total} for session ${sessionId.substring(0, 8)}...`);
      
      // Send progress notification with session context
      this.server.server.notification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          total,
          message: `[${sessionId.substring(0, 8)}] ${message}`, // Include session prefix
          sessionId // Include in notification data
        }
      });
      
      logger.debug(`✅ Sent session-scoped progress notification: ${progress}/${total}`);
    } catch (error) {
      logger.error("💥 Failed to send progress notification", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: sessionId?.substring(0, 8)
      });
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
    
    // Secure CORS implementation
    app.use((req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin;
      const isProduction = process.env.NODE_ENV === 'production';
      
      // Define safe default origins for development
      const defaultDevOrigins = [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:8080',
        'http://127.0.0.1:8080',
        'http://localhost:3001',
        'http://127.0.0.1:3001'
      ];
      
      // Get allowed origins from config or use defaults
      const allowedOrigins = this.config.corsOrigins || defaultDevOrigins;
      const allowWildcard = this.config.allowCORSWildcard === true && !isProduction;
      
      // Determine if origin is allowed
      let allowedOrigin: string | null = null;
      
      if (allowWildcard) {
        // Only in development with explicit opt-in
        allowedOrigin = '*';
        logger.warn("⚠️ Using wildcard CORS - only safe in development!");
      } else if (!origin) {
        // No origin header (same-origin or direct server access)
        allowedOrigin = defaultDevOrigins[0]; // Default fallback
      } else if (allowedOrigins.includes(origin)) {
        // Explicitly allowed origin
        allowedOrigin = origin;
      } else {
        // Rejected origin
        logger.warn(`🚫 CORS rejected origin: ${origin}`);
        allowedOrigin = null;
      }
      
      // Set headers only if origin is allowed
      if (allowedOrigin) {
        res.header('Access-Control-Allow-Origin', allowedOrigin);
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
        // Removed Authorization header for security
        res.header('Access-Control-Allow-Credentials', 'false'); // Explicit false
      }
      
      if (req.method === 'OPTIONS') {
        if (allowedOrigin) {
          res.sendStatus(200);
        } else {
          res.sendStatus(403); // Forbidden for disallowed origins
        }
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
    const port = this.config.httpPort ?? 3000;
    
    return new Promise<void>((resolve, reject) => {
      const server = app.listen(port, '127.0.0.1', () => {
        const actualPort = (server.address() as any)?.port || port;
        this.actualPort = actualPort;
        logger.info(`HTTP server listening on port ${actualPort}`);
        logger.info(`MCP endpoint: http://localhost:${actualPort}/mcp`);
        logger.info(`Health check: http://localhost:${actualPort}/health`);
        resolve();
      });
      
      server.on('error', (error) => {
        logger.error('HTTP server failed to start', error);
        reject(error);
      });

      // Handle graceful shutdown - avoid duplicate listeners
      if (!this.shutdownHandler) {
        this.shutdownHandler = () => {
          logger.info('Received SIGTERM, shutting down gracefully');
          server.close(() => {
            logger.info('HTTP server closed');
            process.exit(0);
          });
        };
        process.on('SIGTERM', this.shutdownHandler);
      }
    });
  }

  // Getter for actual listening port (useful for tests)
  public getActualPort(): number | undefined {
    return this.actualPort;
  }

  // Cleanup method for tests - remove event listeners
  public cleanup(): void {
    if (this.shutdownHandler) {
      process.removeListener('SIGTERM', this.shutdownHandler);
      this.shutdownHandler = undefined;
    }
  }

  private registerTools() {
    // Register all roast tools using unified handler - DRY principle
    TOOL_CONFIGS.forEach(config => {
      const schema = {
        ...config.schemaExtensions,
        ...BASE_ROAST_SCHEMA
      };
      
      this.server.tool(
        config.name,
        config.description,
        schema,
        async (args, extra) => this.handleRoastTool(config, args, extra)
      );
    });

    // Register special tools that don't follow the pattern
    this.registerSpecialTools();
  }

  private registerSpecialTools() {
    // ROAST_CLI_DEBATE: Adversarial analysis between different CLI agents
    this.server.tool(
      "roast_cli_debate",
      "Deploy CLI agents in structured adversarial debate. Agents take opposing positions and systematically challenge each other's reasoning. Perfect for exploring complex topics from multiple perspectives and stress-testing ideas through rigorous intellectual discourse.",
      {
        targetPath: z.string().describe("Topic, question, or concept to debate (NOT a file path - use natural language)"),
        debateRounds: z.number().optional().describe("Number of debate rounds (default: 2, max: 10)"),
        context: z.string().optional().describe("Additional context for the debate"),
        workingDirectory: z.string().optional().describe("Working directory for analysis"),
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
          roster += "**Codex** - Secure execution with embedded brutal prompts\n";
          roster += "**Gemini CLI** - Workspace context with environment variable system prompts\n\n";
          
          // Add CLI context information
          const cliContext = await this.cliOrchestrator.detectCLIContext();
          roster += "## Current CLI Context\n";
          roster += `**Available CLIs:** ${cliContext.availableCLIs.join(', ') || 'None detected'}\n`;
          roster += `**Current CLI:** ${cliContext.currentCLI || 'Unknown'}\n`;
          roster += `**Smart Routing:** ${cliContext.currentCLI ? `Excludes ${cliContext.currentCLI} for analysis` : 'Uses all available CLIs'}\n\n`;
          
          roster += "## Pagination Support (NEW in v0.5.2)\n";
          roster += "**All tools now support intelligent pagination:**\n";
          roster += "- Analysis results are cached with 2-hour TTL\n";
          roster += "- Use `analysis_id` from response to paginate without re-running\n";
          roster += "- Smart text chunking preserves readability\n";
          roster += "- Example: `roast_codebase(analysis_id: 'a3f5c2d8', offset: 25000)`\n\n";
          
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
  /**
   * Unified handler for all roast tools - DRY principle
   */
  private async handleRoastTool(
    config: ToolConfig,
    args: any,
    extra: any
  ): Promise<any> {
    try {
      const progressToken = extra._meta?.progressToken;
      
      // Extract session context for security
      const sessionId = extra?.sessionId || 
                        extra?._meta?.sessionId || 
                        extra?.headers?.['mcp-session-id'] ||
                        `anonymous-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      
      const requestId = `${sessionId}-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      
      logger.debug(`🔐 Processing request with session: ${sessionId.substring(0, 8)}..., request: ${requestId.substring(0, 12)}...`);
      
      // Track session activity
      if (!this.activeSessions.has(sessionId)) {
        this.activeSessions.set(sessionId, {
          startTime: Date.now(),
          requestCount: 0,
          lastActivity: Date.now()
        });
      }
      const sessionInfo = this.activeSessions.get(sessionId)!;
      sessionInfo.requestCount++;
      sessionInfo.lastActivity = Date.now();
      
      // Debug logging: Log the received arguments to file
      const fs = require('fs');
      const debugLog = `/tmp/brutalist-tool-debug-${Date.now()}.log`;
      const logMessage = (msg: string) => {
        try {
          fs.appendFileSync(debugLog, `${new Date().toISOString()}: ${msg}\n`);
        } catch (e) {
          // Ignore filesystem errors
        }
      };
      
      logMessage(`🔧 ROAST TOOL DEBUG: Tool=${config.name}, primaryArgField=${config.primaryArgField}`);
      logMessage(`🔧 ROAST TOOL DEBUG: args=${JSON.stringify(args, null, 2)}`);
      logMessage(`🔧 ROAST TOOL DEBUG: extra=${JSON.stringify(extra, null, 2)}`);
      
      // Extract pagination parameters
      const paginationParams = extractPaginationParams(args);
      if (args.cursor) {
        const cursorParams = parseCursor(args.cursor);
        Object.assign(paginationParams, cursorParams);
      }
      
      // Check cache if analysis_id provided
      if (args.analysis_id && !args.force_refresh) {
        const cachedContent = await this.responseCache.get(args.analysis_id, sessionId);
        if (cachedContent) {
          logger.info(`🎯 Session-validated cache hit for analysis_id: ${args.analysis_id}`);
          const cachedResult: BrutalistResponse = {
            success: true,
            responses: [{
              agent: 'cached' as any,
              success: true,
              output: cachedContent,
              executionTime: 0
            }]
          };
          return this.formatToolResponse(cachedResult, args.verbose, paginationParams, args.analysis_id);
        } else {
          logger.info(`🔍 No valid cache entry for analysis_id: ${args.analysis_id} and session: ${sessionId?.substring(0, 8)}`);
        }
      }
      
      // Generate cache key for this request
      const cacheKey = this.responseCache.generateCacheKey(
        config.cacheKeyFields.reduce((acc, field) => {
          acc.tool = config.name;
          if (args[field] !== undefined) acc[field] = args[field];
          return acc;
        }, {} as Record<string, any>)
      );
      
      // Check if we have a cached result (unless forcing refresh)
      if (!args.force_refresh) {
        const cachedContent = await this.responseCache.get(cacheKey, sessionId);
        if (cachedContent) {
          const analysisId = this.responseCache.generateAnalysisId(cacheKey);
          logger.info(`🎯 Cache hit for new request, using analysis_id: ${analysisId}`);
          const cachedResult: BrutalistResponse = {
            success: true,
            responses: [{
              agent: 'cached' as any,
              success: true,
              output: cachedContent,
              executionTime: 0
            }]
          };
          return this.formatToolResponse(cachedResult, args.verbose, paginationParams, analysisId);
        }
      }
      
      // Build context with custom builder if available
      const context = config.contextBuilder ? config.contextBuilder(args) : args.context;
      
      // Get the primary argument (targetPath, idea, architecture, etc.)
      const primaryArg = args[config.primaryArgField];
      
      logMessage(`🔧 PRIMARY ARG DEBUG: primaryArgField=${config.primaryArgField}, primaryArg="${primaryArg}"`);
      logMessage(`🔧 PRIMARY ARG DEBUG: config.analysisType="${config.analysisType}"`);
      
      // Run the analysis
      const result = await this.executeBrutalistAnalysis(
        config.analysisType,
        primaryArg,
        config.systemPrompt,
        context,
        args.workingDirectory,
        args.preferredCLI,
        args.verbose,
        args.models,
        progressToken,
        sessionId,
        requestId
      );
      
      // Cache the result if successful
      let analysisId: string | undefined;
      if (result.success && result.responses.length > 0) {
        const fullContent = this.extractFullContent(result);
        if (fullContent) {
          const cacheData = config.cacheKeyFields.reduce((acc, field) => {
            acc.tool = config.name;
            if (args[field] !== undefined) acc[field] = args[field];
            return acc;
          }, {} as Record<string, any>);
          
          const { analysisId: newId } = await this.responseCache.set(
            cacheData,
            fullContent,
            cacheKey,
            sessionId,  // NEW: Bind to session
            requestId   // NEW: Track request
          );
          analysisId = newId;
          logger.info(`✅ Cached analysis result with ID: ${analysisId} for session: ${sessionId?.substring(0, 8)}`);
        }
      }
      
      return this.formatToolResponse(result, args.verbose, paginationParams, analysisId);
    } catch (error) {
      return this.formatErrorResponse(error);
    }
  }

  private async executeCLIDebate(
    targetPath: string,
    debateRounds: number,
    context?: string,
    workingDirectory?: string,
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
            timeout: (this.config.defaultTimeout || 60000) * 2,
            models: models ? { [agent]: models[agent as keyof typeof models] } : undefined
          }
        );
        
        if (response.success) {
          debateContext.push(response);
          if (response.output) {
            fullDebateTranscript.get(agent)?.push(response.output);
          }
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
              timeout: (this.config.defaultTimeout || 60000) * 2,
              models: models ? { [currentAgent]: models[currentAgent as keyof typeof models] } : undefined
            }
          );
          
          if (response.success) {
            debateContext.push(response);
            if (response.output) {
              fullDebateTranscript.get(currentAgent)?.push(response.output);
            }
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
      if (response.output) {
        agentOutputs.get(response.agent)?.push(response.output);
      }
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
    primaryContent: string, 
    systemPromptSpec: string,
    context?: string,
    workingDirectory?: string,
    preferredCLI?: 'claude' | 'codex' | 'gemini',
    verbose?: boolean,
    models?: {
      claude?: string;
      codex?: string;
      gemini?: string;
    },
    progressToken?: string | number,
    sessionId?: string,
    requestId?: string
  ): Promise<BrutalistResponse> {
    logger.info(`🏢 Starting brutalist analysis: ${analysisType}`);
    logger.info(`🔧 DEBUG: preferredCLI=${preferredCLI}, primaryContent=${primaryContent}`);
    logger.debug("Executing brutalist analysis", { 
      primaryContent,
      analysisType,
      systemPromptSpec,
      workingDirectory,
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
        primaryContent,
        systemPromptSpec,
        context,
        {
          workingDirectory: workingDirectory || this.config.workingDirectory,
          timeout: this.config.defaultTimeout,
          preferredCLI,
          analysisType: analysisType as BrutalistPromptType,
          models,
          onStreamingEvent: this.handleStreamingEvent,
          progressToken,
          onProgress: progressToken && sessionId ? 
            (progress: number, total: number, message: string) => 
              this.handleProgressUpdate(progressToken, progress, total, message, sessionId) : undefined,
          sessionId,
          requestId
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
        targetPath: primaryContent,
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


  /**
   * Extract full content from analysis result for caching
   */
  private extractFullContent(result: BrutalistResponse): string | null {
    if (result.synthesis) {
      return result.synthesis;
    } else if (result.responses && result.responses.length > 0) {
      const successfulResponses = result.responses.filter(r => r.success);
      if (successfulResponses.length > 0) {
        let output = `${successfulResponses.length} AI critics have systematically demolished your work.\n\n`;
        
        successfulResponses.forEach((response, index) => {
          output += `## Critic ${index + 1}: ${response.agent.toUpperCase()}\n`;
          output += `*Execution time: ${response.executionTime}ms*\n\n`;
          output += response.output;
          // Only add separator between critics, not after the last one
          if (index < successfulResponses.length - 1) {
            output += '\n\n---\n\n';
          }
        });
        
        return output;
      }
    }
    return null;
  }

  private formatToolResponse(result: BrutalistResponse, verbose: boolean = false, paginationParams?: PaginationParams, analysisId?: string) {
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
      return this.formatPaginatedResponse(primaryContent, paginationParams, result, verbose, analysisId);
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
    verbose: boolean,
    analysisId?: string
  ) {
    // Using imported pagination utilities
    
    const offset = paginationParams.offset || 0;
    const limit = paginationParams.limit || PAGINATION_DEFAULTS.DEFAULT_LIMIT;
    
    logger.info(`🔧 DEBUG: Paginating content - offset: ${offset}, limit: ${limit}, total: ${content.length}`);
    
    // Use ResponseChunker for intelligent boundary detection
    const chunker = new ResponseChunker(limit, 200); // 200 char overlap
    const chunks = chunker.chunkText(content);
    
    // Find the appropriate chunk based on offset
    let targetChunk = chunks[0]; // Default to first chunk
    let currentOffset = 0;
    
    for (const chunk of chunks) {
      if (offset >= chunk.startOffset && offset < chunk.endOffset) {
        targetChunk = chunk;
        break;
      }
      currentOffset = chunk.endOffset;
    }
    
    const chunkContent = targetChunk.content;
    const actualOffset = targetChunk.startOffset;
    const endOffset = targetChunk.endOffset;
    
    // Create pagination metadata
    const pagination = createPaginationMetadata(content.length, paginationParams, limit);
    const statusLine = formatPaginationStatus(pagination);
    
    // Estimate token usage for user awareness
    const chunkTokens = estimateTokenCount(chunkContent);
    const totalTokens = estimateTokenCount(content);
    
    // Format response with pagination info
    let paginatedText = '';
    
    // Add header
    paginatedText += `# Brutalist Analysis Results\n\n`;
    
    // Only show pagination metadata if pagination is actually needed
    const needsPagination = pagination.totalChunks > 1 || pagination.hasMore;
    
    if (needsPagination) {
      paginatedText += `**📊 Pagination Status:** ${statusLine}\n`;
      if (analysisId) {
        paginatedText += `**🔑 Analysis ID:** ${analysisId}\n`;
      }
      paginatedText += `**🔢 Token Estimate:** ~${chunkTokens.toLocaleString()} tokens (chunk) / ~${totalTokens.toLocaleString()} tokens (total)\n\n`;
      
      if (pagination.hasMore) {
        if (analysisId) {
          paginatedText += `**⏭️ Continue Reading:** Use \`analysis_id: "${analysisId}", offset: ${endOffset}\`\n\n`;
        } else {
          paginatedText += `**⏭️ Continue Reading:** Use \`offset: ${endOffset}\` for next chunk\n\n`;
        }
      }
    }
    
    paginatedText += `---\n\n`;
    
    // Add the actual content chunk
    paginatedText += chunkContent;
    
    // Add footer
    if (needsPagination) {
      paginatedText += `\n\n---\n\n`;
      if (pagination.hasMore) {
        paginatedText += `📖 **End of chunk ${pagination.chunkIndex}/${pagination.totalChunks}**\n`;
        if (analysisId) {
          paginatedText += `🔄 To continue: Include \`analysis_id: "${analysisId}"\` with \`offset: ${endOffset}\` in next request`;
        } else {
          paginatedText += `🔄 To continue: Use same tool with \`offset: ${endOffset}\``;
        }
      } else {
        paginatedText += `✅ **Complete analysis shown** (${content.length.toLocaleString()} characters total)`;
      }
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
    
    logger.info(`🔧 DEBUG: Returning paginated chunk - ${chunkContent.length} chars (${chunkTokens} tokens)`);
    
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
        sanitizedMessage = `DEBUG: Target path not found - Original error: ${error.message}`;
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