import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MetricsRegistry } from './metrics/index.js';
import { BrutalistServerConfig } from './types/brutalist.js';
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
export declare class BrutalistServer {
    server: McpServer;
    config: BrutalistServerConfig;
    private _cliOrchestrator;
    private responseCache;
    private formatter;
    private toolHandler;
    private debateOrchestrator;
    private httpTransport?;
    /**
     * Observability: a single MetricsRegistry per BrutalistServer instance
     * (not a module-level singleton — two BrutalistServers produce two
     * independent registries, which keeps tests deterministic). Shared
     * with DebateOrchestrator and CLIAgentOrchestrator; consumed by the
     * streaming fan-out at handleStreamingEvent.
     */
    protected readonly metrics: MetricsRegistry;
    /**
     * Per-subsystem scoped loggers bound at construction time. The module
     * label is fixed at construction; sub-call sites narrow the operation
     * label via `.forOperation(...)`. Bindings:
     *   - cliLog       → module='cli-orchestrator', operation='spawn'
     *   - streamingLog → module='streaming',        operation='dispatch'
     * The debate scoped log is constructed inline at the DebateOrchestrator
     * call site below (module='debate', operation='orchestrate').
     */
    private readonly cliLog;
    private readonly streamingLog;
    private get cliOrchestrator();
    private set cliOrchestrator(value);
    private activeSessions;
    private readonly MAX_SESSIONS;
    private readonly SESSION_TTL_MS;
    private sessionCleanupTimer?;
    constructor(config?: BrutalistServerConfig);
    start(): Promise<void>;
    private startStdioServer;
    private startHttpServer;
    getActualPort(): number | undefined;
    stop(): Promise<void>;
    /**
     * Clean up stale sessions that exceed TTL
     */
    private cleanupStaleSessions;
    /**
     * Ensure session capacity doesn't exceed MAX_SESSIONS
     * Evicts oldest sessions when capacity is reached
     */
    ensureSessionCapacity(): void;
    cleanup(): Promise<void>;
    /**
     * Handle streaming events from CLI agents
     */
    private handleStreamingEvent;
    /**
     * Handle progress updates from CLI agents
     */
    private handleProgressUpdate;
    /**
     * Register all MCP tools
     *
     * TOOL REDUCTION STRATEGY: Only expose 4 gateway tools instead of 15.
     * The unified `roast` tool with domain parameter replaces all 11 roast_* tools.
     * This reduces cognitive load for AI agents while maintaining full functionality.
     */
    private registerTools;
    /**
     * Register special tools (debate, roster, unified roast)
     */
    private registerSpecialTools;
    /**
     * Handle unified roast tool - routes to appropriate domain handler
     */
    private handleUnifiedRoast;
    /**
     * Thin delegation to DebateOrchestrator.handleDebateToolExecution().
     * Preserved as a method on BrutalistServer so that existing tests using
     * `(server as any).handleDebateToolExecution(...)` continue to work.
     */
    private handleDebateToolExecution;
    /**
     * Thin delegation to DebateOrchestrator.executeCLIDebate().
     * Preserved as a method on BrutalistServer so that existing tests using
     * `(server as any).executeCLIDebate(...)` continue to work.
     */
    private executeCLIDebate;
}
//# sourceMappingURL=brutalist-server.d.ts.map