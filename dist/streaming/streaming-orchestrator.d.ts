/**
 * @module streaming-orchestrator
 * @deprecated NOT INTEGRATED -- This module is built but not wired into the
 * production streaming path. The canonical streaming path uses direct callbacks
 * (onStreamingEvent / onProgressUpdate) routed through
 * brutalist-server.ts#handleStreamingEvent, which dispatches via MCP
 * notifications (HTTP) or sendLoggingMessage (stdio). This orchestrator,
 * along with its dependencies (SessionManager, EnhancedSSETransport,
 * ProgressTracker, CircuitBreaker), is retained for possible future
 * integration. See src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { EventEmitter } from 'events';
import { CLIAgentOptions } from '../cli-agents.js';
import { CLIAgentResponse } from '../types/brutalist.js';
import { CircuitBreakerConfig } from './circuit-breaker.js';
/**
 * Enhanced streaming CLI execution options
 */
export interface StreamingExecutionOptions extends CLIAgentOptions {
    enableProgress?: boolean;
    enableCircuitBreaker?: boolean;
    fallbackResponse?: any;
    cacheResponses?: boolean;
    streamingTimeout?: number;
    bufferConfig?: {
        maxBatchSize?: number;
        throttleDelay?: number;
        priorityRules?: Record<string, any>;
    };
}
/**
 * Streaming execution result with enhanced metadata
 */
export interface StreamingExecutionResult {
    success: boolean;
    responses: CLIAgentResponse[];
    sessionId: string;
    analysis: {
        startTime: number;
        endTime: number;
        duration: number;
        eventsEmitted: number;
        progressMilestones: number;
        circuitBreakerTrips: number;
        fallbacksUsed: number;
    };
    streaming: {
        connectedClients: number;
        eventsSent: number;
        averageLatency: number;
        bufferHits: number;
    };
    errors?: string[];
}
/**
 * Streaming orchestrator configuration
 */
export interface StreamingOrchestratorConfig {
    maxConcurrentAnalyses: number;
    defaultTimeout: number;
    circuitBreakerConfig: CircuitBreakerConfig;
    enableMetrics: boolean;
    cleanupInterval: number;
}
/**
 * Advanced streaming CLI orchestrator with comprehensive real-time capabilities.
 *
 * Integrates all streaming components:
 * - Real-time output parsing with semantic boundaries
 * - Intelligent buffering with adaptive throttling
 * - Session management with lifecycle tracking
 * - SSE transport with session isolation
 * - Progress tracking with milestone detection
 * - Circuit breaker with fallback strategies
 * - Comprehensive monitoring and analytics
 *
 * @deprecated NOT INTEGRATED -- retained for possible future use. The canonical
 * streaming path bypasses this class entirely. See STREAMING_ARCHITECTURE.md.
 */
export declare class StreamingCLIOrchestrator extends EventEmitter {
    private cliOrchestrator;
    private sessionManager;
    private sseTransport;
    private circuitBreakers;
    private responseCache;
    private activeAnalyses;
    private config;
    private metrics;
    private cleanupTimer?;
    constructor(config?: Partial<StreamingOrchestratorConfig>);
    /**
     * Execute CLI analysis with full streaming capabilities
     */
    executeWithStreaming(analysisType: string, cliAgents: string[], systemPrompt: string, userPrompt: string, options?: StreamingExecutionOptions): Promise<StreamingExecutionResult>;
    /**
     * Create streaming event handler for session
     */
    private createStreamingEventHandler;
    /**
     * Execute CLI agents with circuit breaker protection
     */
    private executeWithCircuitBreaker;
    /**
     * Setup event handlers for internal components
     */
    private setupEventHandlers;
    /**
     * Setup circuit breakers for each CLI agent
     */
    private setupCircuitBreakers;
    /**
     * Update average analysis duration metric
     */
    private updateAverageAnalysisDuration;
    /**
     * Start cleanup timer for stale sessions and cache
     */
    private startCleanupTimer;
    /**
     * Perform periodic cleanup
     */
    private performCleanup;
    /**
     * Get orchestrator statistics
     */
    getStats(): {
        metrics: {
            totalAnalyses: number;
            successfulAnalyses: number;
            failedAnalyses: number;
            totalEventsSent: number;
            totalCircuitBreakerTrips: number;
            totalFallbacksUsed: number;
            averageAnalysisDuration: number;
        };
        activeAnalyses: number;
        sessionManager: import("./session-manager.js").SessionManagerStats;
        sseTransport: {
            totalConnections: number;
            activeConnections: number;
            sessionDistribution: Record<string, number>;
            averageEventsPerConnection: number;
        };
        circuitBreakers: Record<string, any>;
    };
    /**
     * Get active session IDs
     */
    getActiveSessions(): string[];
    /**
     * Force disconnect session
     */
    disconnectSession(sessionId: string, reason?: string): void;
    /**
     * Reset circuit breaker for specific agent
     */
    resetCircuitBreaker(agent: string): void;
    /**
     * Add response to cache for fallback strategies
     */
    cacheResponse(key: string, response: any): void;
    /**
     * Shutdown orchestrator and cleanup resources
     */
    shutdown(): void;
}
//# sourceMappingURL=streaming-orchestrator.d.ts.map