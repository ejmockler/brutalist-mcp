/**
 * @module intelligent-buffer
 * @deprecated NOT INTEGRATED -- This module provides priority-based event
 * buffering for the unintegrated StreamingCLIOrchestrator. The canonical
 * streaming path uses direct callbacks with simple throttling in
 * cli-agents.ts#emitThrottledStreamingEvent. Retained for possible future
 * integration. See src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { logger } from '../logger.js';
/**
 * Circular buffer for memory-efficient event storage
 */
class CircularBuffer {
    buffer;
    size;
    head = 0;
    tail = 0;
    count = 0;
    constructor(capacity) {
        this.size = capacity;
        this.buffer = new Array(capacity);
    }
    add(item) {
        this.buffer[this.tail] = item;
        this.tail = (this.tail + 1) % this.size;
        if (this.count < this.size) {
            this.count++;
        }
        else {
            // Buffer full, move head
            this.head = (this.head + 1) % this.size;
        }
    }
    flush() {
        const items = [];
        while (this.count > 0) {
            items.push(this.buffer[this.head]);
            this.head = (this.head + 1) % this.size;
            this.count--;
        }
        return items;
    }
    peek(count = this.count) {
        const items = [];
        let current = this.head;
        for (let i = 0; i < Math.min(count, this.count); i++) {
            items.push(this.buffer[current]);
            current = (current + 1) % this.size;
        }
        return items;
    }
    getCount() {
        return this.count;
    }
    isFull() {
        return this.count === this.size;
    }
}
/**
 * Priority queue implementation for event batching
 */
class PriorityQueue {
    queues = new Map();
    priorities = ['immediate', 'high', 'normal', 'low'];
    constructor() {
        this.priorities.forEach(priority => {
            this.queues.set(priority, []);
        });
    }
    enqueue(item, priority) {
        const queue = this.queues.get(priority);
        if (queue) {
            queue.push(item);
        }
    }
    dequeue() {
        for (const priority of this.priorities) {
            const queue = this.queues.get(priority);
            if (queue && queue.length > 0) {
                const item = queue.shift();
                return { item, priority };
            }
        }
        return null;
    }
    dequeueAll(priority) {
        if (priority) {
            const queue = this.queues.get(priority);
            if (queue) {
                const items = [...queue];
                queue.length = 0;
                return items;
            }
            return [];
        }
        // Dequeue all items in priority order
        const items = [];
        for (const p of this.priorities) {
            const queue = this.queues.get(p);
            if (queue) {
                items.push(...queue);
                queue.length = 0;
            }
        }
        return items;
    }
    size(priority) {
        if (priority) {
            return this.queues.get(priority)?.length || 0;
        }
        return Array.from(this.queues.values()).reduce((sum, queue) => sum + queue.length, 0);
    }
    isEmpty() {
        return this.size() === 0;
    }
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
export class IntelligentBuffer {
    buffers = new Map();
    flushTimers = new Map();
    states = new Map();
    backlog = new Map();
    // Adaptive buffering rules based on content analysis
    BUFFERING_RULES = {
        // Critical findings bypass buffering
        'critical_finding': {
            delay: 0,
            maxBatch: 1,
            coalescence: false,
            priority: 'immediate'
        },
        // Security issues get high priority
        'security_finding': {
            delay: 50,
            maxBatch: 2,
            coalescence: false,
            priority: 'high'
        },
        // Regular findings with moderate batching
        'finding': {
            delay: 200,
            maxBatch: 5,
            coalescence: true,
            priority: 'normal'
        },
        // Progress updates with standard throttling
        'agent_progress': {
            delay: 200,
            maxBatch: 10,
            coalescence: true,
            priority: 'normal'
        },
        // Errors need immediate attention
        'agent_error': {
            delay: 0,
            maxBatch: 1,
            coalescence: false,
            priority: 'immediate'
        },
        // Completion events are high priority
        'agent_complete': {
            delay: 100,
            maxBatch: 1,
            coalescence: false,
            priority: 'high'
        },
        // Debug info can be heavily throttled
        'debug_info': {
            delay: 1000,
            maxBatch: 20,
            coalescence: true,
            priority: 'low'
        },
        // Milestones are important but can be batched
        'milestone': {
            delay: 150,
            maxBatch: 3,
            coalescence: false,
            priority: 'high'
        }
    };
    DEFAULT_RULE = {
        delay: 500,
        maxBatch: 5,
        coalescence: true,
        priority: 'normal'
    };
    // Configuration
    MAX_BUFFER_SIZE = 1000; // Events per session
    MAX_MEMORY_MB = 50; // Memory limit per session
    BACKLOG_SIZE = 500; // Backlog events for late subscribers
    constructor() {
        // Periodic cleanup of stale sessions
        const cleanupInterval = setInterval(() => this.cleanupStaleSessions(), 60000); // Every minute
        // Allow Node.js to exit if this is the only active timer
        cleanupInterval.unref();
    }
    /**
     * Add event to buffer with intelligent routing
     */
    add(event) {
        if (!event.sessionId) {
            logger.warn('Event without sessionId dropped');
            return;
        }
        // Get or create buffer state
        const state = this.getOrCreateState(event.sessionId);
        // Check for backpressure
        if (state.backpressure) {
            logger.warn(`Backpressure detected for session ${event.sessionId}, dropping low priority events`);
            if (this.getEventPriority(event) === 'low') {
                return;
            }
        }
        // Classify event and get buffering rule
        const classification = this.classifyEvent(event);
        const rule = this.BUFFERING_RULES[classification] || this.DEFAULT_RULE;
        // Get or create buffer
        const buffer = this.getOrCreateBuffer(event.sessionId);
        // Add to backlog for late subscribers
        this.addToBacklog(event);
        // Enqueue with priority
        buffer.enqueue(event, rule.priority);
        // Update state
        state.totalEvents++;
        state.pendingEvents = buffer.size();
        state.memoryUsage = this.estimateMemoryUsage(event.sessionId);
        // Check memory limits
        if (state.memoryUsage > this.MAX_MEMORY_MB * 1024 * 1024) {
            this.handleMemoryPressure(event.sessionId);
        }
        // Schedule flush based on rule
        this.scheduleFlush(event.sessionId, rule);
        logger.debug(`Buffered ${classification} event for session ${event.sessionId} (${state.pendingEvents} pending)`);
    }
    /**
     * Force flush of all pending events for a session
     */
    flush(sessionId, priority) {
        const buffer = this.buffers.get(sessionId);
        const state = this.states.get(sessionId);
        if (!buffer || !state) {
            return null;
        }
        const events = buffer.dequeueAll(priority);
        if (events.length === 0) {
            return null;
        }
        // Apply coalescence if enabled
        const coalescedEvents = this.applyCoalescence(events);
        // Update state
        state.pendingEvents = buffer.size();
        state.lastFlush = Date.now();
        state.flushCount++;
        // Clear timer if exists
        const timer = this.flushTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.flushTimers.delete(sessionId);
        }
        const batch = {
            sessionId,
            events: coalescedEvents,
            priority: priority || 'normal',
            batchId: `${sessionId}-${state.flushCount}-${Date.now()}`,
            createdAt: Date.now()
        };
        logger.debug(`Flushed ${coalescedEvents.length} events for session ${sessionId} (batch: ${batch.batchId})`);
        return batch;
    }
    /**
     * Get backlog events for late subscribers
     */
    getBacklog(sessionId, limit) {
        const backlog = this.backlog.get(sessionId);
        if (!backlog) {
            return [];
        }
        return backlog.peek(limit);
    }
    /**
     * Get buffer state for monitoring
     */
    getState(sessionId) {
        return this.states.get(sessionId) || null;
    }
    /**
     * Get all active sessions
     */
    getActiveSessions() {
        return Array.from(this.buffers.keys());
    }
    /**
     * Cleanup session resources
     */
    cleanup(sessionId) {
        // Flush any remaining events
        this.flush(sessionId);
        // Clear timer
        const timer = this.flushTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.flushTimers.delete(sessionId);
        }
        // Remove all resources
        this.buffers.delete(sessionId);
        this.states.delete(sessionId);
        this.backlog.delete(sessionId);
        logger.info(`Cleaned up buffer resources for session ${sessionId}`);
    }
    /**
     * Get total memory usage across all sessions
     */
    getTotalMemoryUsage() {
        return Array.from(this.states.values())
            .reduce((sum, state) => sum + state.memoryUsage, 0);
    }
    /**
     * Get system-wide metrics
     */
    getMetrics() {
        const states = Array.from(this.states.values());
        return {
            activeSessions: states.length,
            totalEvents: states.reduce((sum, s) => sum + s.totalEvents, 0),
            totalMemoryMB: Math.round(this.getTotalMemoryUsage() / (1024 * 1024)),
            backpressureSessions: states.filter(s => s.backpressure).length
        };
    }
    /**
     * Classify event for buffering rules
     */
    classifyEvent(event) {
        const content = event.content?.toLowerCase() || '';
        const metadata = event.metadata;
        // Check metadata classification first
        if (metadata?.contentType === 'finding') {
            if (metadata.severity === 'critical') {
                return 'critical_finding';
            }
            if (content.includes('security') || content.includes('vulnerability')) {
                return 'security_finding';
            }
            return 'finding';
        }
        // Event type classification
        if (event.type === 'agent_error') {
            return 'agent_error';
        }
        if (event.type === 'agent_complete') {
            return 'agent_complete';
        }
        // Content-based classification
        if (content.includes('critical') || content.includes('security')) {
            return 'critical_finding';
        }
        if (metadata?.contentType === 'milestone') {
            return 'milestone';
        }
        if (metadata?.contentType === 'debug') {
            return 'debug_info';
        }
        return 'agent_progress';
    }
    /**
     * Get event priority for backpressure handling
     */
    getEventPriority(event) {
        const classification = this.classifyEvent(event);
        return this.BUFFERING_RULES[classification]?.priority || 'normal';
    }
    /**
     * Schedule flush based on buffering rule
     */
    scheduleFlush(sessionId, rule) {
        // Immediate delivery
        if (rule.delay === 0) {
            setImmediate(() => {
                const batch = this.flush(sessionId, rule.priority);
                if (batch) {
                    this.deliverBatch(batch);
                }
            });
            return;
        }
        // Check if we should flush due to batch size
        const buffer = this.buffers.get(sessionId);
        if (buffer && buffer.size(rule.priority) >= rule.maxBatch) {
            const batch = this.flush(sessionId, rule.priority);
            if (batch) {
                this.deliverBatch(batch);
            }
            return;
        }
        // Schedule timer if not already scheduled
        if (!this.flushTimers.has(sessionId)) {
            const timer = setTimeout(() => {
                this.flushTimers.delete(sessionId);
                const batch = this.flush(sessionId);
                if (batch) {
                    this.deliverBatch(batch);
                }
            }, rule.delay);
            this.flushTimers.set(sessionId, timer);
        }
    }
    /**
     * Apply content coalescence to reduce noise
     */
    applyCoalescence(events) {
        if (events.length <= 1) {
            return events;
        }
        const coalesced = [];
        const groups = new Map();
        // Group similar events
        for (const event of events) {
            const key = this.getCoalescenceKey(event);
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(event);
        }
        // Coalesce each group
        for (const group of groups.values()) {
            if (group.length === 1) {
                coalesced.push(group[0]);
            }
            else {
                const merged = this.mergeEvents(group);
                coalesced.push(merged);
            }
        }
        return coalesced.sort((a, b) => a.timestamp - b.timestamp);
    }
    /**
     * Generate coalescence key for grouping similar events
     */
    getCoalescenceKey(event) {
        return `${event.agent}-${event.type}-${event.metadata?.contentType || 'default'}`;
    }
    /**
     * Merge similar events into single event
     */
    mergeEvents(events) {
        const first = events[0];
        const last = events[events.length - 1];
        return {
            ...first,
            content: events.length > 3
                ? `${first.content} ... [${events.length - 2} similar events] ... ${last.content}`
                : events.map(e => e.content).join(' | '),
            timestamp: last.timestamp,
            metadata: {
                ...first.metadata,
                coalescedCount: events.length,
                timespan: last.timestamp - first.timestamp
            }
        };
    }
    /**
     * Get or create buffer for session
     */
    getOrCreateBuffer(sessionId) {
        if (!this.buffers.has(sessionId)) {
            this.buffers.set(sessionId, new PriorityQueue());
        }
        return this.buffers.get(sessionId);
    }
    /**
     * Get or create buffer state
     */
    getOrCreateState(sessionId) {
        if (!this.states.has(sessionId)) {
            this.states.set(sessionId, {
                sessionId,
                totalEvents: 0,
                pendingEvents: 0,
                lastFlush: Date.now(),
                flushCount: 0,
                backpressure: false,
                memoryUsage: 0
            });
        }
        return this.states.get(sessionId);
    }
    /**
     * Add event to backlog for late subscribers
     */
    addToBacklog(event) {
        if (!event.sessionId)
            return;
        if (!this.backlog.has(event.sessionId)) {
            this.backlog.set(event.sessionId, new CircularBuffer(this.BACKLOG_SIZE));
        }
        this.backlog.get(event.sessionId).add(event);
    }
    /**
     * Estimate memory usage for session
     */
    estimateMemoryUsage(sessionId) {
        const buffer = this.buffers.get(sessionId);
        const backlog = this.backlog.get(sessionId);
        let size = 0;
        // Estimate buffer size (rough approximation)
        if (buffer) {
            size += buffer.size() * 500; // ~500 bytes per event
        }
        // Estimate backlog size
        if (backlog) {
            size += backlog.getCount() * 500;
        }
        return size;
    }
    /**
     * Handle memory pressure by dropping low priority events
     */
    handleMemoryPressure(sessionId) {
        const state = this.getOrCreateState(sessionId);
        const buffer = this.buffers.get(sessionId);
        state.backpressure = true;
        // Flush low priority events immediately to free memory
        if (buffer) {
            const lowPriorityEvents = buffer.dequeueAll('low');
            logger.warn(`Memory pressure: dropped ${lowPriorityEvents.length} low priority events for session ${sessionId}`);
        }
        // Clear backpressure after a delay
        setTimeout(() => {
            state.backpressure = false;
        }, 5000);
    }
    /**
     * Clean up stale sessions (no activity for > 1 hour)
     */
    cleanupStaleSessions() {
        const now = Date.now();
        const staleThreshold = 60 * 60 * 1000; // 1 hour
        for (const [sessionId, state] of this.states.entries()) {
            if (now - state.lastFlush > staleThreshold) {
                logger.info(`Cleaning up stale session: ${sessionId}`);
                this.cleanup(sessionId);
            }
        }
    }
    /**
     * Deliver batch to subscribers (to be implemented by transport layer)
     */
    deliverBatch(batch) {
        // This will be called by the transport layer
        // For now, just emit a custom event that can be listened to
        // Emit batch as event (commented out as it's not needed for current implementation)
        // process.emit('streaming-batch', batch);
    }
}
//# sourceMappingURL=intelligent-buffer.js.map