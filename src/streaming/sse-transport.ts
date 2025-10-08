import { EventEmitter } from 'events';
import { Request, Response } from 'express';
import { logger } from '../logger.js';
import { StreamingEvent } from '../cli-agents.js';
import { SessionManager, SessionContext } from './session-manager.js';

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
 * Enhanced Server-Sent Events transport with session isolation
 * 
 * Features:
 * - Session-scoped connections with isolation guarantees
 * - Connection pooling with resource limits
 * - Heartbeat monitoring and automatic cleanup
 * - Graceful connection management
 * - Event filtering and routing by session
 * - Memory-efficient streaming with backpressure
 */
export class EnhancedSSETransport extends EventEmitter {
  private connections = new Map<string, SSEConnection>();
  private sessionManager: SessionManager;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  
  // Configuration constants
  private readonly MAX_CONNECTIONS = 100;
  private readonly HEARTBEAT_INTERVAL = 30000; // 30 seconds
  private readonly CONNECTION_TIMEOUT = 300000; // 5 minutes
  private readonly MAX_EVENTS_PER_CONNECTION = 10000;
  
  constructor(sessionManager: SessionManager) {
    super();
    this.sessionManager = sessionManager;
    this.startHeartbeat();
    
    // Handle session events
    this.sessionManager.on('streamingEvent', this.handleSessionEvent.bind(this));
    this.sessionManager.on('sessionComplete', this.handleSessionComplete.bind(this));
  }
  
  /**
   * Establish SSE connection for a session
   */
  async connect(req: Request, res: Response, sessionId: string): Promise<void> {
    const connectionId = `${sessionId}-${Date.now()}`;
    const clientOrigin = req.headers.origin || 'unknown';
    
    // Validate session exists
    if (!this.sessionManager.hasSession(sessionId)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    
    // Check connection limits
    if (this.connections.size >= this.MAX_CONNECTIONS) {
      logger.warn(`🚫 SSE connection limit reached (${this.MAX_CONNECTIONS})`);
      res.status(503).json({ error: 'Connection limit reached' });
      return;
    }
    
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': clientOrigin,
      'Access-Control-Allow-Credentials': 'true'
    });
    
    // Send initial connection event
    this.sendEvent(res, {
      type: 'connection',
      data: {
        connectionId,
        sessionId,
        connectedAt: Date.now()
      }
    });
    
    // Create connection record
    const connection: SSEConnection = {
      id: connectionId,
      sessionId,
      response: res,
      clientOrigin,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      eventsSent: 0,
      isActive: true
    };
    
    this.connections.set(connectionId, connection);
    
    logger.info(`🔗 SSE connection established: ${connectionId} for session ${sessionId}`);
    
    // Handle client disconnect
    req.on('close', () => {
      this.disconnect(connectionId, 'client_disconnect');
    });
    
    req.on('error', (error) => {
      logger.error(`💥 SSE connection error for ${connectionId}:`, error);
      this.disconnect(connectionId, 'connection_error');
    });
    
    // Send buffered events for this session
    this.sendBufferedEvents(connection);
  }
  
  /**
   * Handle streaming events from session manager
   */
  private handleSessionEvent(event: StreamingEvent): void {
    if (!event.sessionId) {
      logger.warn('⚠️ Received streaming event without session ID');
      return;
    }
    
    // Find connections for this session
    const sessionConnections = Array.from(this.connections.values())
      .filter(conn => conn.sessionId === event.sessionId && conn.isActive);
    
    if (sessionConnections.length === 0) {
      logger.debug(`📭 No active SSE connections for session ${event.sessionId}`);
      return;
    }
    
    // Send event to all session connections
    for (const connection of sessionConnections) {
      this.sendStreamingEvent(connection, event);
    }
  }
  
  /**
   * Handle session completion
   */
  private handleSessionComplete(sessionId: string): void {
    logger.info(`🏁 Session ${sessionId} completed, closing SSE connections`);
    
    const sessionConnections = Array.from(this.connections.values())
      .filter(conn => conn.sessionId === sessionId);
    
    for (const connection of sessionConnections) {
      this.sendEvent(connection.response, {
        type: 'session_complete',
        data: {
          sessionId,
          completedAt: Date.now()
        }
      });
      
      this.disconnect(connection.id, 'session_complete');
    }
  }
  
  /**
   * Send streaming event to specific connection
   */
  private sendStreamingEvent(connection: SSEConnection, event: StreamingEvent): void {
    if (!connection.isActive) {
      return;
    }
    
    // Check event limit
    if (connection.eventsSent >= this.MAX_EVENTS_PER_CONNECTION) {
      logger.warn(`📊 Connection ${connection.id} reached event limit`);
      this.disconnect(connection.id, 'event_limit_reached');
      return;
    }
    
    try {
      this.sendEvent(connection.response, {
        type: 'streaming_event',
        data: event
      });
      
      connection.eventsSent++;
      connection.lastActivity = Date.now();
      
    } catch (error) {
      logger.error(`💥 Failed to send event to ${connection.id}:`, error);
      this.disconnect(connection.id, 'send_error');
    }
  }
  
  /**
   * Send buffered events for a newly connected session
   */
  private sendBufferedEvents(connection: SSEConnection): void {
    const sessionContext = this.sessionManager.getSession(connection.sessionId);
    if (!sessionContext) {
      return;
    }
    
    const bufferedEvents = sessionContext.eventBuffer.flush(connection.sessionId);
    
    if (bufferedEvents && bufferedEvents.events.length > 0) {
      logger.info(`📤 Sending ${bufferedEvents.events.length} buffered events to ${connection.id}`);
      
      for (const event of bufferedEvents.events) {
        this.sendStreamingEvent(connection, event);
      }
    }
  }
  
  /**
   * Send raw SSE event
   */
  private sendEvent(res: Response, event: { type: string; data: any }): void {
    const eventId = Date.now().toString();
    const eventData = JSON.stringify(event.data);
    
    res.write(`id: ${eventId}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${eventData}\n\n`);
  }
  
  /**
   * Disconnect and cleanup SSE connection
   */
  private disconnect(connectionId: string, reason: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }
    
    logger.info(`🔌 Disconnecting SSE ${connectionId}: ${reason}`);
    
    connection.isActive = false;
    
    try {
      if (!connection.response.destroyed) {
        this.sendEvent(connection.response, {
          type: 'disconnect',
          data: {
            reason,
            disconnectedAt: Date.now(),
            eventsSent: connection.eventsSent
          }
        });
        
        connection.response.end();
      }
    } catch (error) {
      logger.debug(`Failed to send disconnect event: ${error}`);
    }
    
    this.connections.delete(connectionId);
    
    this.emit('connectionClosed', {
      connectionId,
      sessionId: connection.sessionId,
      reason,
      duration: Date.now() - connection.connectedAt,
      eventsSent: connection.eventsSent
    });
  }
  
  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.checkConnectionHealth();
    }, this.HEARTBEAT_INTERVAL);
  }
  
  /**
   * Check connection health and cleanup stale connections
   */
  private checkConnectionHealth(): void {
    const now = Date.now();
    const staleConnections: string[] = [];
    
    for (const [connectionId, connection] of this.connections) {
      if (!connection.isActive) {
        staleConnections.push(connectionId);
        continue;
      }
      
      // Check for timeout
      if (now - connection.lastActivity > this.CONNECTION_TIMEOUT) {
        logger.info(`⏰ Connection ${connectionId} timed out`);
        staleConnections.push(connectionId);
        continue;
      }
      
      // Send heartbeat
      try {
        this.sendEvent(connection.response, {
          type: 'heartbeat',
          data: {
            timestamp: now,
            sessionId: connection.sessionId
          }
        });
        
        connection.lastActivity = now;
      } catch (error) {
        logger.debug(`Heartbeat failed for ${connectionId}, marking for cleanup`);
        staleConnections.push(connectionId);
      }
    }
    
    // Cleanup stale connections
    for (const connectionId of staleConnections) {
      this.disconnect(connectionId, 'stale_connection');
    }
    
    if (this.connections.size > 0) {
      logger.debug(`💓 Heartbeat: ${this.connections.size} active SSE connections`);
    }
  }
  
  /**
   * Get connection statistics
   */
  getStats(): {
    totalConnections: number;
    activeConnections: number;
    sessionDistribution: Record<string, number>;
    averageEventsPerConnection: number;
  } {
    const activeConnections = Array.from(this.connections.values())
      .filter(conn => conn.isActive);
    
    const sessionDistribution: Record<string, number> = {};
    let totalEvents = 0;
    
    for (const connection of activeConnections) {
      sessionDistribution[connection.sessionId] = 
        (sessionDistribution[connection.sessionId] || 0) + 1;
      totalEvents += connection.eventsSent;
    }
    
    return {
      totalConnections: this.connections.size,
      activeConnections: activeConnections.length,
      sessionDistribution,
      averageEventsPerConnection: activeConnections.length > 0 
        ? totalEvents / activeConnections.length 
        : 0
    };
  }
  
  /**
   * Force disconnect all connections for a session
   */
  disconnectSession(sessionId: string, reason = 'forced_disconnect'): void {
    const sessionConnections = Array.from(this.connections.values())
      .filter(conn => conn.sessionId === sessionId);
    
    for (const connection of sessionConnections) {
      this.disconnect(connection.id, reason);
    }
  }
  
  /**
   * Cleanup and shutdown transport
   */
  shutdown(): void {
    logger.info('🛑 Shutting down SSE transport');
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    // Disconnect all connections
    const connectionIds = Array.from(this.connections.keys());
    for (const connectionId of connectionIds) {
      this.disconnect(connectionId, 'server_shutdown');
    }
    
    this.removeAllListeners();
  }
  
  /**
   * Get active connection for session (for testing)
   */
  getSessionConnections(sessionId: string): SSEConnection[] {
    return Array.from(this.connections.values())
      .filter(conn => conn.sessionId === sessionId && conn.isActive);
  }
}