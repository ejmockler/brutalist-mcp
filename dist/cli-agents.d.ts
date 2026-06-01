import type { StructuredLogger } from './logger.js';
import { CLIAgentResponse } from './types/brutalist.js';
import { ModelResolver } from './model-resolver.js';
import type { MetricsRegistry } from './metrics/index.js';
export type BrutalistPromptType = 'code' | 'codebase' | 'architecture' | 'idea' | 'research' | 'data' | 'security' | 'product' | 'infrastructure' | 'debate' | 'dependencies' | 'fileStructure' | 'gitHistory' | 'testCoverage' | 'design' | 'legal';
export declare const CLAUDE_ALIASES: readonly ["opus", "sonnet", "haiku"];
export interface CLIAgentOptions {
    workingDirectory?: string;
    timeout?: number;
    clis?: ('claude' | 'codex' | 'agy')[];
    analysisType?: BrutalistPromptType;
    models?: {
        claude?: string;
        codex?: string;
        agy?: string;
    };
    onStreamingEvent?: (event: StreamingEvent) => void;
    progressToken?: string | number;
    onProgress?: (progress: number, total: number | undefined, message: string) => void;
    sessionId?: string;
    requestId?: string;
    debateMode?: boolean;
    mcpServers?: string[];
    /**
     * Optional scoped logger threaded into provider.buildCommand / decodeOutput.
     * When present, adapters emit via this logger (narrowed with forOperation)
     * instead of the root logger import. Absent → fall back to root logger.
     * Pattern A per phase.md: preserves stateless adapter singletons in
     * cli-adapters/index.ts.
     */
    log?: StructuredLogger;
}
/**
 * Constructor-deps bag for CLIAgentOrchestrator.
 *
 * All fields optional — characterization tests construct
 * `new CLIAgentOrchestrator()` with no args. In production the
 * composition root passes the full set; in tests, instrumentation is a
 * no-op and `this.log` falls back to the root logger via emitLog().
 */
export interface CLIAgentOrchestratorDeps {
    modelResolver?: ModelResolver;
    metrics?: MetricsRegistry;
    log?: StructuredLogger;
}
export interface StreamingEvent {
    type: 'agent_start' | 'agent_progress' | 'agent_complete' | 'agent_error';
    agent: 'claude' | 'codex' | 'agy' | 'system';
    content?: string;
    timestamp: number;
    sessionId?: string;
    metadata?: Record<string, any>;
}
export interface CLIContext {
    availableCLIs: ('claude' | 'codex' | 'agy')[];
}
export declare class CLIAgentOrchestrator {
    private defaultTimeout;
    private defaultWorkingDir;
    private cliContext;
    private cliContextCached;
    private cliContextCacheTime;
    private readonly CLI_CACHE_TTL;
    private runningCLIs;
    private readonly MAX_CONCURRENT_CLIS;
    readonly modelResolver: ModelResolver;
    private readonly metrics?;
    private readonly log?;
    private streamingBuffers;
    private readonly STREAMING_FLUSH_INTERVAL;
    private readonly MAX_CHUNK_SIZE;
    private readonly HEARTBEAT_INTERVAL;
    private lastHeartbeat;
    /**
     * Accepts a deps bag OR a bare `ModelResolver` (legacy positional form)
     * OR nothing (characterization-test harnesses). The `instanceof ModelResolver`
     * branch preserves the pre-observability signature.
     */
    constructor(deps?: CLIAgentOrchestratorDeps | ModelResolver);
    /**
     * Return the injected scoped logger if present, otherwise the root
     * logger singleton. Keeps un-injected (test) instances working while
     * scoping production emissions with `module='cli-orchestrator'`.
     */
    private emitLog;
    /**
     * Heuristic for classifying a spawnAsync error as a timeout.
     * Centralized so all outcome paths share the same detection logic.
     *
     * Matches any of:
     *   - execError.code === 'ETIMEDOUT' (Node's timeout code on some paths)
     *   - execError.killed === true (child_process kill after SIGTERM/SIGKILL
     *     escalation when the timeout timer fired — see spawnAsync timer block)
     *   - execError.message matching /timed out|timeout/i (spawnAsync rejects
     *     with "Command timed out after ..." on timer expiry)
     */
    private isTimeoutError;
    private parseNDJSON;
    private decodeClaudeStreamJson;
    private extractCodexAgentMessage;
    private emitThrottledStreamingEvent;
    private buildCLICommand;
    detectCLIContext(): Promise<CLIContext>;
    selectSingleCLI(preferredCLI?: 'claude' | 'codex' | 'agy', analysisType?: BrutalistPromptType): 'claude' | 'codex' | 'agy';
    private _executeCLI;
    executeClaudeCode(userPrompt: string, systemPromptSpec: string, options?: CLIAgentOptions): Promise<CLIAgentResponse>;
    executeCodex(userPrompt: string, systemPromptSpec: string, options?: CLIAgentOptions): Promise<CLIAgentResponse>;
    executeSingleCLI(cli: 'claude' | 'codex' | 'agy', userPrompt: string, systemPromptSpec: string, options?: CLIAgentOptions): Promise<CLIAgentResponse>;
    private waitForAvailableSlot;
    executeCLIAgents(cliAgents: string[], systemPrompt: string, userPrompt: string, options?: CLIAgentOptions): Promise<CLIAgentResponse[]>;
    executeCLIAgent(agent: string, systemPrompt: string, userPrompt: string, options?: CLIAgentOptions): Promise<CLIAgentResponse>;
    executeBrutalistAnalysis(analysisType: BrutalistPromptType, primaryContent: string, systemPromptSpec: string, context?: string, options?: CLIAgentOptions): Promise<CLIAgentResponse[]>;
    synthesizeBrutalistFeedback(responses: CLIAgentResponse[], analysisType: string): string;
    private constructUserPrompt;
}
//# sourceMappingURL=cli-agents.d.ts.map