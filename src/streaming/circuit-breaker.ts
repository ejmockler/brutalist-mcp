import { EventEmitter } from 'events';
import { logger } from '../logger.js';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  CLOSED = 'closed',      // Normal operation
  OPEN = 'open',          // Blocking requests due to failures
  HALF_OPEN = 'half_open' // Testing if service has recovered
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;        // Number of failures before opening
  recoveryTimeout: number;         // Time to wait before trying half-open (ms)
  successThreshold: number;        // Successes needed in half-open to close
  timeout: number;                 // Request timeout (ms)
  monitoringWindow: number;        // Window for failure rate calculation (ms)
  minimumRequests: number;         // Minimum requests before considering failure rate
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
  priority: number; // Lower numbers = higher priority
}

/**
 * Circuit breaker with intelligent fallback handling
 * 
 * Features:
 * - Automatic failure detection and recovery
 * - Configurable thresholds and timeouts
 * - Multiple fallback strategies with priority
 * - Real-time statistics and monitoring
 * - Graceful degradation patterns
 * - Request queuing during recovery
 */
export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = CircuitState.CLOSED;
  private failures = 0;
  private successes = 0;
  private totalRequests = 0;
  private lastFailureTime?: number;
  private lastSuccessTime?: number;
  private recoveryTimer?: NodeJS.Timeout;
  private pendingRequests = new Map<string, RequestContext>();
  private fallbackStrategies: FallbackStrategy[] = [];
  private responseTimesWindow: number[] = [];
  private requestTimesWindow: { timestamp: number; success: boolean }[] = [];
  
  constructor(
    private config: CircuitBreakerConfig,
    private name: string = 'CircuitBreaker'
  ) {
    super();
    
    logger.info(`🔌 Circuit breaker '${this.name}' initialized`, {
      failureThreshold: config.failureThreshold,
      recoveryTimeout: config.recoveryTimeout,
      timeout: config.timeout
    });
  }
  
  /**
   * Execute function with circuit breaker protection
   */
  async execute<T>(
    fn: () => Promise<T>,
    context?: { id?: string; metadata?: Record<string, any> }
  ): Promise<T> {
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
    const requestContext: RequestContext = {
      id: requestId,
      startTime,
      timeout: setTimeout(() => {
        this.handleTimeout(requestContext);
      }, this.config.timeout),
      resolve: () => {},
      reject: () => {}
    };
    
    this.pendingRequests.set(requestId, requestContext);
    
    try {
      logger.debug(`🔌 Circuit breaker executing request ${requestId}`);
      
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          requestContext.reject = reject;
        })
      ]);
      
      this.handleSuccess(requestContext);
      return result;
      
    } catch (error) {
      return this.handleFailure(requestContext, error as Error);
    } finally {
      clearTimeout(requestContext.timeout);
      this.pendingRequests.delete(requestId);
    }
  }
  
  /**
   * Handle successful request
   */
  private handleSuccess(context: RequestContext): void {
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
  private async handleFailure(context: RequestContext, error: Error): Promise<any> {
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
  private handleTimeout(context: RequestContext): void {
    const error = new Error(`Request ${context.id} timed out after ${this.config.timeout}ms`);
    context.reject(error);
  }
  
  /**
   * Handle fallback execution
   */
  private async handleFallback(requestId: string, startTime: number, error: Error): Promise<any> {
    // Sort strategies by priority
    const sortedStrategies = [...this.fallbackStrategies].sort((a, b) => a.priority - b.priority);
    
    for (const strategy of sortedStrategies) {
      if (strategy.canHandle(error)) {
        try {
          logger.info(`🔄 Executing fallback strategy for ${requestId}: ${strategy.constructor.name}`);
          
          const result = await strategy.execute({
            id: requestId,
            startTime,
            timeout: setTimeout(() => {}, 0), // Dummy timeout
            resolve: () => {},
            reject: () => {}
          }, error);
          
          this.emit('fallbackSuccess', {
            requestId,
            strategy: strategy.constructor.name,
            originalError: error.message
          });
          
          return result;
          
        } catch (fallbackError) {
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
  private shouldOpenCircuit(): boolean {
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
  private getRecentRequests(): { timestamp: number; success: boolean }[] {
    const cutoff = Date.now() - this.config.monitoringWindow;
    return this.requestTimesWindow.filter(r => r.timestamp > cutoff);
  }
  
  /**
   * Track request in monitoring window
   */
  private trackRequest(success: boolean): void {
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
  private transitionToOpen(): void {
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
  private transitionToHalfOpen(): void {
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
  private transitionToClosed(): void {
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
  addFallbackStrategy(strategy: FallbackStrategy): void {
    this.fallbackStrategies.push(strategy);
    this.fallbackStrategies.sort((a, b) => a.priority - b.priority);
    
    logger.info(`📋 Added fallback strategy: ${strategy.constructor.name} (priority: ${strategy.priority})`);
  }
  
  /**
   * Remove fallback strategy
   */
  removeFallbackStrategy(strategyClass: any): void {
    const index = this.fallbackStrategies.findIndex(s => s instanceof strategyClass);
    if (index >= 0) {
      const removed = this.fallbackStrategies.splice(index, 1)[0];
      logger.info(`🗑️ Removed fallback strategy: ${removed.constructor.name}`);
    }
  }
  
  /**
   * Get current circuit breaker statistics
   */
  getStats(): CircuitStats {
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
  forceState(state: CircuitState): void {
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
  reset(): void {
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
  shutdown(): void {
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
export class CachedResponseFallback implements FallbackStrategy {
  priority = 1;
  
  constructor(private cache: Map<string, any>) {}
  
  canHandle(_error: Error): boolean {
    return true; // Can handle any error if cache is available
  }
  
  async execute(context: RequestContext, _error: Error): Promise<any> {
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
export class DegradedServiceFallback implements FallbackStrategy {
  priority = 2;
  
  constructor(private degradedResponse: any) {}
  
  canHandle(_error: Error): boolean {
    return true;
  }
  
  async execute(context: RequestContext, error: Error): Promise<any> {
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
export class RetryFallback implements FallbackStrategy {
  priority = 3;
  
  constructor(
    private retryFn: () => Promise<any>,
    private maxRetries: number = 3,
    private delay: number = 1000
  ) {}
  
  canHandle(error: Error): boolean {
    // Only retry on certain error types
    return !error.message.includes('timeout') && 
           !error.message.includes('validation');
  }
  
  async execute(context: RequestContext, _error: Error): Promise<any> {
    for (let i = 0; i < this.maxRetries; i++) {
      try {
        logger.info(`🔄 Retry attempt ${i + 1}/${this.maxRetries} for ${context.id}`);
        
        await new Promise(resolve => setTimeout(resolve, this.delay * (i + 1)));
        return await this.retryFn();
        
      } catch (retryError) {
        if (i === this.maxRetries - 1) {
          throw retryError;
        }
      }
    }
    
    throw new Error('All retry attempts failed');
  }
}