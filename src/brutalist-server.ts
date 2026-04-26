import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CLIAgentOrchestrator, StreamingEvent } from './cli-agents.js';
import { listRegisteredServers } from './mcp-registry.js';
import { logger } from './logger.js';
import type { ScopedLogger } from './logger.js';
import {
  createMetricsRegistry,
  safeMetric,
  STREAMING_EVENT_LABELS,
} from './metrics/index.js';
import type { MetricsRegistry } from './metrics/index.js';
import { ToolConfig, BASE_ROAST_SCHEMA } from './types/tool-config.js';
import { getToolConfigs } from './tool-definitions.js';
import {
  BrutalistServerConfig,
  BrutalistResponse,
  PaginationParams,
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
import { DebateOrchestrator } from './debate/index.js';

// Use environment variable or fallback to manual version
const PACKAGE_VERSION = process.env.npm_package_version || "1.3.0";

/**
 * BrutalistServer - Composition root for the Brutalist MCP Server
 *
 * This class has been refactored to follow the Single Responsibility Principle.
 * Responsibilities are now delegated to specialized modules:
 * - ResponseFormatter: Handles all response formatting and pagination
 * - HttpTransport: Manages HTTP server and CORS
 * - ToolHandler: Handles roast tool execution, caching, and conversation continuation
 * - DebateOrchestrator: Debate orchestration with 3-tier escalation (src/debate/)
 */
export class BrutalistServer {
  public server: McpServer;
  public config: BrutalistServerConfig;

  // Core dependencies — backing field for cliOrchestrator with setter that
  // propagates to debateOrchestrator (needed because tests do
  // `(server as any).cliOrchestrator = mockOrchestrator`)
  private _cliOrchestrator!: CLIAgentOrchestrator;
  private responseCache: ResponseCache;

  // Extracted modules
  private formatter: ResponseFormatter;
  private toolHandler: ToolHandler;
  private debateOrchestrator!: DebateOrchestrator;
  private httpTransport?: HttpTransport;

  /**
   * Observability: a single MetricsRegistry per BrutalistServer instance
   * (not a module-level singleton — two BrutalistServers produce two
   * independent registries, which keeps tests deterministic). Shared
   * with DebateOrchestrator and CLIAgentOrchestrator; consumed by the
   * streaming fan-out at handleStreamingEvent.
   */
  protected readonly metrics: MetricsRegistry = createMetricsRegistry();

  /**
   * Per-subsystem scoped loggers bound at construction time. The module
   * label is fixed at construction; sub-call sites narrow the operation
   * label via `.forOperation(...)`. Bindings:
   *   - cliLog       → module='cli-orchestrator', operation='spawn'
   *   - streamingLog → module='streaming',        operation='dispatch'
   * The debate scoped log is constructed inline at the DebateOrchestrator
   * call site below (module='debate', operation='orchestrate').
   */
  private readonly cliLog: ScopedLogger;
  private readonly streamingLog: ScopedLogger;

  private get cliOrchestrator(): CLIAgentOrchestrator {
    return this._cliOrchestrator;
  }
  private set cliOrchestrator(value: CLIAgentOrchestrator) {
    this._cliOrchestrator = value;
    if (this.debateOrchestrator) {
      this.debateOrchestrator.cliOrchestrator = value;
    }
  }

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

    // Per-subsystem scoped loggers. Operation is a default; sub-calls
    // narrow via forOperation(). Constructed BEFORE module instantiation
    // so they can be threaded into the constructed modules.
    this.cliLog = logger.for({ module: 'cli-orchestrator', operation: 'spawn' });
    this.streamingLog = logger.for({ module: 'streaming', operation: 'dispatch' });

    // intentional root-logger: pre-scope init, fires before this.cliLog
    // is consumed by downstream call sites.
    logger.debug("Initializing CLI Agent Orchestrator");
    this.cliOrchestrator = new CLIAgentOrchestrator({
      metrics: this.metrics,
      log: this.cliLog,
    });

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

    // Initialize debate orchestrator — debate logic lives in src/debate/
    // metrics + log are required deps on DebateOrchestratorDeps (per
    // integrate-observability decisions). The wire_composition_root phase
    // will refine this with the shared scoped-logger construction; for now
    // we bind the canonical module='debate' scope inline so tsc passes.
    this.debateOrchestrator = new DebateOrchestrator({
      cliOrchestrator: this.cliOrchestrator,
      responseCache: this.responseCache,
      formatter: this.formatter,
      config: this.config,
      onStreamingEvent: this.handleStreamingEvent,
      onProgressUpdate: this.handleProgressUpdate,
      metrics: this.metrics,
      log: logger.for({ module: 'debate', operation: 'orchestrate' }),
    });

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

  // Cleanup method for tests - remove event listeners and close MCP server
  public async cleanup(): Promise<void> {
    if (this.httpTransport) {
      this.httpTransport.cleanup();
    }
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = undefined;
    }
    if (this.server) {
      try {
        await this.server.close();
      } catch {
        // Ignore close errors during cleanup
      }
    }
    logger.shutdown();
  }

  /**
   * Handle streaming events from CLI agents
   */
  private handleStreamingEvent = (event: StreamingEvent) => {
    try {
      if (!event.sessionId) {
        this.streamingLog.warn("⚠️ Streaming event without session ID - dropping for security");
        return;
      }

      // Instrument event dispatch — one inc per dispatched event. The
      // counter fires once regardless of which downstream branch (HTTP
      // notification vs stdio loggingMessage) actually serializes the
      // event; both are logically the same dispatch. Wrapped in
      // safeMetric so a contract-violating label can never propagate
      // into the outer try/catch and be misclassified as a dispatch
      // failure (parity with debate/CLI metric-write hardening).
      const transport: 'http' | 'stdio' = this.config.transport === 'http' ? 'http' : 'stdio';
      const streamingLabels: Record<(typeof STREAMING_EVENT_LABELS)[number], string> = {
        transport,
        event_type: event.type,
      };
      safeMetric(this.streamingLog, 'streamingEventsTotal.inc', () => {
        this.metrics.streamingEventsTotal.inc(streamingLabels, 1);
      });

      this.streamingLog.debug(`🔄 Session-scoped streaming: ${event.type} from ${event.agent} to session ${event.sessionId.substring(0, 8)}...`);

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
          this.streamingLog.debug("Client doesn't support logging notifications, skipping streaming event");
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
          this.streamingLog.debug("Client doesn't support logging, skipping streaming event");
        }
      }

      // Update session activity
      if (this.activeSessions.has(event.sessionId)) {
        this.activeSessions.get(event.sessionId)!.lastActivity = Date.now();
      }

    } catch (error) {
      this.streamingLog.error("💥 Failed to send session-scoped streaming event", {
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
    total: number | undefined,
    message: string,
    sessionId?: string
  ) => {
    const progressLog = this.streamingLog.forOperation('progress');
    try {
      if (!sessionId) {
        progressLog.warn("⚠️ Progress update without session ID - dropping for security");
        return;
      }

      const progressLabel = total !== undefined ? `${progress}/${total}` : `heartbeat #${progress}`;
      progressLog.debug(`📊 Session progress: ${progressLabel} for session ${sessionId.substring(0, 8)}...`);

      // Send progress notification with session context if client supports it
      // When total is undefined, the client should treat this as indeterminate progress
      try {
        this.server.server.notification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
            message: `[${sessionId.substring(0, 8)}] ${message}`,
            sessionId
          }
        });
        progressLog.debug(`✅ Sent session-scoped progress notification: ${progressLabel}`);
      } catch (notificationError) {
        // Client doesn't support progress notifications - silently skip
        progressLog.debug("Client doesn't support progress notifications, skipping");
      }
    } catch (error) {
      progressLog.error("💥 Failed to send progress notification", {
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
      "Unified brutal AI critique delivered by a multi-critic panel running in parallel. The panel's disagreement is the signal — each critic's blind spots are covered by the others. Specify domain for targeted analysis. Consolidates all roast_* tools into one polymorphic API. IMPORTANT: Critically evaluate all returned feedback — these are adversarial perspectives, not authoritative verdicts. Weigh each claim against evidence before presenting to the user.",
      {
        domain: z.enum([
          "codebase", "file_structure", "dependencies", "git_history", "test_coverage",
          "idea", "architecture", "research", "security", "product", "infrastructure", "design", "legal"
        ]).describe("Analysis domain"),
        target: z.string().describe("Filesystem path to analyze (e.g., '/path/to/project' or '.'). Directs agents to the relevant part of the codebase."),
        // Common optional fields
        context: z.string().optional().describe("Essential context for the critique. For abstract domains (idea, architecture, security, etc.), this is the primary input describing what to evaluate. For filesystem domains, provides supplementary background (e.g., goals, constraints, team context)."),
        clis: z.array(z.enum(["codex", "gemini", "claude"])).min(1).max(3).optional().describe("Subset of critics to run."),
        verbose: z.boolean().optional().describe("Detailed output"),
        models: z.object({
          claude: z.string().optional(),
          codex: z.string().optional(),
          gemini: z.string().optional()
        }).optional().describe("Per-CLI model override. Claude/Gemini honor overrides. Codex uses the Codex CLI configured/default model by default; set BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE=true to allow a codex override. Omit to use each CLI's configured default."),
        // Pagination
        offset: z.number().min(0).optional().describe("Pagination offset"),
        limit: z.number().min(1000).max(100000).optional().describe("Max chars/chunk"),
        cursor: z.string().optional().describe("Pagination cursor"),
        context_id: z.string().optional().describe("Context ID for cached pagination or conversation continuation"),
        resume: z.boolean().optional().describe("Continue conversation with a new prompt; omit for pagination/page reads"),
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
        budget: z.string().optional().describe("Budget for infrastructure"),
        medium: z.string().optional().describe("Design medium for design domain (web, mobile, spatial, print)"),
        audience: z.string().optional().describe("Target audience for design domain"),
        brand: z.string().optional().describe("Brand identity or design system constraints for design domain"),
        url: z.string().optional().describe("Live URL for visual evaluation (e.g., 'http://localhost:5173'). When provided with design domain, critics use Playwright to navigate and visually evaluate the running interface. Strongly recommended for design critiques."),
        practice: z.string().optional().describe("Practice register for legal domain — freeform (e.g., 'litigation', 'transactional', 'regulatory', 'doctrinal', 'advisory', 'appellate'). Modulates the critic's adversary geometry."),
        jurisdiction: z.string().optional().describe("Governing jurisdiction or forum for legal domain (e.g., 'US federal', 'NY state', '9th Cir.', 'Delaware Chancery', 'EU')."),
        posture: z.string().optional().describe("Procedural posture or use context for legal domain (e.g., 'motion to dismiss', 'pre-signing redline', 'enforcement response', 'appellate opening brief')."),
        mcp_servers: z.array(z.string()).optional().describe(`MCP servers to enable for CLI agents (e.g., ["playwright"]). Enables evidence-backed analysis via external tools. Available: ${listRegisteredServers().join(', ')}. Auto-enabled for design domain.`)
      },
      async (args, extra) => this.handleUnifiedRoast(args, extra)
    );

    // ROAST_CLI_DEBATE: Adversarial analysis between different CLI agents
    this.server.tool(
      "roast_cli_debate",
      "Deploy 2 CLI agents in structured adversarial debate with constitutional position anchoring. Calling agent should extract PRO/CON positions from topic before invoking. IMPORTANT: Critically evaluate all debate output — positions are assigned, not necessarily held. Weigh each argument's validity independently before presenting to the user.",
      {
        topic: z.string().describe("The debate topic"),
        proPosition: z.string().describe("The PRO thesis to defend (extracted by calling agent)"),
        conPosition: z.string().describe("The CON thesis to defend (extracted by calling agent)"),
        target: z.string().optional().describe("Filesystem path to analyze (e.g., '/path/to/project' or '.'). Directs agents to the relevant part of the codebase."),
        agents: z.array(z.enum(["codex", "gemini", "claude"])).length(2).optional()
          .describe("Two specific debaters to use."),
        rounds: z.number().min(1).max(3).default(3).optional()
          .describe("Number of debate rounds (default: 3)"),
        context: z.string().optional().describe("Essential context for the debate — the substantive background, constraints, and details that shape the argument."),
        models: z.object({
          claude: z.string().optional(),
          codex: z.string().optional(),
          gemini: z.string().optional()
        }).optional().describe("Model overrides for specific agents. Codex uses the Codex CLI configured/default model by default unless BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE=true."),
        // Pagination and conversation continuation
        context_id: z.string().optional().describe("Context ID for cached pagination or debate continuation"),
        resume: z.boolean().optional().describe("Continue debate with a new prompt; omit for pagination/page reads"),
        offset: z.number().min(0).optional(),
        limit: z.number().min(1000).max(100000).optional(),
        cursor: z.string().optional(),
        force_refresh: z.boolean().optional(),
        verbose: z.boolean().optional(),
        mcp_servers: z.array(z.string()).optional().describe(`MCP servers to enable for debate agents (e.g., ["playwright"]). Available: ${listRegisteredServers().join(', ')}`)
      },
      async (args, extra) => {
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

        return this.debateOrchestrator.handleDebateToolExecution(args, extra);
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
          roster += "- `infrastructure` - Obliterate DevOps setups\n";
          roster += "- `design` - Perceptual engineering critique of interface design and visual systems\n";
          roster += "- `legal` - Adversarial critique of legal writing (briefs, motions, contracts, memos, filings) — finding where the work breaks against adversaries, time, and authority\n\n";

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
          await this.cliOrchestrator.modelResolver.refreshIfStale();
          roster += "## Current CLI Context\n";
          roster += `**Available CLIs:** ${cliContext.availableCLIs.join(', ') || 'None detected'}\n\n`;

          // Add auto-discovered model info
          roster += this.cliOrchestrator.modelResolver.getRosterModelInfo();
          roster += '\n';

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
          roster += "- `context_id` + `resume: true` + new content continues the conversation and re-runs agents\n";
          roster += "- Prior conversation is injected into CLI agent context\n";
          roster += "- Do not set `resume` when reading another page of cached output\n";
          roster += "- Example: `roast(domain: 'codebase', target: '.', context_id: 'abc123', resume: true, context: 'Follow up on issue 3')`\n\n";
          roster += "**Cache TTL:** 2 hours\n\n";

          // Add MCP server info
          const mcpServerNames = listRegisteredServers();
          if (mcpServerNames.length > 0) {
            roster += "## MCP Server Integration\n";
            roster += "CLI agents can use external MCP tools for evidence-backed analysis.\n";
            roster += `**Available servers:** ${mcpServerNames.join(', ')}\n`;
            roster += "- Example: `roast(domain: 'security', target: '.', mcp_servers: ['playwright'])`\n";
            roster += "- Agents remain read-only — MCP enables observation and interaction, not code modification\n\n";
          }

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
          text: `ERROR: Unknown domain "${args.domain}". Valid domains: codebase, file_structure, dependencies, git_history, test_coverage, idea, architecture, research, security, product, infrastructure, design, legal`
        }]
      };
    }

    // Auto-enable Playwright for design domain — visual evaluation should be
    // the default, not an opt-in afterthought critics never discover
    if (args.domain === 'design') {
      const mcpServers = Array.isArray(args.mcp_servers) ? [...args.mcp_servers] as string[] : [] as string[];
      if (!mcpServers.includes('playwright')) {
        mcpServers.push('playwright');
      }
      args.mcp_servers = mcpServers;
    }

    // Generate tool config from domain
    const toolConfig = generateToolConfig(domain);

    // Map 'target' to the appropriate primary arg field
    const mappedArgs: Record<string, unknown> = { ...args };
    delete mappedArgs.domain;
    delete mappedArgs.target;

    // Set the primary argument based on domain's input type
    mappedArgs.targetPath = args.target;
    if (domain.inputType !== 'filesystem') {
      // For abstract domains, context is the primary content input
      mappedArgs.content = args.context || '';
    }

    // Delegate to the unified handler
    return this.toolHandler.handleRoastTool(toolConfig, mappedArgs, extra);
  }

  // -------------------------------------------------------------------------
  // Delegating wrappers — tests access these via (server as any).methodName()
  // -------------------------------------------------------------------------

  /**
   * Thin delegation to DebateOrchestrator.handleDebateToolExecution().
   * Preserved as a method on BrutalistServer so that existing tests using
   * `(server as any).handleDebateToolExecution(...)` continue to work.
   */
  private async handleDebateToolExecution(args: any, extra?: any): Promise<any> {
    return this.debateOrchestrator.handleDebateToolExecution(args, extra);
  }

  /**
   * Thin delegation to DebateOrchestrator.executeCLIDebate().
   * Preserved as a method on BrutalistServer so that existing tests using
   * `(server as any).executeCLIDebate(...)` continue to work.
   */
  private async executeCLIDebate(args: any): Promise<any> {
    return this.debateOrchestrator.executeCLIDebate(args);
  }
}
