/**
 * @module session-manager
 * @deprecated NOT INTEGRATED -- This module provides multi-session event
 * routing for the unintegrated StreamingCLIOrchestrator and
 * EnhancedSSETransport. The canonical streaming path manages sessions via
 * activeSessions in brutalist-server.ts (a simple Map<string, SessionInfo>).
 * Retained for possible future integration. See
 * src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { EventEmitter } from 'events';
import { StreamingEvent } from '../cli-agents.js';
import { IntelligentBuffer, EventBatch } from './intelligent-buffer.js';
/**
 * Session manager statistics
 */
export interface SessionManagerStats {
    activeSessions: number;
    totalEvents: number;
    memoryUsage: number;
    totalSubscribers: number;
    uptime: number;
}
/**
 * Session state tracking for analysis
 */
export interface AnalysisState {
    status: 'starting' | 'running' | 'paused' | 'complete' | 'failed';
    activeAgents: Set<string>;
    completedAgents: Set<string>;
    failedAgents: Set<string>;
    findings: StreamingEvent[];
    startTime: number;
    endTime?: number;
    progress: {
        totalPhases: number;
        currentPhase: number;
        phaseName: string;
        phaseProgress: number;
    };
    metrics: {
        totalEvents: number;
        findingsCount: number;
        errorsCount: number;
        avgResponseTime: number;
    };
}
/**
 * Session context with full lifecycle management
 */
export interface SessionContext {
    id: string;
    startTime: number;
    lastActivity: number;
    subscribers: Set<StreamingSubscriber>;
    eventBuffer: IntelligentBuffer;
    metadata: Record<string, any>;
    analysis: AnalysisState;
    connectionCount: number;
    maxConnections: number;
    resources: {
        memoryUsage: number;
        eventCount: number;
        connectionTime: number;
    };
    cleanup?: {
        ttl: number;
        scheduled: boolean;
        timer?: NodeJS.Timeout;
    };
}
/**
 * Streaming subscriber interface
 */
export interface StreamingSubscriber {
    id: string;
    sessionId: string;
    type: 'sse' | 'websocket' | 'polling';
    emit(event: StreamingEvent): Promise<void>;
    emitBatch(batch: EventBatch): Promise<void>;
    close(): void;
    isConnected(): boolean;
    getConnectionInfo(): {
        connectedAt: number;
        lastActivity: number;
        eventsDelivered: number;
        errorsCount: number;
    };
}
/**
 * Session lifecycle events
 */
export interface SessionEvents {
    'session:created': (context: SessionContext) => void;
    'session:destroyed': (sessionId: string) => void;
    'session:activity': (sessionId: string, activity: string) => void;
    'session:error': (sessionId: string, error: Error) => void;
    'subscriber:connected': (sessionId: string, subscriber: StreamingSubscriber) => void;
    'subscriber:disconnected': (sessionId: string, subscriberId: string) => void;
    'analysis:started': (sessionId: string, agents: string[]) => void;
    'analysis:progress': (sessionId: string, progress: AnalysisState['progress']) => void;
    'analysis:completed': (sessionId: string, results: AnalysisState) => void;
    'analysis:failed': (sessionId: string, error: Error) => void;
}
/**
 * Session configuration options
 */
export interface SessionConfig {
    ttl?: number;
    maxConnections?: number;
    maxMemoryMB?: number;
    maxEvents?: number;
    autoCleanup?: boolean;
    bufferConfig?: {
        enableCoalescence: boolean;
        adaptiveThrottling: boolean;
        backpressureThreshold: number;
    };
}
/**
 * Session channel manager with comprehensive lifecycle management.
 *
 * Features:
 * - Session isolation with secure access control
 * - Automatic resource cleanup and garbage collection
 * - Connection pooling and limits
 * - Real-time monitoring and metrics
 * - Event buffering and delivery guarantees
 * - Analysis state tracking
 * - Graceful error handling and recovery
 *
 * @deprecated NOT INTEGRATED -- The canonical streaming path manages sessions
 * via a simple Map in brutalist-server.ts. This class is used only by the
 * unintegrated EnhancedSSETransport and StreamingCLIOrchestrator.
 */
export declare class SessionChannelManager extends EventEmitter {
    private sessions;
    private cleanupTimers;
    private globalBuffer;
    private startTime;
    private readonly config;
    private readonly DEFAULT_CONFIG;
    private metrics;
    constructor(config?: SessionConfig);
    /**
     * Create new session with full context
     */
    createSession(sessionId?: string, metadata?: Record<string, any>): SessionContext;
    /**
     * Get session context with access validation
     */
    getSession(sessionId: string, requireActive?: boolean): SessionContext | null;
    /**
     * Subscribe to session events with connection management
     */
    subscribe(sessionId: string, subscriber: StreamingSubscriber): Promise<boolean>;
    /**
     * Unsubscribe from session events
     */
    unsubscribe(sessionId: string, subscriberId: string): boolean;
    /**
     * Emit event to session with intelligent buffering
     */
    emitToSession(sessionId: string, event: StreamingEvent): Promise<void>;
    /**
     * Start analysis tracking for session
     */
    startAnalysis(sessionId: string, agents: string[]): boolean;
    /**
     * Complete analysis for session
     */
    completeAnalysis(sessionId: string): boolean;
    /**
     * Fail analysis for session
     */
    failAnalysis(sessionId: string, error: Error): boolean;
    /**
     * Destroy session and cleanup resources
     */
    destroySession(sessionId: string): boolean;
    /**
     * Get all active sessions
     */
    getActiveSessions(): SessionContext[];
    /**
     * Get session statistics
     */
    /**
     * Get global system metrics
     */
    getGlobalMetrics(): any;
    /**
     * Check if session exists
     */
    hasSession(sessionId: string): boolean;
    /**
     * Get session statistics
     */
    getSessionStats(sessionId: string): {
        eventsEmitted: number;
        bufferStats: {
            flushCount: number;
        };
    } | null;
    /**
     * End analysis for session
     */
    endAnalysis(sessionId: string): boolean;
    /**
     * Complete session (alias for endAnalysis)
     */
    completeSession(sessionId: string): boolean;
    /**
     * Get global statistics
     */
    getGlobalStats(): SessionManagerStats;
    /**
     * Shutdown session manager
     */
    shutdown(): void;
    /**
     * Cleanup all resources
     */
    destroy(): void;
    /**
     * Update analysis state based on events
     */
    private updateAnalysisState;
    /**
     * Schedule session cleanup
     */
    private scheduleCleanup;
    /**
     * Setup global event handlers
     */
    private setupEventHandlers;
    /**
     * Deliver event batch to session subscribers
     */
    private deliverBatch;
    /**
     * Start periodic maintenance tasks
     */
    private startMaintenance;
    /**
     * Update internal metrics
     */
    private updateMetrics;
}
export declare const SessionManager: typeof SessionChannelManager;
export type SessionManager = SessionChannelManager;
//# sourceMappingURL=session-manager.d.ts.map