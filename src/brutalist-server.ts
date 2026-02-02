import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CLIAgentOrchestrator, StreamingEvent } from './cli-agents.js';
import { logger } from './logger.js';
import { ToolConfig, BASE_ROAST_SCHEMA } from './types/tool-config.js';
import { getToolConfigs } from './tool-definitions.js';
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
import { getDomain, generateToolConfig } from './registry/domains.js';
import { filterToolsByIntent, getMatchingDomainIds } from './tool-router.js';

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
   *
   * TOOL REDUCTION STRATEGY: Only expose 4 gateway tools instead of 15.
   * The unified `roast` tool with domain parameter replaces all 11 roast_* tools.
   * This reduces cognitive load for AI agents while maintaining full functionality.
   */
  private registerTools() {
    // NOTE: Individual domain tools (roast_codebase, roast_security, etc.) are NOT registered.
    // Use the unified `roast` tool with domain parameter instead.
    // The getToolConfigs() function still exists for internal routing via handleUnifiedRoast().

    // Register only the gateway tools
    this.registerSpecialTools();
  }

  /**
   * Register special tools (debate, roster, unified roast)
   */
  private registerSpecialTools() {
    // UNIFIED ROAST TOOL: Single entry point for all domain analysis
    this.server.tool(
      "roast",
      "Unified brutal AI critique. Specify domain for targeted analysis. Consolidates all roast_* tools into one polymorphic API.",
      {
        domain: z.enum([
          "codebase", "file_structure", "dependencies", "git_history", "test_coverage",
          "idea", "architecture", "research", "security", "product", "infrastructure"
        ]).describe("Analysis domain"),
        target: z.string().describe("Directory path for filesystem domains (codebase, dependencies, git_history, etc.) OR text content for abstract domains (idea, architecture, security, etc.)"),
        // Common optional fields
        context: z.string().optional().describe("Additional context"),
        workingDirectory: z.string().optional().describe("Working directory"),
        clis: z.array(z.enum(["claude", "codex", "gemini"])).min(1).max(3).optional().describe("CLI agents to use (default: all available). Example: ['claude', 'gemini']"),
        verbose: z.boolean().optional().describe("Detailed output"),
        models: z.object({
          claude: z.string().optional(),
          codex: z.string().optional(),
          gemini: z.string().optional()
        }).optional().describe("CLI-specific models"),
        // Pagination
        offset: z.number().min(0).optional().describe("Pagination offset"),
        limit: z.number().min(1000).max(100000).optional().describe("Max chars/chunk"),
        cursor: z.string().optional().describe("Pagination cursor"),
        context_id: z.string().optional().describe("Context ID for pagination/continuation"),
        resume: z.boolean().optional().describe("Continue conversation"),
        force_refresh: z.boolean().optional().describe("Ignore cache"),
        // Domain-specific optional fields (passed through to handler)
        depth: z.number().optional().describe("Max depth for file_structure"),
        includeDevDeps: z.boolean().optional().describe("Include dev deps for dependencies"),
        commitRange: z.string().optional().describe("Commit range for git_history"),
        runCoverage: z.boolean().optional().describe("Run coverage for test_coverage"),
        resources: z.string().optional().describe("Resources for idea"),
        timeline: z.string().optional().describe("Timeline for idea"),
        scale: z.string().optional().describe("Scale for architecture/infrastructure"),
        constraints: z.string().optional().describe("Constraints for architecture"),
        deployment: z.string().optional().describe("Deployment for architecture"),
        field: z.string().optional().describe("Field for research"),
        claims: z.string().optional().describe("Claims for research"),
        data: z.string().optional().describe("Data for research"),
        assets: z.string().optional().describe("Assets for security"),
        threatModel: z.string().optional().describe("Threat model for security"),
        compliance: z.string().optional().describe("Compliance for security"),
        users: z.string().optional().describe("Users for product"),
        competition: z.string().optional().describe("Competition for product"),
        metrics: z.string().optional().describe("Metrics for product"),
        sla: z.string().optional().describe("SLA for infrastructure"),
        budget: z.string().optional().describe("Budget for infrastructure")
      },
      async (args, extra) => this.handleUnifiedRoast(args, extra)
    );

    // ROAST_CLI_DEBATE: Adversarial analysis between different CLI agents
    this.server.tool(
      "roast_cli_debate",
      "Deploy 2 CLI agents in structured adversarial debate with constitutional position anchoring. Calling agent should extract PRO/CON positions from topic before invoking.",
      {
        topic: z.string().describe("The debate topic"),
        proPosition: z.string().describe("The PRO thesis to defend (extracted by calling agent)"),
        conPosition: z.string().describe("The CON thesis to defend (extracted by calling agent)"),
        agents: z.array(z.enum(["claude", "codex", "gemini"])).length(2).optional()
          .describe("Two agents to debate (random selection from available if not specified)"),
        rounds: z.number().min(1).max(3).default(3).optional()
          .describe("Number of debate rounds (default: 3)"),
        context: z.string().optional().describe("Additional context for the debate"),
        workingDirectory: z.string().optional().describe("Working directory for analysis"),
        models: z.object({
          claude: z.string().optional(),
          codex: z.string().optional(),
          gemini: z.string().optional()
        }).optional().describe("Model overrides for specific agents"),
        // Pagination and conversation continuation
        context_id: z.string().optional().describe("Context ID for pagination/continuation"),
        resume: z.boolean().optional().describe("Continue debate (requires context_id)"),
        offset: z.number().min(0).optional(),
        limit: z.number().min(1000).max(100000).optional(),
        cursor: z.string().optional(),
        force_refresh: z.boolean().optional(),
        verbose: z.boolean().optional()
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

    // BRUTALIST_DISCOVER: Intent-based tool discovery
    this.server.tool(
      "brutalist_discover",
      "Discover relevant brutalist tools based on your intent. Returns the top 3 most relevant analysis tools.",
      {
        intent: z.string().describe("What you want to analyze (e.g., 'review security of my auth system', 'check code quality')")
      },
      async (args) => {
        const matchingDomains = getMatchingDomainIds(args.intent);
        const configs = filterToolsByIntent(args.intent);

        let response = "# Recommended Brutalist Domains\n\n";
        response += `Based on your intent: "${args.intent}"\n\n`;

        if (matchingDomains.length === 0) {
          response += "No specific matches found. Use the unified `roast` tool with any domain:\n";
          response += "- `roast(domain: 'codebase', target: '/path/to/code')` for code review\n";
          response += "- `roast(domain: 'security', target: 'description of system')` for security analysis\n";
        } else {
          response += `**Top ${matchingDomains.length} matching domains:**\n\n`;
          for (const config of configs) {
            // Extract domain from tool name (roast_security -> security)
            const domain = config.name.replace('roast_', '');
            response += `### ${domain}\n`;
            response += `${config.description}\n`;
            response += `\`roast(domain: '${domain}', target: '...')\`\n\n`;
          }
        }

        return {
          content: [{ type: "text" as const, text: response }]
        };
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

          roster += "## Available Tools (4 Gateway Tools)\n\n";

          roster += "### `roast` - Unified Analysis Tool\n";
          roster += "The primary entry point for all brutal analysis. Use the `domain` parameter to target:\n\n";
          roster += "**Filesystem Domains:**\n";
          roster += "- `codebase` - Analyze source code for security, performance, maintainability\n";
          roster += "- `file_structure` - Examine directory organization\n";
          roster += "- `dependencies` - Review package management and vulnerabilities\n";
          roster += "- `git_history` - Analyze version control workflow\n";
          roster += "- `test_coverage` - Evaluate testing strategy\n\n";
          roster += "**Abstract Domains:**\n";
          roster += "- `idea` - Destroy business/technical concepts\n";
          roster += "- `architecture` - Demolish system designs\n";
          roster += "- `research` - Tear apart methodologies\n";
          roster += "- `security` - Annihilate security designs\n";
          roster += "- `product` - Eviscerate UX concepts\n";
          roster += "- `infrastructure` - Obliterate DevOps setups\n\n";

          roster += "### `roast_cli_debate` - Adversarial Multi-Agent Debate\n";
          roster += "Pit CLI agents against each other on any topic.\n\n";

          roster += "### `brutalist_discover` - Intent-Based Discovery\n";
          roster += "Describe what you want to analyze, get domain recommendations.\n\n";

          roster += "### `cli_agent_roster` - This Tool\n";
          roster += "Show available capabilities and usage.\n\n";

          roster += "## CLI Agent Capabilities\n";
          roster += "**Claude Code** - Advanced analysis with direct system prompt injection\n";
          roster += "**Codex** - Secure execution with embedded brutal prompts\n";
          roster += "**Gemini CLI** - Workspace context with environment variable system prompts\n\n";

          // Add CLI context information
          const cliContext = await this.cliOrchestrator.detectCLIContext();
          roster += "## Current CLI Context\n";
          roster += `**Available CLIs:** ${cliContext.availableCLIs.join(', ') || 'None detected'}\n\n`;

          roster += "## Domain Discovery\n";
          roster += "Use `brutalist_discover` to find the best domain for your analysis:\n";
          roster += "- Example: `brutalist_discover(intent: 'review my authentication security')`\n";
          roster += "- Returns the top 3 most relevant domains to use with the `roast` tool\n\n";

          roster += "## Pagination & Conversation Continuation\n";
          roster += "**Two distinct modes for using context_id:**\n\n";
          roster += "**1. Pagination** (cached result retrieval):\n";
          roster += "- `context_id` alone returns cached response at different offsets\n";
          roster += "- Example: `roast(domain: 'codebase', target: '.', context_id: 'abc123', offset: 25000)`\n\n";
          roster += "**2. Conversation Continuation** (resume dialogue with history):\n";
          roster += "- `context_id` + `resume: true` + new content continues the conversation\n";
          roster += "- Prior conversation is injected into CLI agent context\n";
          roster += "- Example: `roast(domain: 'codebase', target: '.', context_id: 'abc123', resume: true)`\n\n";
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
   * Handle unified roast tool - routes to appropriate domain handler
   */
  private async handleUnifiedRoast(
    args: {
      domain: string;
      target: string;
      context?: string;
      workingDirectory?: string;
      clis?: ('claude' | 'codex' | 'gemini')[];
      verbose?: boolean;
      models?: { claude?: string; codex?: string; gemini?: string };
      offset?: number;
      limit?: number;
      cursor?: string;
      context_id?: string;
      resume?: boolean;
      force_refresh?: boolean;
      // Domain-specific fields
      [key: string]: unknown;
    },
    extra: any
  ): Promise<any> {
    // CRITICAL: Prevent recursion
    if (process.env.BRUTALIST_SUBPROCESS === '1') {
      logger.warn(`🚫 Rejecting unified roast from brutalist subprocess`);
      return {
        content: [{
          type: "text" as const,
          text: `ERROR: Brutalist MCP tools cannot be used from within a brutalist-spawned CLI subprocess (recursion prevented)`
        }]
      };
    }

    // Get domain config
    const domain = getDomain(args.domain);
    if (!domain) {
      return {
        content: [{
          type: "text" as const,
          text: `ERROR: Unknown domain "${args.domain}". Valid domains: codebase, file_structure, dependencies, git_history, test_coverage, idea, architecture, research, security, product, infrastructure`
        }]
      };
    }

    // Generate tool config from domain
    const toolConfig = generateToolConfig(domain);

    // Map 'target' to the appropriate primary arg field
    const mappedArgs: Record<string, unknown> = { ...args };
    delete mappedArgs.domain;
    delete mappedArgs.target;

    // Set the primary argument based on domain's input type
    if (domain.inputType === 'filesystem') {
      mappedArgs.targetPath = args.target;
    } else {
      mappedArgs.content = args.target;
      // For abstract tools, also set targetPath if workingDirectory not provided
      if (!args.workingDirectory) {
        mappedArgs.targetPath = '.';
      }
    }

    // Delegate to the unified handler
    return this.toolHandler.handleRoastTool(toolConfig, mappedArgs, extra);
  }

  /**
   * Handle debate tool execution with constitutional position anchoring.
   * Uses 2 randomly selected agents (or user-specified) with explicit PRO/CON positions.
   */
  private async handleDebateToolExecution(args: {
    topic: string;
    proPosition: string;
    conPosition: string;
    agents?: ('claude' | 'codex' | 'gemini')[];
    rounds?: number;
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
            if (!args.topic || args.topic.trim() === '') {
              throw new Error(
                `Debate continuation (resume: true) requires a new prompt/question. ` +
                `Provide your follow-up in the topic field.`
              );
            }

            logger.info(`💬 Debate continuation - new prompt: "${args.topic.substring(0, 50)}..."`);
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
        topic: args.topic,
        proPosition: args.proPosition,
        conPosition: args.conPosition,
        agents: args.agents,
        rounds: args.rounds,
        context: args.context
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
      const numRounds = Math.min(args.rounds || 3, 3);
      const result = await this.executeCLIDebate({
        topic: args.topic,
        proPosition: args.proPosition,
        conPosition: args.conPosition,
        agents: args.agents,
        rounds: numRounds,
        context: debateContext,
        workingDirectory: args.workingDirectory,
        models: args.models
      });

      // Cache the result
      let contextId: string | undefined;
      if (result.success && result.responses.length > 0) {
        const fullContent = this.formatter.extractFullContent(result);
        if (fullContent) {
          const now = Date.now();
          const updatedConversation: import('./utils/response-cache.js').ConversationMessage[] = [
            ...(conversationHistory || []),
            { role: 'user', content: args.topic, timestamp: now },
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
              { tool: 'roast_cli_debate', topic: args.topic },
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
   * Execute CLI debate with constitutional position anchoring.
   * 2 agents, explicit PRO/CON positions, context compression between rounds.
   */
  private async executeCLIDebate(args: {
    topic: string;
    proPosition: string;
    conPosition: string;
    agents?: ('claude' | 'codex' | 'gemini')[];
    rounds: number;
    context?: string;
    workingDirectory?: string;
    models?: { claude?: string; codex?: string; gemini?: string };
  }): Promise<BrutalistResponse> {
    const { topic, proPosition, conPosition, rounds, context, workingDirectory, models } = args;

    logger.debug("Executing CLI debate", { topic, proPosition, conPosition, rounds });

    try {
      // Get available CLIs
      const cliContext = await this.cliOrchestrator.detectCLIContext();
      const availableCLIs = cliContext.availableCLIs as ('claude' | 'codex' | 'gemini')[];

      if (availableCLIs.length < 2) {
        throw new Error(`Need at least 2 CLI agents for debate. Available: ${availableCLIs.join(', ')}`);
      }

      // Select 2 agents: use specified or random selection
      let selectedAgents: ('claude' | 'codex' | 'gemini')[];
      if (args.agents && args.agents.length === 2) {
        // Validate specified agents are available
        const unavailable = args.agents.filter(a => !availableCLIs.includes(a));
        if (unavailable.length > 0) {
          throw new Error(`Specified agents not available: ${unavailable.join(', ')}. Available: ${availableCLIs.join(', ')}`);
        }
        selectedAgents = args.agents;
      } else {
        // Random selection of 2 agents
        const shuffled = [...availableCLIs].sort(() => Math.random() - 0.5);
        selectedAgents = shuffled.slice(0, 2);
      }

      // Randomly assign PRO/CON positions
      const shuffledAgents = [...selectedAgents].sort(() => Math.random() - 0.5);
      const proAgent = shuffledAgents[0];
      const conAgent = shuffledAgents[1];

      logger.info(`🎭 Debate: ${proAgent.toUpperCase()} (PRO) vs ${conAgent.toUpperCase()} (CON)`);

      const debateResponses: import('./types/brutalist.js').CLIAgentResponse[] = [];
      const transcript: { agent: string; position: string; round: number; content: string }[] = [];
      let compressedContext = '';

      // Constitutional position anchor template
      const constitutionalAnchor = (agent: string, position: string, thesis: string) => `
You are ${agent.toUpperCase()}, arguing the ${position} position in this debate.

YOUR THESIS: ${thesis}

CONSTITUTIONAL RULES (UNBREAKABLE):
1. You MUST maintain your position throughout ALL rounds
2. You MAY acknowledge valid points but MUST explain why they don't invalidate your thesis
3. You MUST NOT agree to compromise or "meet in the middle"
4. You MUST directly attack your opponent's strongest arguments
5. You MUST reinforce your core thesis in every response

Your goal is PERSUASION, not consensus. Argue to WIN.
`;

      // Execute rounds
      for (let round = 1; round <= rounds; round++) {
        logger.info(`📢 Round ${round}/${rounds}`);

        // Both agents argue in each round
        for (const [agent, position, thesis] of [
          [proAgent, 'PRO', proPosition],
          [conAgent, 'CON', conPosition]
        ] as const) {

          let prompt: string;

          if (round === 1) {
            // Opening statement
            prompt = `${constitutionalAnchor(agent, position, thesis)}

DEBATE TOPIC: ${topic}
${context ? `CONTEXT: ${context}` : ''}

This is Round 1: OPENING STATEMENT

Present your opening argument for the ${position} position. Structure your response:

<thesis_statement>
State your core thesis clearly and forcefully
</thesis_statement>

<key_arguments>
Present 3 devastating arguments supporting your position
</key_arguments>

<preemptive_rebuttal>
Anticipate and destroy the strongest opposing argument
</preemptive_rebuttal>

<conclusion>
Powerful closing that reinforces why your position is correct
</conclusion>

Remember: You are arguing that "${thesis}" - defend this with conviction.`;

          } else {
            // Rebuttal rounds - include compressed context from previous rounds
            const opponentTranscript = transcript
              .filter(t => t.agent !== agent && t.round === round - 1)
              .map(t => t.content)
              .join('\n\n');

            prompt = `${constitutionalAnchor(agent, position, thesis)}

DEBATE TOPIC: ${topic}

This is Round ${round}: REBUTTAL

YOUR OPPONENT'S PREVIOUS ARGUMENT:
${opponentTranscript || 'No previous argument recorded'}

${compressedContext ? `DEBATE CONTEXT SO FAR:\n${compressedContext}\n` : ''}

Directly attack your opponent's arguments while reinforcing your position:

<opponent_weaknesses>
Quote their specific claims and expose the flaws
</opponent_weaknesses>

<counterarguments>
Systematically dismantle their reasoning
</counterarguments>

<reinforcement>
Show why your thesis "${thesis}" remains undefeated
</reinforcement>

<closing_attack>
Deliver a devastating final blow to their position
</closing_attack>

Remember: NEVER concede. Your thesis is correct. Argue to WIN.`;
          }

          logger.info(`  ⚔️ ${agent.toUpperCase()} (${position}) arguing...`);

          try {
            const response = await this.cliOrchestrator.executeSingleCLI(
              agent,
              prompt,
              prompt,
              {
                workingDirectory: workingDirectory || this.config.workingDirectory,
                timeout: (this.config.defaultTimeout || 60000) * 2,
                models
              }
            );

            // Always add response (success or failure) for visibility
            debateResponses.push(response);

            if (response.success && response.output) {
              transcript.push({
                agent,
                position,
                round,
                content: response.output
              });
            } else {
              logger.warn(`⚠️ ${agent.toUpperCase()} (${position}) failed: ${response.error || 'No output'}`);
            }
          } catch (error) {
            logger.error(`❌ ${agent.toUpperCase()} (${position}) threw error:`, error);
            debateResponses.push({
              agent,
              success: false,
              output: '',
              error: error instanceof Error ? error.message : String(error),
              executionTime: 0
            });
          }
        }

        // Compress context for next round (if not final round)
        if (round < rounds) {
          const roundTranscript = transcript
            .filter(t => t.round === round)
            .map(t => `${t.agent.toUpperCase()} (${t.position}): ${t.content.substring(0, 1500)}...`)
            .join('\n\n---\n\n');

          compressedContext = `Round ${round} Summary:\n${roundTranscript}`;
        }
      }

      // Build synthesis
      const synthesis = this.synthesizeDebate(
        debateResponses,
        topic,
        rounds,
        new Map([[proAgent, `PRO: ${proPosition}`], [conAgent, `CON: ${conPosition}`]])
      );

      return {
        success: debateResponses.some(r => r.success),
        responses: debateResponses,
        synthesis,
        analysisType: 'cli_debate',
        topic
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
    topic: string,
    rounds: number,
    agentPositions?: Map<string, string>
  ): string {
    const successfulResponses = responses.filter(r => r.success);

    if (successfulResponses.length === 0) {
      return `# CLI Debate Failed\n\nEven our brutal critics couldn't engage in proper adversarial combat.\n\nErrors:\n${responses.map(r => `- ${r.agent}: ${r.error}`).join('\n')}`;
    }

    let synthesis = `# Brutalist CLI Agent Debate Results\n\n`;
    synthesis += `**Topic:** ${topic}\n`;
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
