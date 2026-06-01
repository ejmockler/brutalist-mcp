/**
 * @module circuit-breaker
 * @deprecated NOT INTEGRATED -- This module provides fault-tolerance circuit
 * breaking for the unintegrated StreamingCLIOrchestrator. The canonical
 * streaming path has no circuit breaker; failures are handled by try/catch in
 * brutalist-server.ts#handleStreamingEvent. Retained for possible future
 * integration. See src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { EventEmitter } from 'events';
import { logger } from '../logger.js';
/**
 * Circuit breaker states
 */
export var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "closed";
    CircuitState["OPEN"] = "open";
    CircuitState["HALF_OPEN"] = "half_open"; // Testing if service has recovered
})(CircuitState || (CircuitState = {}));
/**
 * Circuit breaker with intelligent fallback handling.
 *
 * Features:
 * - Automatic failure detection and recovery
 * - Configurable thresholds and timeouts
 * - Multiple fallback strategies with priority
 * - Real-time statistics and monitoring
 * - Graceful degradation patterns
 * - Request queuing during recovery
 *
 * @deprecated NOT INTEGRATED -- The canonical streaming path has no circuit
 * breaker; errors are caught by try/catch in handleStreamingEvent. This
 * breaker is used only by the unintegrated StreamingCLIOrchestrator.
 */
export class CircuitBreaker extends EventEmitter {
    config;
    name;
    state = CircuitState.CLOSED;
    failures = 0;
    successes = 0;
    totalRequests = 0;
    lastFailureTime;
    lastSuccessTime;
    recoveryTimer;
    pendingRequests = new Map();
    fallbackStrategies = [];
    responseTimesWindow = [];
    requestTimesWindow = [];
    constructor(config, name = 'CircuitBreaker') {
        super();
        this.config = config;
        this.name = name;
        logger.info(`🔌 Circuit breaker '${this.name}' initialized`, {
            failureThreshold: config.failureThreshold,
            recoveryTimeout: config.recoveryTimeout,
            timeout: config.timeout
        });
    }
    /**
     * Execute function with circuit breaker protection
     */
    async execute(fn, context) {
        const requestId = context?.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const startTime = Date.now();
        this.totalRequests++;
        // Check circuit state
        if (this.state === CircuitState.OPEN) {
            const error = new Error(`Circuit breaker '${this.name}' is OPEN`);
            this.emit('requestBlocked', { requestId, reason: 'circuit_open' });
            return this.handleFallback(requestId, startTime, error);
        }
        // Create request context
        const requestContext = {
            id: requestId,
            startTime,
            timeout: setTimeout(() => {
                this.handleTimeout(requestContext);
            }, this.config.timeout),
            resolve: () => { },
            reject: () => { }
        };
        this.pendingRequests.set(requestId, requestContext);
        try {
            logger.debug(`🔌 Circuit breaker executing request ${requestId}`);
            const result = await Promise.race([
                fn(),
                new Promise((_, reject) => {
                    requestContext.reject = reject;
                })
            ]);
            this.handleSuccess(requestContext);
            return result;
        }
        catch (error) {
            return this.handleFailure(requestContext, error);
        }
        finally {
            clearTimeout(requestContext.timeout);
            this.pendingRequests.delete(requestId);
        }
    }
    /**
     * Handle successful request
     */
    handleSuccess(context) {
        const responseTime = Date.now() - context.startTime;
        this.successes++;
        this.lastSuccessTime = Date.now();
        // Track response time
        this.responseTimesWindow.push(responseTime);
        if (this.responseTimesWindow.length > 100) {
            this.responseTimesWindow.shift();
        }
        // Track request in monitoring window
        this.trackRequest(true);
        logger.debug(`✅ Circuit breaker success: ${context.id} (${responseTime}ms)`);
        // Handle state transitions
        if (this.state === CircuitState.HALF_OPEN) {
            if (this.successes >= this.config.successThreshold) {
                this.transitionToClosed();
            }
        }
        this.emit('requestSuccess', {
            requestId: context.id,
            responseTime,
            state: this.state
        });
    }
    /**
     * Handle failed request
     */
    async handleFailure(context, error) {
        const responseTime = Date.now() - context.startTime;
        this.failures++;
        this.lastFailureTime = Date.now();
        // Track request in monitoring window
        this.trackRequest(false);
        logger.warn(`❌ Circuit breaker failure: ${context.id} (${responseTime}ms) - ${error.message}`);
        // Check if we should open the circuit
        if (this.shouldOpenCircuit()) {
            this.transitionToOpen();
        }
        this.emit('requestFailure', {
            requestId: context.id,
            error: error.message,
            responseTime,
            state: this.state
        });
        // Try fallback strategies
        return this.handleFallback(context.id, context.startTime, error);
    }
    /**
     * Handle request timeout
     */
    handleTimeout(context) {
        const error = new Error(`Request ${context.id} timed out after ${this.config.timeout}ms`);
        context.reject(error);
    }
    /**
     * Handle fallback execution
     */
    async handleFallback(requestId, startTime, error) {
        // Sort strategies by priority
        const sortedStrategies = [...this.fallbackStrategies].sort((a, b) => a.priority - b.priority);
        for (const strategy of sortedStrategies) {
            if (strategy.canHandle(error)) {
                try {
                    logger.info(`🔄 Executing fallback strategy for ${requestId}: ${strategy.constructor.name}`);
                    const result = await strategy.execute({
                        id: requestId,
                        startTime,
                        timeout: setTimeout(() => { }, 0), // Dummy timeout
                        resolve: () => { },
                        reject: () => { }
                    }, error);
                    this.emit('fallbackSuccess', {
                        requestId,
                        strategy: strategy.constructor.name,
                        originalError: error.message
                    });
                    return result;
                }
                catch (fallbackError) {
                    logger.warn(`Fallback strategy failed for ${requestId}:`, fallbackError);
                    continue;
                }
            }
        }
        // No fallback worked, throw original error
        this.emit('fallbackExhausted', {
            requestId,
            originalError: error.message,
            triedStrategies: sortedStrategies.length
        });
        throw error;
    }
    /**
     * Check if circuit should be opened
     */
    shouldOpenCircuit() {
        if (this.state === CircuitState.OPEN) {
            return false;
        }
        // Check failure threshold
        if (this.failures >= this.config.failureThreshold) {
            return true;
        }
        // Check failure rate within monitoring window
        const recentRequests = this.getRecentRequests();
        if (recentRequests.length >= this.config.minimumRequests) {
            const recentFailures = recentRequests.filter(r => !r.success).length;
            const failureRate = recentFailures / recentRequests.length;
            // Open if failure rate > 50%
            if (failureRate > 0.5) {
                logger.warn(`📊 High failure rate detected: ${Math.round(failureRate * 100)}%`);
                return true;
            }
        }
        return false;
    }
    /**
     * Get recent requests within monitoring window
     */
    getRecentRequests() {
        const cutoff = Date.now() - this.config.monitoringWindow;
        return this.requestTimesWindow.filter(r => r.timestamp > cutoff);
    }
    /**
     * Track request in monitoring window
     */
    trackRequest(success) {
        this.requestTimesWindow.push({
            timestamp: Date.now(),
            success
        });
        // Keep window size manageable
        if (this.requestTimesWindow.length > 1000) {
            this.requestTimesWindow.shift();
        }
    }
    /**
     * Transition to OPEN state
     */
    transitionToOpen() {
        if (this.state === CircuitState.OPEN) {
            return;
        }
        logger.warn(`🔴 Circuit breaker '${this.name}' opened (failures: ${this.failures})`);
        this.state = CircuitState.OPEN;
        this.successes = 0; // Reset success counter
        // Set recovery timer
        this.recoveryTimer = setTimeout(() => {
            this.transitionToHalfOpen();
        }, this.config.recoveryTimeout);
        this.emit('stateChanged', {
            state: this.state,
            reason: 'failure_threshold_exceeded',
            failures: this.failures
        });
    }
    /**
     * Transition to HALF_OPEN state
     */
    transitionToHalfOpen() {
        logger.info(`🟡 Circuit breaker '${this.name}' half-open (testing recovery)`);
        this.state = CircuitState.HALF_OPEN;
        this.successes = 0; // Reset for testing
        this.emit('stateChanged', {
            state: this.state,
            reason: 'recovery_timeout_reached'
        });
    }
    /**
     * Transition to CLOSED state
     */
    transitionToClosed() {
        logger.info(`🟢 Circuit breaker '${this.name}' closed (recovered)`);
        this.state = CircuitState.CLOSED;
        this.failures = 0; // Reset failure counter
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = undefined;
        }
        this.emit('stateChanged', {
            state: this.state,
            reason: 'recovery_successful',
            successes: this.successes
        });
    }
    /**
     * Add fallback strategy
     */
    addFallbackStrategy(strategy) {
        this.fallbackStrategies.push(strategy);
        this.fallbackStrategies.sort((a, b) => a.priority - b.priority);
        logger.info(`📋 Added fallback strategy: ${strategy.constructor.name} (priority: ${strategy.priority})`);
    }
    /**
     * Remove fallback strategy
     */
    removeFallbackStrategy(strategyClass) {
        const index = this.fallbackStrategies.findIndex(s => s instanceof strategyClass);
        if (index >= 0) {
            const removed = this.fallbackStrategies.splice(index, 1)[0];
            logger.info(`🗑️ Removed fallback strategy: ${removed.constructor.name}`);
        }
    }
    /**
     * Get current circuit breaker statistics
     */
    getStats() {
        const recentRequests = this.getRecentRequests();
        const recentFailures = recentRequests.filter(r => !r.success).length;
        const failureRate = recentRequests.length > 0
            ? recentFailures / recentRequests.length
            : 0;
        const averageResponseTime = this.responseTimesWindow.length > 0
            ? this.responseTimesWindow.reduce((sum, time) => sum + time, 0) / this.responseTimesWindow.length
            : 0;
        return {
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            totalRequests: this.totalRequests,
            lastFailureTime: this.lastFailureTime,
            lastSuccessTime: this.lastSuccessTime,
            uptime: this.lastSuccessTime ? Date.now() - this.lastSuccessTime : 0,
            failureRate,
            averageResponseTime
        };
    }
    /**
     * Force circuit state change (for testing)
     */
    forceState(state) {
        logger.warn(`⚠️ Forcing circuit breaker '${this.name}' to ${state}`);
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = undefined;
        }
        this.state = state;
        if (state === CircuitState.OPEN) {
            this.recoveryTimer = setTimeout(() => {
                this.transitionToHalfOpen();
            }, this.config.recoveryTimeout);
        }
        this.emit('stateChanged', {
            state: this.state,
            reason: 'forced_state_change'
        });
    }
    /**
     * Reset circuit breaker to initial state
     */
    reset() {
        logger.info(`🔄 Resetting circuit breaker '${this.name}'`);
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
            this.recoveryTimer = undefined;
        }
        this.state = CircuitState.CLOSED;
        this.failures = 0;
        this.successes = 0;
        this.totalRequests = 0;
        this.lastFailureTime = undefined;
        this.lastSuccessTime = undefined;
        this.responseTimesWindow = [];
        this.requestTimesWindow = [];
        // Cancel pending requests
        for (const [requestId, context] of this.pendingRequests) {
            clearTimeout(context.timeout);
            context.reject(new Error('Circuit breaker reset'));
        }
        this.pendingRequests.clear();
        this.emit('reset');
    }
    /**
     * Cleanup and shutdown
     */
    shutdown() {
        logger.info(`🛑 Shutting down circuit breaker '${this.name}'`);
        if (this.recoveryTimer) {
            clearTimeout(this.recoveryTimer);
        }
        // Cancel all pending requests
        for (const [requestId, context] of this.pendingRequests) {
            clearTimeout(context.timeout);
            context.reject(new Error('Circuit breaker shutdown'));
        }
        this.removeAllListeners();
    }
}
/**
 * Default fallback strategies
 */
/**
 * Cache fallback - return cached response if available
 */
export class CachedResponseFallback {
    cache;
    priority = 1;
    constructor(cache) {
        this.cache = cache;
    }
    canHandle(_error) {
        return true; // Can handle any error if cache is available
    }
    async execute(context, _error) {
        const cached = this.cache.get(context.id);
        if (cached) {
            logger.info(`📋 Using cached response for ${context.id}`);
            return cached;
        }
        throw new Error('No cached response available');
    }
}
/**
 * Degraded service fallback - return simplified response
 */
export class DegradedServiceFallback {
    degradedResponse;
    priority = 2;
    constructor(degradedResponse) {
        this.degradedResponse = degradedResponse;
    }
    canHandle(_error) {
        return true;
    }
    async execute(context, error) {
        logger.info(`🔻 Using degraded service response for ${context.id}`);
        return {
            ...this.degradedResponse,
            metadata: {
                fallback: true,
                originalError: error.message,
                timestamp: Date.now()
            }
        };
    }
}
/**
 * Retry with delay fallback
 */
export class RetryFallback {
    retryFn;
    maxRetries;
    delay;
    priority = 3;
    constructor(retryFn, maxRetries = 3, delay = 1000) {
        this.retryFn = retryFn;
        this.maxRetries = maxRetries;
        this.delay = delay;
    }
    canHandle(error) {
        // Only retry on certain error types
        return !error.message.includes('timeout') &&
            !error.message.includes('validation');
    }
    async execute(context, _error) {
        for (let i = 0; i < this.maxRetries; i++) {
            try {
                logger.info(`🔄 Retry attempt ${i + 1}/${this.maxRetries} for ${context.id}`);
                await new Promise(resolve => setTimeout(resolve, this.delay * (i + 1)));
                return await this.retryFn();
            }
            catch (retryError) {
                if (i === this.maxRetries - 1) {
                    throw retryError;
                }
            }
        }
        throw new Error('All retry attempts failed');
    }
}
//# sourceMappingURL=circuit-breaker.js.map