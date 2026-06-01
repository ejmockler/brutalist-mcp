/**
 * @module intelligent-buffer
 * @deprecated NOT INTEGRATED -- This module provides priority-based event
 * buffering for the unintegrated StreamingCLIOrchestrator. The canonical
 * streaming path uses direct callbacks with simple throttling in
 * cli-agents.ts#emitThrottledStreamingEvent. Retained for possible future
 * integration. See src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { StreamingEvent } from '../cli-agents.js';
/**
 * Priority level for events
 */
export type EventPriority = 'immediate' | 'high' | 'normal' | 'low';
/**
 * Buffer state for monitoring and metrics
 */
interface BufferState {
    sessionId: string;
    totalEvents: number;
    pendingEvents: number;
    lastFlush: number;
    flushCount: number;
    backpressure: boolean;
    memoryUsage: number;
}
/**
 * Event batch for delivery
 */
export interface EventBatch {
    sessionId: string;
    events: StreamingEvent[];
    priority: EventPriority;
    batchId: string;
    createdAt: number;
}
/**
 * Intelligent buffering system with adaptive throttling and content-aware batching.
 *
 * Features:
 * - Priority-based queuing with immediate delivery for critical events
 * - Adaptive throttling based on content type and system load
 * - Content coalescence to reduce noise
 * - Memory-bounded circular buffers
 * - Backpressure handling
 * - Real-time metrics and monitoring
 *
 * @deprecated NOT INTEGRATED -- The canonical streaming path uses simple
 * throttling in cli-agents.ts#emitThrottledStreamingEvent. This buffer is
 * used only by the unintegrated SessionChannelManager.
 */
export declare class IntelligentBuffer {
    private buffers;
    private flushTimers;
    private states;
    private backlog;
    private readonly BUFFERING_RULES;
    private readonly DEFAULT_RULE;
    private readonly MAX_BUFFER_SIZE;
    private readonly MAX_MEMORY_MB;
    private readonly BACKLOG_SIZE;
    constructor();
    /**
     * Add event to buffer with intelligent routing
     */
    add(event: StreamingEvent): void;
    /**
     * Force flush of all pending events for a session
     */
    flush(sessionId: string, priority?: EventPriority): EventBatch | null;
    /**
     * Get backlog events for late subscribers
     */
    getBacklog(sessionId: string, limit?: number): StreamingEvent[];
    /**
     * Get buffer state for monitoring
     */
    getState(sessionId: string): BufferState | null;
    /**
     * Get all active sessions
     */
    getActiveSessions(): string[];
    /**
     * Cleanup session resources
     */
    cleanup(sessionId: string): void;
    /**
     * Get total memory usage across all sessions
     */
    getTotalMemoryUsage(): number;
    /**
     * Get system-wide metrics
     */
    getMetrics(): {
        activeSessions: number;
        totalEvents: number;
        totalMemoryMB: number;
        backpressureSessions: number;
    };
    /**
     * Classify event for buffering rules
     */
    private classifyEvent;
    /**
     * Get event priority for backpressure handling
     */
    private getEventPriority;
    /**
     * Schedule flush based on buffering rule
     */
    private scheduleFlush;
    /**
     * Apply content coalescence to reduce noise
     */
    private applyCoalescence;
    /**
     * Generate coalescence key for grouping similar events
     */
    private getCoalescenceKey;
    /**
     * Merge similar events into single event
     */
    private mergeEvents;
    /**
     * Get or create buffer for session
     */
    private getOrCreateBuffer;
    /**
     * Get or create buffer state
     */
    private getOrCreateState;
    /**
     * Add event to backlog for late subscribers
     */
    private addToBacklog;
    /**
     * Estimate memory usage for session
     */
    private estimateMemoryUsage;
    /**
     * Handle memory pressure by dropping low priority events
     */
    private handleMemoryPressure;
    /**
     * Clean up stale sessions (no activity for > 1 hour)
     */
    private cleanupStaleSessions;
    /**
     * Deliver batch to subscribers (to be implemented by transport layer)
     */
    private deliverBatch;
}
export {};
//# sourceMappingURL=intelligent-buffer.d.ts.map