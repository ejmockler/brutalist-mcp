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
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';
import { IntelligentBuffer } from './intelligent-buffer.js';
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
export class SessionChannelManager extends EventEmitter {
    sessions = new Map();
    cleanupTimers = new Map();
    globalBuffer;
    startTime = Date.now();
    // Configuration
    config;
    DEFAULT_CONFIG = {
        ttl: 2 * 60 * 60 * 1000, // 2 hours
        maxConnections: 5, // 5 concurrent connections
        maxMemoryMB: 100, // 100MB per session
        maxEvents: 10000, // 10k events
        autoCleanup: true, // Auto cleanup
        bufferConfig: {
            enableCoalescence: true,
            adaptiveThrottling: true,
            backpressureThreshold: 1000
        }
    };
    // Metrics tracking
    metrics = {
        totalSessions: 0,
        activeSessions: 0,
        totalEvents: 0,
        totalSubscribers: 0,
        memoryUsage: 0,
        uptime: Date.now()
    };
    constructor(config = {}) {
        super();
        this.config = { ...this.DEFAULT_CONFIG, ...config };
        this.globalBuffer = new IntelligentBuffer();
        // Setup global event handlers
        this.setupEventHandlers();
        // Start periodic maintenance
        this.startMaintenance();
        logger.info('SessionChannelManager initialized', {
            ttl: this.config.ttl,
            maxConnections: this.config.maxConnections,
            autoCleanup: this.config.autoCleanup
        });
    }
    /**
     * Create new session with full context
     */
    createSession(sessionId, metadata = {}) {
        const id = sessionId || randomUUID();
        if (this.sessions.has(id)) {
            throw new Error(`Session ${id} already exists`);
        }
        const context = {
            id,
            startTime: Date.now(),
            lastActivity: Date.now(),
            subscribers: new Set(),
            eventBuffer: new IntelligentBuffer(),
            metadata: { ...metadata, createdAt: Date.now() },
            analysis: {
                status: 'starting',
                activeAgents: new Set(),
                completedAgents: new Set(),
                failedAgents: new Set(),
                findings: [],
                startTime: Date.now(),
                progress: {
                    totalPhases: 5, // starting, scanning, analyzing, synthesizing, complete
                    currentPhase: 0,
                    phaseName: 'starting',
                    phaseProgress: 0
                },
                metrics: {
                    totalEvents: 0,
                    findingsCount: 0,
                    errorsCount: 0,
                    avgResponseTime: 0
                }
            },
            connectionCount: 0,
            maxConnections: this.config.maxConnections,
            resources: {
                memoryUsage: 0,
                eventCount: 0,
                connectionTime: 0
            },
            cleanup: {
                ttl: this.config.ttl,
                scheduled: false
            }
        };
        this.sessions.set(id, context);
        this.metrics.totalSessions++;
        this.metrics.activeSessions++;
        // Schedule cleanup
        if (this.config.autoCleanup) {
            this.scheduleCleanup(id);
        }
        this.emit('sessionCreated', id, context);
        logger.info(`Session created: ${id}`, {
            metadata: Object.keys(metadata),
            totalSessions: this.metrics.activeSessions
        });
        return context;
    }
    /**
     * Get session context with access validation
     */
    getSession(sessionId, requireActive = true) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        if (requireActive && session.analysis.status === 'failed') {
            return null;
        }
        // Update activity
        session.lastActivity = Date.now();
        return session;
    }
    /**
     * Subscribe to session events with connection management
     */
    async subscribe(sessionId, subscriber) {
        const session = this.getSession(sessionId);
        if (!session) {
            logger.warn(`Subscription attempt to non-existent session: ${sessionId}`);
            return false;
        }
        // Check connection limits
        if (session.connectionCount >= session.maxConnections) {
            logger.warn(`Connection limit exceeded for session ${sessionId} (${session.connectionCount}/${session.maxConnections})`);
            return false;
        }
        // Add subscriber
        session.subscribers.add(subscriber);
        session.connectionCount++;
        session.resources.connectionTime = Date.now();
        this.metrics.totalSubscribers++;
        // Send backlog to new subscriber
        const backlog = session.eventBuffer.getBacklog(sessionId, 50); // Last 50 events
        for (const event of backlog) {
            await subscriber.emit(event);
        }
        this.emit('subscriberConnected', { sessionId, subscriber });
        this.emit('sessionActivity', { sessionId, activity: 'subscriber_connected' });
        logger.debug(`Subscriber connected to session ${sessionId} (${session.connectionCount} total)`);
        return true;
    }
    /**
     * Unsubscribe from session events
     */
    unsubscribe(sessionId, subscriberId) {
        const session = this.getSession(sessionId, false);
        if (!session) {
            return false;
        }
        // Find and remove subscriber
        let found = false;
        for (const subscriber of session.subscribers) {
            if (subscriber.id === subscriberId) {
                session.subscribers.delete(subscriber);
                session.connectionCount--;
                this.metrics.totalSubscribers--;
                found = true;
                // Close subscriber connection
                try {
                    subscriber.close();
                }
                catch (error) {
                    logger.warn(`Error closing subscriber ${subscriberId}:`, error);
                }
                break;
            }
        }
        if (found) {
            this.emit('subscriberDisconnected', { sessionId, subscriberId });
            this.emit('sessionActivity', { sessionId, activity: 'subscriber_disconnected' });
            logger.debug(`Subscriber ${subscriberId} disconnected from session ${sessionId}`);
        }
        return found;
    }
    /**
     * Emit event to session with intelligent buffering
     */
    async emitToSession(sessionId, event) {
        // Use the sessionId parameter, not event.sessionId
        const session = this.getSession(sessionId);
        if (!session) {
            logger.warn(`Event for unknown session: ${sessionId}`);
            return;
        }
        // Update session activity
        session.lastActivity = Date.now();
        session.analysis.metrics.totalEvents++;
        session.resources.eventCount++;
        // Update analysis state
        this.updateAnalysisState(session, event);
        // Add to buffer for intelligent delivery
        session.eventBuffer.add(event);
        // Update memory usage
        session.resources.memoryUsage = session.eventBuffer.getState(sessionId)?.memoryUsage || 0;
        // Update metrics immediately for real-time tracking
        this.updateMetrics();
        // Emit activity event
        this.emit('sessionActivity', { sessionId, activity: 'event_received' });
        logger.debug(`Event emitted to session ${sessionId}: ${event.type} from ${event.agent}`);
    }
    /**
     * Start analysis tracking for session
     */
    startAnalysis(sessionId, agents) {
        const session = this.getSession(sessionId);
        if (!session) {
            return false;
        }
        session.analysis.status = 'running';
        session.analysis.activeAgents = new Set(agents);
        session.analysis.startTime = Date.now();
        this.emit('analysisStarted', { sessionId, agents });
        logger.info(`Analysis started for session ${sessionId} with agents: ${agents.join(', ')}`);
        return true;
    }
    /**
     * Complete analysis for session
     */
    completeAnalysis(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) {
            return false;
        }
        session.analysis.status = 'complete';
        session.analysis.endTime = Date.now();
        session.analysis.progress.currentPhase = session.analysis.progress.totalPhases;
        session.analysis.progress.phaseName = 'complete';
        session.analysis.progress.phaseProgress = 100;
        this.emit('analysisCompleted', { sessionId, analysis: session.analysis });
        logger.info(`Analysis completed for session ${sessionId}`, {
            duration: session.analysis.endTime - session.analysis.startTime,
            findings: session.analysis.findings.length,
            agents: Array.from(session.analysis.completedAgents)
        });
        return true;
    }
    /**
     * Fail analysis for session
     */
    failAnalysis(sessionId, error) {
        const session = this.getSession(sessionId, false);
        if (!session) {
            return false;
        }
        session.analysis.status = 'failed';
        session.analysis.endTime = Date.now();
        this.emit('analysisFailed', { sessionId, error });
        this.emit('sessionError', { sessionId, error });
        logger.error(`Analysis failed for session ${sessionId}:`, error.message);
        return true;
    }
    /**
     * Destroy session and cleanup resources
     */
    destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return false;
        }
        // Close all subscribers
        for (const subscriber of session.subscribers) {
            try {
                subscriber.close();
            }
            catch (error) {
                logger.warn(`Error closing subscriber during session cleanup:`, error);
            }
        }
        // Cleanup timers
        const timer = this.cleanupTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.cleanupTimers.delete(sessionId);
        }
        // Cleanup buffer
        session.eventBuffer.cleanup(sessionId);
        // Remove session
        this.sessions.delete(sessionId);
        this.metrics.activeSessions--;
        this.metrics.totalSubscribers -= session.connectionCount;
        this.emit('sessionDestroyed', { sessionId });
        logger.info(`Session destroyed: ${sessionId}`, {
            lifetime: Date.now() - session.startTime,
            events: session.resources.eventCount,
            connections: session.connectionCount
        });
        return true;
    }
    /**
     * Get all active sessions
     */
    getActiveSessions() {
        return Array.from(this.sessions.values())
            .filter(session => session.analysis.status !== 'failed');
    }
    /**
     * Get session statistics
     */
    /**
     * Get global system metrics
     */
    getGlobalMetrics() {
        const bufferMetrics = this.globalBuffer.getMetrics();
        return {
            ...this.metrics,
            uptime: Date.now() - this.metrics.uptime,
            buffer: bufferMetrics,
            sessions: Array.from(this.sessions.values()).map(s => ({
                id: s.id,
                status: s.analysis.status,
                connections: s.connectionCount,
                events: s.resources.eventCount,
                memoryUsage: s.resources.memoryUsage
            }))
        };
    }
    /**
     * Check if session exists
     */
    hasSession(sessionId) {
        return this.sessions.has(sessionId);
    }
    /**
     * Get session statistics
     */
    getSessionStats(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) {
            return null;
        }
        return {
            eventsEmitted: session.resources.eventCount,
            bufferStats: {
                flushCount: session.eventBuffer.getState(sessionId)?.flushCount || 0
            }
        };
    }
    /**
     * End analysis for session
     */
    endAnalysis(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) {
            return false;
        }
        session.analysis.status = 'complete';
        session.analysis.endTime = Date.now();
        this.emit('analysisCompleted', { sessionId, analysis: session.analysis });
        return true;
    }
    /**
     * Complete session (alias for endAnalysis)
     */
    completeSession(sessionId) {
        return this.endAnalysis(sessionId);
    }
    /**
     * Get global statistics
     */
    getGlobalStats() {
        return {
            ...this.metrics,
            uptime: Date.now() - this.startTime
        };
    }
    /**
     * Shutdown session manager
     */
    shutdown() {
        this.destroy();
    }
    /**
     * Cleanup all resources
     */
    destroy() {
        // Destroy all sessions
        for (const sessionId of this.sessions.keys()) {
            this.destroySession(sessionId);
        }
        // Clear all timers
        for (const timer of this.cleanupTimers.values()) {
            clearTimeout(timer);
        }
        this.cleanupTimers.clear();
        // Remove all listeners
        this.removeAllListeners();
        logger.info('SessionChannelManager destroyed');
    }
    /**
     * Update analysis state based on events
     */
    updateAnalysisState(session, event) {
        const analysis = session.analysis;
        // Track agent activity
        if (event.agent) {
            if (event.type === 'agent_start') {
                analysis.activeAgents.add(event.agent);
            }
            else if (event.type === 'agent_complete') {
                analysis.activeAgents.delete(event.agent);
                analysis.completedAgents.add(event.agent);
            }
            else if (event.type === 'agent_error') {
                analysis.activeAgents.delete(event.agent);
                analysis.failedAgents.add(event.agent);
                analysis.metrics.errorsCount++;
            }
        }
        // Track findings
        if (event.metadata?.contentType === 'finding') {
            analysis.findings.push(event);
            analysis.metrics.findingsCount++;
        }
        // Update progress based on phase
        if (event.metadata?.phase) {
            const phaseMap = {
                'starting': 0,
                'scanning': 1,
                'analyzing': 2,
                'synthesizing': 3,
                'complete': 4
            };
            const phaseNumber = phaseMap[event.metadata.phase];
            if (phaseNumber !== undefined && phaseNumber > analysis.progress.currentPhase) {
                analysis.progress.currentPhase = phaseNumber;
                analysis.progress.phaseName = event.metadata.phase;
                analysis.progress.phaseProgress = Math.round((phaseNumber / analysis.progress.totalPhases) * 100);
                this.emit('analysisProgress', { sessionId: session.id, progress: analysis.progress });
            }
        }
        // Update response time
        const now = Date.now();
        analysis.metrics.avgResponseTime = analysis.metrics.totalEvents > 0
            ? (analysis.metrics.avgResponseTime * (analysis.metrics.totalEvents - 1) + (now - event.timestamp)) / analysis.metrics.totalEvents
            : now - event.timestamp;
    }
    /**
     * Schedule session cleanup
     */
    scheduleCleanup(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || session.cleanup?.scheduled) {
            return;
        }
        const timer = setTimeout(() => {
            const currentSession = this.sessions.get(sessionId);
            if (currentSession && Date.now() - currentSession.lastActivity > this.config.ttl) {
                logger.info(`Auto-cleaning up inactive session: ${sessionId}`);
                this.destroySession(sessionId);
            }
        }, this.config.ttl);
        session.cleanup.timer = timer;
        session.cleanup.scheduled = true;
        this.cleanupTimers.set(sessionId, timer);
    }
    /**
     * Setup global event handlers
     */
    setupEventHandlers() {
        // Listen for buffer batch events
        process.on('streaming-batch', (batch) => {
            this.deliverBatch(batch);
        });
        // Handle uncaught errors
        this.on('error', (error) => {
            logger.error('SessionChannelManager error:', error);
        });
    }
    /**
     * Deliver event batch to session subscribers
     */
    async deliverBatch(batch) {
        const session = this.getSession(batch.sessionId, false);
        if (!session) {
            return;
        }
        const deliveryPromises = [];
        for (const subscriber of session.subscribers) {
            if (subscriber.isConnected()) {
                deliveryPromises.push(subscriber.emitBatch(batch).catch(error => {
                    logger.warn(`Failed to deliver batch to subscriber ${subscriber.id}:`, error);
                    // Auto-disconnect failed subscribers
                    this.unsubscribe(batch.sessionId, subscriber.id);
                }));
            }
        }
        await Promise.allSettled(deliveryPromises);
    }
    /**
     * Start periodic maintenance tasks
     */
    startMaintenance() {
        // Cleanup stale sessions every 5 minutes
        const cleanupInterval = setInterval(() => {
            const now = Date.now();
            const staleThreshold = this.config.ttl;
            for (const [sessionId, session] of this.sessions.entries()) {
                if (now - session.lastActivity > staleThreshold) {
                    logger.info(`Maintenance cleanup: stale session ${sessionId}`);
                    this.destroySession(sessionId);
                }
            }
        }, 5 * 60 * 1000);
        cleanupInterval.unref();
        // Update metrics every minute
        const metricsInterval = setInterval(() => {
            this.updateMetrics();
        }, 60 * 1000);
        metricsInterval.unref();
    }
    /**
     * Update internal metrics
     */
    updateMetrics() {
        this.metrics.activeSessions = this.sessions.size;
        this.metrics.totalEvents = Array.from(this.sessions.values())
            .reduce((sum, s) => sum + s.resources.eventCount, 0);
        this.metrics.memoryUsage = Array.from(this.sessions.values())
            .reduce((sum, s) => sum + s.resources.memoryUsage, 0);
        this.metrics.totalSubscribers = Array.from(this.sessions.values())
            .reduce((sum, s) => sum + s.connectionCount, 0);
    }
}
// Export SessionManager as alias to SessionChannelManager for compatibility
export const SessionManager = SessionChannelManager;
//# sourceMappingURL=session-manager.js.map