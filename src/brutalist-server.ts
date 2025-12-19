import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CLIAgentOrchestrator, StreamingEvent } from './cli-agents.js';
import { logger } from './logger.js';
import { ToolConfig, BASE_ROAST_SCHEMA } from './types/tool-config.js';
import { TOOL_CONFIGS } from './tool-definitions-generated.js';
import {
  BrutalistServerConfig,
  BrutalistResponse,
  PaginationParams
} from './types/brutalist.js';
import {
  extractPaginationParams,
  parseCursor,
  PAGINATION_DEFAULTS
} from './utils/pagination.js';
import { ResponseCache } from './utils/response-cache.js';
import { ResponseFormatter } from './formatting/response-formatter.js';
import { HttpTransport } from './transport/http-transport.js';
import { ToolHandler } from './handlers/tool-handler.js';

// Use environment variable or fallback to manual version
const PACKAGE_VERSION = process.env.npm_package_version || "0.6.12";

/**
 * BrutalistServer - Composition root for the Brutalist MCP Server
 *
 * This class has been refactored to follow the Single Responsibility Principle.
 * Responsibilities are now delegated to specialized modules:
 * - ResponseFormatter: Handles all response formatting and pagination
 * - HttpTransport: Manages HTTP server and CORS
 * - ToolHandler: Handles roast tool execution, caching, and conversation continuation
 */
export class BrutalistServer {
  public server: McpServer;
  public config: BrutalistServerConfig;

  // Core dependencies
  private cliOrchestrator: CLIAgentOrchestrator;
  private responseCache: ResponseCache;

  // Extracted modules
  private formatter: ResponseFormatter;
  private toolHandler: ToolHandler;
  private httpTransport?: HttpTransport;

  // Session tracking for security
  private activeSessions = new Map<string, {
    startTime: number;
    requestCount: number;
    lastActivity: number;
  }>();

  // Session cleanup configuration
  private readonly MAX_SESSIONS = 10000;
  private readonly SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private sessionCleanupTimer?: NodeJS.Timeout;

  constructor(config: BrutalistServerConfig = {}) {
    this.config = {
      workingDirectory: process.cwd(),
      defaultTimeout: 1800000, // 30 minutes - complex codebases need time
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

    // Session cleanup timer - runs hourly
    this.sessionCleanupTimer = setInterval(() => this.cleanupStaleSessions(), 60 * 60 * 1000);
    this.sessionCleanupTimer.unref(); // Don't block Node.js exit
    logger.info(`🔐 Session cleanup initialized (TTL: 24h, max: ${this.MAX_SESSIONS})`);

    // Initialize extracted modules
    this.formatter = new ResponseFormatter();
    this.toolHandler = new ToolHandler(
      this.cliOrchestrator,
      this.responseCache,
      this.formatter,
      this.config,
      this.activeSessions,
      this.handleStreamingEvent,
      this.handleProgressUpdate,
      () => this.ensureSessionCapacity() // Session capacity management
    );

    // Initialize MCP server
    this.server = new McpServer(
      {
        name: "brutalist-mcp",
        version: PACKAGE_VERSION
      },
      {
        capabilities: {
          tools: {},
          logging: {}
          // Removed experimental.streaming - caused Zod validation errors in Claude Code client
        }
      }
    );

    this.registerTools();
  }

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
    // Create and start HTTP transport
    this.httpTransport = new HttpTransport(
      this.config,
      (transport) => {
        // Connect MCP server to HTTP transport
        this.server.connect(transport);
      }
    );

    await this.httpTransport.start(PACKAGE_VERSION);
  }

  // Getter for actual listening port (useful for tests)
  public getActualPort(): number | undefined {
    return this.httpTransport?.getActualPort();
  }

  // Stop the HTTP server gracefully
  public async stop(): Promise<void> {
    if (this.httpTransport) {
      await this.httpTransport.stop();
    }
  }

  /**
   * Clean up stale sessions that exceed TTL
   */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.activeSessions) {
      if (now - session.lastActivity > this.SESSION_TTL_MS) {
        this.activeSessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info(`🧹 Cleaned ${cleaned} stale sessions (>${this.SESSION_TTL_MS / 3600000}h idle)`);
    }
  }

  /**
   * Ensure session capacity doesn't exceed MAX_SESSIONS
   * Evicts oldest sessions when capacity is reached
   */
  public ensureSessionCapacity(): void {
    while (this.activeSessions.size >= this.MAX_SESSIONS) {
      // Remove oldest session (first entry in Map)
      const oldestKey = this.activeSessions.keys().next().value;
      if (oldestKey) {
        this.activeSessions.delete(oldestKey);
        logger.debug(`♻️ Evicted oldest session to maintain capacity`);
      } else {
        break;
      }
    }
  }

  // Cleanup method for tests - remove event listeners
  public cleanup(): void {
    if (this.httpTransport) {
      this.httpTransport.cleanup();
    }
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = undefined;
    }
  }

  /**
   * Handle streaming events from CLI agents
   */
  private handleStreamingEvent = (event: StreamingEvent) => {
    try {
      if (!event.sessionId) {
        logger.warn("⚠️ Streaming event without session ID - dropping for security");
        return;
      }

      logger.debug(`🔄 Session-scoped streaming: ${event.type} from ${event.agent} to session ${event.sessionId.substring(0, 8)}...`);

      // For HTTP transport: send session-specific notification if client supports it
      const httpTransportInstance = this.httpTransport?.getTransport();
      if (httpTransportInstance) {
        try {
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
        } catch (notificationError) {
          // Client doesn't support logging notifications - silently skip
          logger.debug("Client doesn't support logging notifications, skipping streaming event");
        }
      }
      // For STDIO transport: still send but with session info
      else {
        try {
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
        } catch (loggingError) {
          // Client doesn't support logging - silently skip
          logger.debug("Client doesn't support logging, skipping streaming event");
        }
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

  /**
   * Handle progress updates from CLI agents
   */
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

      // Send progress notification with session context if client supports it
      try {
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
      } catch (notificationError) {
        // Client doesn't support progress notifications - silently skip
        logger.debug("Client doesn't support progress notifications, skipping");
      }
    } catch (error) {
      logger.error("💥 Failed to send progress notification", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: sessionId?.substring(0, 8)
      });
    }
  };

  /**
   * Register all MCP tools
   */
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
        async (args, extra) => this.toolHandler.handleRoastTool(config, args, extra)
      );
    });

    // Register special tools that don't follow the pattern
    this.registerSpecialTools();
  }

  /**
   * Register special tools (debate, roster)
   */
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
          claude: z.string().optional().describe("Claude model: opus (recommended), sonnet, haiku, opusplan, or full name like claude-opus-4-5-20251101. Default: user's configured model"),
          codex: z.string().optional().describe("Codex model: gpt-5.1-codex-max (recommended), gpt-5.2, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5-codex, o4-mini. Default: CLI's default"),
          gemini: z.string().optional().describe("Gemini model: gemini-3-pro (recommended), gemini-3-flash, gemini-2.5-pro, gemini-2.5-flash. Default: Auto routing")
        }).optional().describe("Specific models to use for each CLI agent - defaults let each CLI use its own latest model"),
        // Pagination and continuation parameters
        context_id: z.string().optional().describe("Context ID from previous response for pagination or conversation continuation"),
        resume: z.boolean().optional().describe("Continue debate with history injection (requires context_id)"),
        offset: z.number().min(0).optional().describe("Pagination offset"),
        limit: z.number().min(1000).max(100000).optional().describe("Max chars/chunk (default: 90000)"),
        cursor: z.string().optional().describe("Pagination cursor"),
        force_refresh: z.boolean().optional().describe("Ignore cache"),
        verbose: z.boolean().optional().describe("Detailed output")
      },
      async (args) => {
        // CRITICAL: Prevent recursion
        if (process.env.BRUTALIST_SUBPROCESS === '1') {
          logger.warn(`🚫 Rejecting roast_cli_debate from brutalist subprocess`);
          return {
            content: [{
              type: "text" as const,
              text: `ERROR: Brutalist MCP tools cannot be used from within a brutalist-spawned CLI subprocess (recursion prevented)`
            }]
          };
        }

        return this.handleDebateToolExecution(args);
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
          roster += `**Available CLIs:** ${cliContext.availableCLIs.join(', ') || 'None detected'}\n\n`;

          roster += "## Pagination & Conversation Continuation\n";
          roster += "**Two distinct modes for using context_id:**\n\n";
          roster += "**1. Pagination** (cached result retrieval):\n";
          roster += "- `context_id` alone returns cached response at different offsets\n";
          roster += "- Example: `roast_codebase(context_id: 'abc123', offset: 25000)`\n\n";
          roster += "**2. Conversation Continuation** (resume dialogue with history):\n";
          roster += "- `context_id` + `resume: true` + new content continues the conversation\n";
          roster += "- Prior conversation is injected into CLI agent context\n";
          roster += "- Example: `roast_codebase(context_id: 'abc123', resume: true, content: 'Explain issue #3 in detail')`\n\n";
          roster += "**Cache TTL:** 2 hours\n\n";

          roster += "## Brutalist Philosophy\n";
          roster += "*All tools use CLI agents with brutal system prompts for maximum reality-based criticism.*\n";

          return {
            content: [{ type: "text" as const, text: roster }]
          };
        } catch (error) {
          return this.formatter.formatErrorResponse(error);
        }
      }
    );
  }

  /**
   * Handle debate tool execution with caching, pagination, and conversation continuation
   * Delegated mostly to ToolHandler but kept here for CLI debate-specific logic
   */
  private async handleDebateToolExecution(args: {
    targetPath: string;
    debateRounds?: number;
    context?: string;
    workingDirectory?: string;
    models?: { claude?: string; codex?: string; gemini?: string };
    context_id?: string;
    resume?: boolean;
    offset?: number;
    limit?: number;
    cursor?: string;
    force_refresh?: boolean;
    verbose?: boolean;
  }): Promise<any> {
    try {
      // Build pagination params
      const paginationParams: PaginationParams = {
        offset: args.offset || 0,
        limit: args.limit || PAGINATION_DEFAULTS.DEFAULT_LIMIT_TOKENS
      };

      if (args.cursor) {
        const cursorParams = parseCursor(args.cursor);
        Object.assign(paginationParams, cursorParams);
      }

      const explicitPaginationRequested =
        args.offset !== undefined ||
        args.limit !== undefined ||
        args.cursor !== undefined ||
        args.context_id !== undefined;

      // Validate resume flag requires context_id
      if (args.resume && !args.context_id) {
        throw new Error(
          `The 'resume' flag requires a 'context_id' from a previous debate. ` +
          `Run an initial debate first, then use the returned context_id with resume: true.`
        );
      }

      // Check cache if context_id provided
      let conversationHistory: import('./utils/response-cache.js').ConversationMessage[] | undefined;
      if (args.context_id && !args.force_refresh) {
        const cachedResponse = await this.responseCache.getByContextId(args.context_id);
        if (cachedResponse) {
          logger.info(`🎯 Debate cache HIT for context_id: ${args.context_id}`);

          if (args.resume === true) {
            // CONVERSATION CONTINUATION: Continue the debate
            if (!args.targetPath || args.targetPath.trim() === '') {
              throw new Error(
                `Debate continuation (resume: true) requires a new prompt/question. ` +
                `Provide your follow-up in the targetPath field.`
              );
            }

            logger.info(`💬 Debate continuation - new prompt: "${args.targetPath.substring(0, 50)}..."`);
            conversationHistory = cachedResponse.conversationHistory || [];
            // Fall through to execute new debate round with history
          } else {
            // PAGINATION: Return cached debate result
            logger.info(`📖 Debate pagination request - returning cached response`);
            const cachedResult: BrutalistResponse = {
              success: true,
              responses: [{
                agent: 'cached' as any,
                success: true,
                output: cachedResponse.content,
                executionTime: 0
              }]
            };
            return this.formatter.formatToolResponse(cachedResult, args.verbose, paginationParams, args.context_id, explicitPaginationRequested);
          }
        } else {
          logger.warn(`❌ Debate cache MISS for context_id: ${args.context_id}`);
          throw new Error(
            `Context ID "${args.context_id}" not found in cache. ` +
            `It may have expired (2 hour TTL) or belong to a different session. ` +
            `Remove context_id parameter to run a new debate.`
          );
        }
      }

      // Generate cache key for this debate
      const cacheKey = this.responseCache.generateCacheKey({
        tool: 'roast_cli_debate',
        targetPath: args.targetPath,
        debateRounds: args.debateRounds,
        context: args.context,
        models: args.models
      });

      // Check cache for identical request (if not resuming)
      if (!args.force_refresh && !args.resume) {
        const cachedContent = await this.responseCache.get(cacheKey);
        if (cachedContent) {
          const existingContextId = this.responseCache.findContextIdForKey(cacheKey);
          const contextId = existingContextId
            ? this.responseCache.createAlias(existingContextId, cacheKey)
            : this.responseCache.generateContextId(cacheKey);
          logger.info(`🎯 Debate cache hit for new request, using context_id: ${contextId}`);
          const cachedResult: BrutalistResponse = {
            success: true,
            responses: [{
              agent: 'cached' as any,
              success: true,
              output: cachedContent,
              executionTime: 0
            }]
          };
          return this.formatter.formatToolResponse(cachedResult, args.verbose, paginationParams, contextId, explicitPaginationRequested);
        }
      }

      // Build context with conversation history if resuming
      let debateContext = args.context || '';
      if (conversationHistory && conversationHistory.length > 0) {
        const previousDebate = conversationHistory.map(msg => {
          const role = msg.role === 'user' ? 'User Question' : 'Debate Response';
          return `${role}:\n${msg.content}`;
        }).join('\n\n---\n\n');

        debateContext = `## Previous Debate Context\n\n${previousDebate}\n\n---\n\n## New Follow-up Question\n\nThe user wants to continue this debate with a new question or direction.\n\n${debateContext}`;
        logger.info(`💬 Injected ${conversationHistory.length} previous messages into debate context`);
      }

      // Execute the debate
      const debateRounds = Math.min(args.debateRounds || 2, 10);
      const result = await this.executeCLIDebate(
        args.targetPath,
        debateRounds,
        debateContext,
        args.workingDirectory,
        args.models
      );

      // Cache the result
      let contextId: string | undefined;
      if (result.success && result.responses.length > 0) {
        const fullContent = this.formatter.extractFullContent(result);
        if (fullContent) {
          const now = Date.now();
          const updatedConversation: import('./utils/response-cache.js').ConversationMessage[] = [
            ...(conversationHistory || []),
            { role: 'user', content: args.targetPath, timestamp: now },
            { role: 'assistant', content: fullContent, timestamp: now }
          ];

          if (args.resume && args.context_id && conversationHistory) {
            // Update existing cache entry
            contextId = args.context_id;
            await this.responseCache.updateByContextId(
              contextId,
              fullContent,
              updatedConversation
            );
            logger.info(`✅ Updated debate conversation ${contextId} (now ${updatedConversation.length} messages)`);
          } else {
            // New debate - create new context_id
            const { contextId: newId } = await this.responseCache.set(
              { tool: 'roast_cli_debate', targetPath: args.targetPath },
              fullContent,
              cacheKey,
              undefined,
              undefined,
              updatedConversation
            );
            contextId = newId;
            logger.info(`✅ Cached new debate with context ID: ${contextId}`);
          }
        }
      }

      return this.formatter.formatToolResponse(result, args.verbose, paginationParams, contextId, explicitPaginationRequested);
    } catch (error) {
      return this.formatter.formatErrorResponse(error);
    }
  }

  /**
   * Execute CLI debate (kept in server for debate-specific logic)
   */
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
      workingDirectory
    });

    try {
      // Get CLI context
      const cliContext = await this.cliOrchestrator.detectCLIContext();
      const availableAgents = cliContext.availableCLIs;

      if (availableAgents.length < 2) {
        throw new Error(`Need at least 2 CLI agents for debate. Available: ${availableAgents.join(', ')}`);
      }

      const debateContext: import('./types/brutalist.js').CLIAgentResponse[] = [];
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

  /**
   * Synthesize debate results into formatted output
   */
  private synthesizeDebate(
    responses: import('./types/brutalist.js').CLIAgentResponse[],
    targetPath: string,
    rounds: number,
    agentPositions?: Map<string, string>
  ): string {
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
}
