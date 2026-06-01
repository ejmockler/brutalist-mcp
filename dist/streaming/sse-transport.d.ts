/**
 * @module sse-transport
 * @deprecated NOT INTEGRATED -- This module provides a custom SSE transport
 * with session isolation for the unintegrated StreamingCLIOrchestrator. The
 * canonical HTTP transport uses StreamableHTTPServerTransport from the MCP SDK
 * (see src/transport/http-transport.ts). Retained for possible future
 * integration. See src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { SessionManager } from './session-manager.js';
/**
 * SSE connection metadata for tracking active streams
 */
export interface SSEConnection {
    id: string;
    sessionId: string;
    response: Response;
    clientOrigin: string;
    connectedAt: number;
    lastActivity: number;
    eventsSent: number;
    isActive: boolean;
}
/**
 * Enhanced Server-Sent Events transport with session isolation.
 *
 * Features:
 * - Session-scoped connections with isolation guarantees
 * - Connection pooling with resource limits
 * - Heartbeat monitoring and automatic cleanup
 * - Graceful connection management
 * - Event filtering and routing by session
 * - Memory-efficient streaming with backpressure
 *
 * @deprecated NOT INTEGRATED -- The canonical HTTP transport uses
 * StreamableHTTPServerTransport from the MCP SDK (src/transport/http-transport.ts).
 */
export declare class EnhancedSSETransport extends EventEmitter {
    private connections;
    private sessionManager;
    private heartbeatInterval;
    private readonly MAX_CONNECTIONS;
    private readonly HEARTBEAT_INTERVAL;
    private readonly CONNECTION_TIMEOUT;
    private readonly MAX_EVENTS_PER_CONNECTION;
    constructor(sessionManager: SessionManager);
    /**
     * Establish SSE connection for a session
     */
    connect(req: Request, res: Response, sessionId: string): Promise<void>;
    /**
     * Handle streaming events from session manager
     */
    private handleSessionEvent;
    /**
     * Handle session completion
     */
    private handleSessionComplete;
    /**
     * Send streaming event to specific connection
     */
    private sendStreamingEvent;
    /**
     * Send buffered events for a newly connected session
     */
    private sendBufferedEvents;
    /**
     * Send raw SSE event
     */
    private sendEvent;
    /**
     * Disconnect and cleanup SSE connection
     */
    private disconnect;
    /**
     * Start heartbeat monitoring
     */
    private startHeartbeat;
    /**
     * Check connection health and cleanup stale connections
     */
    private checkConnectionHealth;
    /**
     * Get connection statistics
     */
    getStats(): {
        totalConnections: number;
        activeConnections: number;
        sessionDistribution: Record<string, number>;
        averageEventsPerConnection: number;
    };
    /**
     * Force disconnect all connections for a session
     */
    disconnectSession(sessionId: string, reason?: string): void;
    /**
     * Cleanup and shutdown transport
     */
    shutdown(): void;
    /**
     * Get active connection for session (for testing)
     */
    getSessionConnections(sessionId: string): SSEConnection[];
}
//# sourceMappingURL=sse-transport.d.ts.map