/**
 * DebateOrchestrator — debate orchestration extracted from brutalist-server.ts.
 *
 * This module encapsulates the entire debate subsystem:
 *   - handleDebateToolExecution(): cache-aware entry point for debate tool calls
 *   - executeCLIDebate(): core debate engine with 3-tier escalation
 *
 * Dependencies are injected via constructor, making brutalist-server.ts a pure
 * composition root that wires and delegates.
 *
 * Extracted from brutalist-server.ts lines 665-1348.
 */
import type { StructuredLogger } from '../logger.js';
import type { ResponseCache } from '../utils/response-cache.js';
import type { ResponseFormatter } from '../formatting/response-formatter.js';
import type { CLIAgentOrchestrator, StreamingEvent } from '../cli-agents.js';
import type { MetricsRegistry } from '../metrics/index.js';
import type { BrutalistResponse, BrutalistServerConfig } from '../types/brutalist.js';
export type { DebateTier } from './constitutional.js';
/** Dependencies injected into DebateOrchestrator at construction time. */
export interface DebateOrchestratorDeps {
    cliOrchestrator: CLIAgentOrchestrator;
    responseCache: ResponseCache;
    formatter: ResponseFormatter;
    config: BrutalistServerConfig;
    onStreamingEvent: (event: StreamingEvent) => void;
    onProgressUpdate: (progressToken: string | number, progress: number, total: number | undefined, message: string, sessionId?: string) => void;
    /**
     * Shared metrics registry for debate orchestration instrumentation.
     * Required: the composition root constructs a single registry per
     * BrutalistServer instance and passes it to every module that records
     * metrics. Tests construct a fresh registry via `createMetricsRegistry()`.
     */
    metrics: MetricsRegistry;
    /**
     * Scoped structured logger bound with `module='debate'`. Required: the
     * composition root binds `logger.for({ module: 'debate', operation:
     * 'orchestrate' })` once and passes it in. Call sites inside this
     * module narrow per-operation via `this.log.forOperation('...')`.
     * Typed as the interface (not the concrete `Logger` class) so tests
     * can inject stubs without subclassing.
     */
    log: StructuredLogger;
}
/** Arguments for handleDebateToolExecution (matches the tool schema). */
export interface DebateToolArgs {
    topic: string;
    proPosition: string;
    conPosition: string;
    target?: string;
    agents?: ('claude' | 'codex' | 'agy')[];
    rounds?: number;
    context?: string;
    workingDirectory?: string;
    models?: {
        claude?: string;
        codex?: string;
    };
    context_id?: string;
    resume?: boolean;
    offset?: number;
    limit?: number;
    cursor?: string;
    force_refresh?: boolean;
    verbose?: boolean;
    mcp_servers?: string[];
}
/** Internal arguments for executeCLIDebate (includes streaming callbacks). */
interface ExecuteDebateArgs {
    topic: string;
    proPosition: string;
    conPosition: string;
    target?: string;
    agents?: ('claude' | 'codex' | 'agy')[];
    rounds: number;
    context?: string;
    workingDirectory?: string;
    models?: {
        claude?: string;
        codex?: string;
    };
    onStreamingEvent?: (event: StreamingEvent) => void;
    progressToken?: string | number;
    onProgress?: (progress: number, total: number | undefined, message: string) => void;
    sessionId?: string;
    mcp_servers?: string[];
}
/**
 * DebateOrchestrator encapsulates all debate orchestration logic.
 *
 * It accepts dependencies via constructor injection so that brutalist-server.ts
 * remains a thin composition root.
 */
export declare class DebateOrchestrator {
    /** Mutable so test harnesses can replace cliOrchestrator on BrutalistServer. */
    private _cliOrchestrator;
    private readonly responseCache;
    private readonly formatter;
    private readonly config;
    private readonly onStreamingEvent;
    private readonly onProgressUpdate;
    private readonly metrics;
    private readonly log;
    get cliOrchestrator(): CLIAgentOrchestrator;
    set cliOrchestrator(value: CLIAgentOrchestrator);
    constructor(deps: DebateOrchestratorDeps);
    /**
     * Isolate metric writes from business control flow.
     *
     * Delegates to the shared `safeMetric` helper in
     * `src/metrics/safe-metric.ts`. The private method is retained so
     * existing call sites inside DebateOrchestrator
     * (`this.safeMetric(op, fn)`) keep working without a touch, and so
     * any debate-specific metric-error instrumentation can be layered in
     * one place in the future.
     *
     * Parity note: `CLIAgentOrchestrator` uses the same shared helper
     * directly (no private method) to prevent metric throws from
     * propagating into the outer spawn try/catch. See Cycle 3 rework
     * Task CLI-B' in phases/instrument_cli_spawn/phase.md.
     */
    private safeMetric;
    /**
     * Handle debate tool execution with constitutional position anchoring.
     * Uses 2 randomly selected agents (or user-specified) with explicit PRO/CON positions.
     *
     * This is the entry point called from the roast_cli_debate tool registration.
     *
     * Instrumentation (intent #1): every exit path records the debate
     * orchestration duration histogram exactly once. The `tier` label is the
     * MAX tier reached across all turns of the underlying `executeCLIDebate`
     * call; cache-hit paths short-circuit before any CLI agent runs, so their
     * tier is always `'standard'`. The outer try/finally placement ensures
     * error paths, refusal paths, and cache-hit paths all emit exactly one
     * observation — `executeCLIDebate` itself has NO timer block to avoid
     * double-observation.
     */
    handleDebateToolExecution(args: DebateToolArgs, extra?: any): Promise<any>;
    /**
     * Execute CLI debate with constitutional position anchoring.
     * 2 agents, explicit PRO/CON positions, context compression between rounds.
     *
     * This is the core debate engine. It manages:
     *   - Agent selection and position assignment
     *   - Round execution with 3-tier refusal escalation
     *   - Transcript mediation between rounds
     *   - Behavioral metadata and asymmetry detection
     *   - Synthesis generation
     */
    executeCLIDebate(args: ExecuteDebateArgs): Promise<BrutalistResponse>;
}
//# sourceMappingURL=debate-orchestrator.d.ts.map