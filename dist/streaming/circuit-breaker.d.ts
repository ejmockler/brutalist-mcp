/**
 * @module circuit-breaker
 * @deprecated NOT INTEGRATED -- This module provides fault-tolerance circuit
 * breaking for the unintegrated StreamingCLIOrchestrator. The canonical
 * streaming path has no circuit breaker; failures are handled by try/catch in
 * brutalist-server.ts#handleStreamingEvent. Retained for possible future
 * integration. See src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { EventEmitter } from 'events';
/**
 * Circuit breaker states
 */
export declare enum CircuitState {
    CLOSED = "closed",// Normal operation
    OPEN = "open",// Blocking requests due to failures
    HALF_OPEN = "half_open"
}
/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
    failureThreshold: number;
    recoveryTimeout: number;
    successThreshold: number;
    timeout: number;
    monitoringWindow: number;
    minimumRequests: number;
}
/**
 * Circuit breaker statistics
 */
export interface CircuitStats {
    state: CircuitState;
    failures: number;
    successes: number;
    totalRequests: number;
    lastFailureTime?: number;
    lastSuccessTime?: number;
    uptime: number;
    failureRate: number;
    averageResponseTime: number;
}
/**
 * Request context for circuit breaker
 */
export interface RequestContext {
    id: string;
    startTime: number;
    timeout: NodeJS.Timeout;
    resolve: (value: any) => void;
    reject: (reason: any) => void;
}
/**
 * Fallback strategy interface
 */
export interface FallbackStrategy {
    execute(context: RequestContext, error: Error): Promise<any>;
    canHandle(error: Error): boolean;
    priority: number;
}
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
export declare class CircuitBreaker extends EventEmitter {
    private config;
    private name;
    private state;
    private failures;
    private successes;
    private totalRequests;
    private lastFailureTime?;
    private lastSuccessTime?;
    private recoveryTimer?;
    private pendingRequests;
    private fallbackStrategies;
    private responseTimesWindow;
    private requestTimesWindow;
    constructor(config: CircuitBreakerConfig, name?: string);
    /**
     * Execute function with circuit breaker protection
     */
    execute<T>(fn: () => Promise<T>, context?: {
        id?: string;
        metadata?: Record<string, any>;
    }): Promise<T>;
    /**
     * Handle successful request
     */
    private handleSuccess;
    /**
     * Handle failed request
     */
    private handleFailure;
    /**
     * Handle request timeout
     */
    private handleTimeout;
    /**
     * Handle fallback execution
     */
    private handleFallback;
    /**
     * Check if circuit should be opened
     */
    private shouldOpenCircuit;
    /**
     * Get recent requests within monitoring window
     */
    private getRecentRequests;
    /**
     * Track request in monitoring window
     */
    private trackRequest;
    /**
     * Transition to OPEN state
     */
    private transitionToOpen;
    /**
     * Transition to HALF_OPEN state
     */
    private transitionToHalfOpen;
    /**
     * Transition to CLOSED state
     */
    private transitionToClosed;
    /**
     * Add fallback strategy
     */
    addFallbackStrategy(strategy: FallbackStrategy): void;
    /**
     * Remove fallback strategy
     */
    removeFallbackStrategy(strategyClass: any): void;
    /**
     * Get current circuit breaker statistics
     */
    getStats(): CircuitStats;
    /**
     * Force circuit state change (for testing)
     */
    forceState(state: CircuitState): void;
    /**
     * Reset circuit breaker to initial state
     */
    reset(): void;
    /**
     * Cleanup and shutdown
     */
    shutdown(): void;
}
/**
 * Default fallback strategies
 */
/**
 * Cache fallback - return cached response if available
 */
export declare class CachedResponseFallback implements FallbackStrategy {
    private cache;
    priority: number;
    constructor(cache: Map<string, any>);
    canHandle(_error: Error): boolean;
    execute(context: RequestContext, _error: Error): Promise<any>;
}
/**
 * Degraded service fallback - return simplified response
 */
export declare class DegradedServiceFallback implements FallbackStrategy {
    private degradedResponse;
    priority: number;
    constructor(degradedResponse: any);
    canHandle(_error: Error): boolean;
    execute(context: RequestContext, error: Error): Promise<any>;
}
/**
 * Retry with delay fallback
 */
export declare class RetryFallback implements FallbackStrategy {
    private retryFn;
    private maxRetries;
    private delay;
    priority: number;
    constructor(retryFn: () => Promise<any>, maxRetries?: number, delay?: number);
    canHandle(error: Error): boolean;
    execute(context: RequestContext, _error: Error): Promise<any>;
}
//# sourceMappingURL=circuit-breaker.d.ts.map