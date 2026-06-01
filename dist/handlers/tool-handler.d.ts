import { CLIAgentOrchestrator } from '../cli-agents.js';
import { ToolConfig } from '../types/tool-config.js';
import { BrutalistServerConfig } from '../types/brutalist.js';
import { ResponseCache } from '../utils/response-cache.js';
import { ResponseFormatter } from '../formatting/response-formatter.js';
/**
 * ToolHandler - Handles roast tool execution with caching and pagination
 * Extracted from BrutalistServer to follow Single Responsibility Principle
 */
export declare class ToolHandler {
    private cliOrchestrator;
    private responseCache;
    private formatter;
    private config;
    private activeSessions;
    private handleStreamingEvent;
    private handleProgressUpdate;
    private ensureSessionCapacity;
    constructor(cliOrchestrator: CLIAgentOrchestrator, responseCache: ResponseCache, formatter: ResponseFormatter, config: BrutalistServerConfig, activeSessions: Map<string, {
        startTime: number;
        requestCount: number;
        lastActivity: number;
    }>, handleStreamingEvent: (event: any) => void, handleProgressUpdate: (progressToken: string | number, progress: number, total: number | undefined, message: string, sessionId?: string) => void, ensureSessionCapacity: () => void);
    /**
     * Unified handler for all roast tools - DRY principle
     */
    handleRoastTool(config: ToolConfig, args: any, extra: any): Promise<any>;
    /**
     * Execute brutalist analysis with CLI orchestrator
     */
    private executeBrutalistAnalysis;
}
//# sourceMappingURL=tool-handler.d.ts.map