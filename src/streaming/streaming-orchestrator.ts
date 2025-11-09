import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import { CLIAgentOrchestrator, StreamingEvent, CLIAgentOptions } from '../cli-agents.js';
import { CLIAgentResponse } from '../types/brutalist.js';
import { SessionManager } from './session-manager.js';
import { EnhancedSSETransport } from './sse-transport.js';
import { ProgressTracker } from './progress-tracker.js';
import { CircuitBreaker, CircuitBreakerConfig, CachedResponseFallback, DegradedServiceFallback } from './circuit-breaker.js';

/**
 * Enhanced streaming CLI execution options
 */
export interface StreamingExecutionOptions extends CLIAgentOptions {
  enableProgress?: boolean;        // Enable progress tracking
  enableCircuitBreaker?: boolean;  // Enable circuit breaker protection
  fallbackResponse?: any;          // Fallback response for degraded service
  cacheResponses?: boolean;        // Enable response caching for fallbacks
  streamingTimeout?: number;       // Override default streaming timeout
  bufferConfig?: {                 // Custom buffer configuration
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
 * Advanced streaming CLI orchestrator with comprehensive real-time capabilities
 * 
 * Integrates all streaming components:
 * - Real-time output parsing with semantic boundaries
 * - Intelligent buffering with adaptive throttling  
 * - Session management with lifecycle tracking
 * - SSE transport with session isolation
 * - Progress tracking with milestone detection
 * - Circuit breaker with fallback strategies
 * - Comprehensive monitoring and analytics
 */
export class StreamingCLIOrchestrator extends EventEmitter {
  private cliOrchestrator: CLIAgentOrchestrator;
  private sessionManager: SessionManager;
  private sseTransport: EnhancedSSETransport;
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private responseCache = new Map<string, any>();
  private activeAnalyses = new Map<string, {
    sessionId: string;
    progressTracker: ProgressTracker;
    startTime: number;
    options: StreamingExecutionOptions;
  }>();
  
  private config: StreamingOrchestratorConfig;
  private metrics = {
    totalAnalyses: 0,
    successfulAnalyses: 0,
    failedAnalyses: 0,
    totalEventsSent: 0,
    totalCircuitBreakerTrips: 0,
    totalFallbacksUsed: 0,
    averageAnalysisDuration: 0
  };
  
  private cleanupTimer?: NodeJS.Timeout;
  
  constructor(config?: Partial<StreamingOrchestratorConfig>) {
    super();
    
    this.config = {
      maxConcurrentAnalyses: 10,
      defaultTimeout: 1800000, // 30 minutes
      circuitBreakerConfig: {
        failureThreshold: 5,
        recoveryTimeout: 30000,
        successThreshold: 3,
        timeout: 1800000, // 30 minutes
        monitoringWindow: 300000,
        minimumRequests: 10
      },
      enableMetrics: true,
      cleanupInterval: 300000, // 5 minutes
      ...config
    };
    
    this.cliOrchestrator = new CLIAgentOrchestrator();
    this.sessionManager = new SessionManager();
    this.sseTransport = new EnhancedSSETransport(this.sessionManager);
    
    this.setupEventHandlers();
    this.setupCircuitBreakers();
    this.startCleanupTimer();
    
    logger.info('🚀 Streaming CLI Orchestrator initialized', {
      maxConcurrentAnalyses: this.config.maxConcurrentAnalyses,
      circuitBreakerEnabled: true,
      progressTrackingEnabled: true
    });
  }
  
  /**
   * Execute CLI analysis with full streaming capabilities
   */
  async executeWithStreaming(
    analysisType: string,
    cliAgents: string[],
    systemPrompt: string,
    userPrompt: string,
    options: StreamingExecutionOptions = {}
  ): Promise<StreamingExecutionResult> {
    const sessionId = options.sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    // Check concurrent analysis limit
    if (this.activeAnalyses.size >= this.config.maxConcurrentAnalyses) {
      throw new Error(`Maximum concurrent analyses reached (${this.config.maxConcurrentAnalyses})`);
    }
    
    logger.info(`🎬 Starting streaming analysis: ${analysisType} for session ${sessionId}`, {
      agents: cliAgents,
      enableProgress: options.enableProgress,
      enableCircuitBreaker: options.enableCircuitBreaker
    });
    
    // Create session and progress tracker
    const sessionContext = this.sessionManager.createSession(sessionId, {
      analysisType,
      agents: cliAgents,
      startTime
    });
    
    const progressTracker = options.enableProgress !== false 
      ? new ProgressTracker(sessionId, analysisType)
      : undefined;
    
    // Track active analysis
    this.activeAnalyses.set(sessionId, {
      sessionId,
      progressTracker: progressTracker!,
      startTime,
      options
    });
    
    // Setup progress tracking if enabled
    if (progressTracker) {
      progressTracker.on('progress', (progressEvent) => {
        this.sessionManager.emitToSession(sessionId, {
          type: 'agent_progress',
          agent: 'system' as any,
          content: `Progress: ${Math.round(progressEvent.progress.overall * 100)}% - ${progressEvent.phase}`,
          timestamp: Date.now(),
          sessionId,
          metadata: {
            progressEvent,
            milestone: progressEvent.milestone?.name,
            estimatedCompletion: progressEvent.estimatedCompletion
          }
        });
      });
    }
    
    const analysisResult: StreamingExecutionResult = {
      success: false,
      responses: [],
      sessionId,
      analysis: {
        startTime,
        endTime: 0,
        duration: 0,
        eventsEmitted: 0,
        progressMilestones: 0,
        circuitBreakerTrips: 0,
        fallbacksUsed: 0
      },
      streaming: {
        connectedClients: 0,
        eventsSent: 0,
        averageLatency: 0,
        bufferHits: 0
      }
    };
    
    try {
      // Enhanced CLI options with streaming callbacks
      const enhancedOptions: CLIAgentOptions = {
        ...options,
        sessionId,
        onStreamingEvent: this.createStreamingEventHandler(sessionId, progressTracker, analysisResult),
        timeout: options.streamingTimeout || this.config.defaultTimeout
      };
      
      // Execute CLI agents with circuit breaker protection if enabled
      if (options.enableCircuitBreaker !== false) {
        analysisResult.responses = await this.executeWithCircuitBreaker(
          cliAgents,
          systemPrompt,
          userPrompt,
          enhancedOptions
        );
      } else {
        // Direct execution without circuit breaker
        analysisResult.responses = await this.cliOrchestrator.executeCLIAgents(
          cliAgents,
          systemPrompt,
          userPrompt,
          enhancedOptions
        );
      }
      
      analysisResult.success = analysisResult.responses.some(r => r.success);
      
      // Mark progress as complete
      if (progressTracker) {
        progressTracker.markComplete();
      }
      
      this.metrics.successfulAnalyses++;
      
    } catch (error) {
      logger.error(`💥 Streaming analysis failed for session ${sessionId}:`, error);
      
      analysisResult.success = false;
      analysisResult.errors = [error instanceof Error ? error.message : String(error)];
      
      // Handle fallback if configured
      if (options.fallbackResponse) {
        analysisResult.responses = [{
          agent: 'claude', // Use a valid agent type for fallback
          success: true,
          output: typeof options.fallbackResponse === 'string' 
            ? options.fallbackResponse 
            : JSON.stringify(options.fallbackResponse),
          executionTime: Date.now() - startTime,
          command: 'fallback',
          workingDirectory: options.workingDirectory || process.cwd(),
          exitCode: 0
        }];
        
        analysisResult.analysis.fallbacksUsed++;
        this.metrics.totalFallbacksUsed++;
      }
      
      this.metrics.failedAnalyses++;
      
    } finally {
      const endTime = Date.now();
      
      analysisResult.analysis.endTime = endTime;
      analysisResult.analysis.duration = endTime - startTime;
      
      // Get streaming stats
      const sessionConnections = this.sseTransport.getSessionConnections(sessionId);
      analysisResult.streaming.connectedClients = sessionConnections.length;
      analysisResult.streaming.eventsSent = sessionConnections.reduce((sum, conn) => sum + conn.eventsSent, 0);
      
      // Get session metrics
      const sessionStats = this.sessionManager.getSessionStats(sessionId);
      if (sessionStats) {
        analysisResult.analysis.eventsEmitted = sessionStats.eventsEmitted;
        analysisResult.streaming.bufferHits = sessionStats.bufferStats.flushCount;
      }
      
      // Update global metrics
      this.metrics.totalAnalyses++;
      this.updateAverageAnalysisDuration(analysisResult.analysis.duration);
      
      // Cleanup
      this.activeAnalyses.delete(sessionId);
      this.sessionManager.completeSession(sessionId);
      
      // Keep SSE connections open briefly for final events
      setTimeout(() => {
        this.sseTransport.disconnectSession(sessionId, 'analysis_complete');
      }, 5000);
      
      logger.info(`🏁 Streaming analysis completed: ${sessionId} (${analysisResult.analysis.duration}ms)`, {
        success: analysisResult.success,
        eventsEmitted: analysisResult.analysis.eventsEmitted,
        connectedClients: analysisResult.streaming.connectedClients
      });
    }
    
    return analysisResult;
  }
  
  /**
   * Create streaming event handler for session
   */
  private createStreamingEventHandler(
    sessionId: string,
    progressTracker: ProgressTracker | undefined,
    result: StreamingExecutionResult
  ) {
    return (event: StreamingEvent) => {
      // Process event through progress tracker
      if (progressTracker) {
        progressTracker.processEvent(event);
      }
      
      // Emit to session manager (which handles SSE transport)
      this.sessionManager.emitToSession(sessionId, event);
      
      // Update metrics
      result.analysis.eventsEmitted++;
      this.metrics.totalEventsSent++;
      
      // Emit orchestrator-level event
      this.emit('streamingEvent', { sessionId, event });
    };
  }
  
  /**
   * Execute CLI agents with circuit breaker protection
   */
  private async executeWithCircuitBreaker(
    cliAgents: string[],
    systemPrompt: string,
    userPrompt: string,
    options: CLIAgentOptions
  ): Promise<CLIAgentResponse[]> {
    const responses: CLIAgentResponse[] = [];
    
    for (const agent of cliAgents) {
      const circuitBreaker = this.circuitBreakers.get(agent);
      if (!circuitBreaker) {
        throw new Error(`No circuit breaker configured for agent: ${agent}`);
      }
      
      try {
        const response = await circuitBreaker.execute(async () => {
          return await this.cliOrchestrator.executeCLIAgent(
            agent,
            systemPrompt,
            userPrompt,
            options
          );
        }, { id: `${agent}_${options.sessionId}` });
        
        responses.push(response);
        
      } catch (error) {
        logger.warn(`Circuit breaker blocked execution for ${agent}:`, error);
        
        // Circuit breaker handled the error, continue with other agents
        responses.push({
          agent: agent as 'claude' | 'codex' | 'gemini',
          success: false,
          output: '',
          error: `Circuit breaker: ${error instanceof Error ? error.message : String(error)}`,
          executionTime: 0,
          command: 'circuit_breaker_blocked',
          workingDirectory: options.workingDirectory || process.cwd(),
          exitCode: -1
        });
        
        this.metrics.totalCircuitBreakerTrips++;
      }
    }
    
    return responses;
  }
  
  /**
   * Setup event handlers for internal components
   */
  private setupEventHandlers(): void {
    // Session manager events
    this.sessionManager.on('sessionCreated', (sessionId: string) => {
      logger.debug(`📝 Session created: ${sessionId}`);
      this.emit('sessionCreated', sessionId);
    });
    
    this.sessionManager.on('sessionCompleted', (sessionId: string) => {
      logger.debug(`✅ Session completed: ${sessionId}`);
      this.emit('sessionCompleted', sessionId);
    });
    
    // SSE transport events
    this.sseTransport.on('connectionClosed', (data: any) => {
      logger.debug(`🔌 SSE connection closed: ${data.connectionId} (${data.reason})`);
      this.emit('connectionClosed', data);
    });
    
    // Circuit breaker events
    this.on('circuitBreakerStateChanged', (data) => {
      logger.info(`🔌 Circuit breaker state changed: ${data.agent} -> ${data.state}`);
    });
  }
  
  /**
   * Setup circuit breakers for each CLI agent
   */
  private setupCircuitBreakers(): void {
    const agents = ['claude', 'codex', 'gemini'];
    
    for (const agent of agents) {
      const circuitBreaker = new CircuitBreaker(this.config.circuitBreakerConfig, `${agent}_breaker`);
      
      // Add fallback strategies
      if (this.responseCache.size > 0) {
        circuitBreaker.addFallbackStrategy(new CachedResponseFallback(this.responseCache));
      }
      
      circuitBreaker.addFallbackStrategy(new DegradedServiceFallback({
        agent,
        success: false,
        output: `${agent.toUpperCase()} is temporarily unavailable. This is a degraded response.`,
        error: 'Circuit breaker fallback',
        executionTime: 0,
        command: 'fallback',
        workingDirectory: process.cwd(),
        exitCode: -1
      }));
      
      // Setup event forwarding
      circuitBreaker.on('stateChanged', (data) => {
        this.emit('circuitBreakerStateChanged', { agent, ...data });
      });
      
      circuitBreaker.on('fallbackSuccess', (data) => {
        this.metrics.totalFallbacksUsed++;
        this.emit('fallbackUsed', { agent, ...data });
      });
      
      this.circuitBreakers.set(agent, circuitBreaker);
      
      logger.debug(`🔌 Circuit breaker configured for ${agent}`);
    }
  }
  
  /**
   * Update average analysis duration metric
   */
  private updateAverageAnalysisDuration(duration: number): void {
    const totalAnalyses = this.metrics.totalAnalyses;
    const currentAverage = this.metrics.averageAnalysisDuration;
    
    // Calculate new average using online algorithm
    this.metrics.averageAnalysisDuration = 
      (currentAverage * (totalAnalyses - 1) + duration) / totalAnalyses;
  }
  
  /**
   * Start cleanup timer for stale sessions and cache
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup();
    }, this.config.cleanupInterval);
    // Allow Node.js to exit if this is the only active timer
    this.cleanupTimer.unref();
  }
  
  /**
   * Perform periodic cleanup
   */
  private performCleanup(): void {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000; // 30 minutes
    
    // Clean up stale analyses
    for (const [sessionId, analysis] of this.activeAnalyses) {
      if (now - analysis.startTime > staleThreshold) {
        logger.warn(`🧹 Cleaning up stale analysis: ${sessionId}`);
        this.activeAnalyses.delete(sessionId);
        this.sessionManager.completeSession(sessionId);
        this.sseTransport.disconnectSession(sessionId, 'cleanup_stale');
      }
    }
    
    // Clean up response cache (keep last 100 entries)
    if (this.responseCache.size > 100) {
      const entries = Array.from(this.responseCache.entries());
      entries.splice(0, entries.length - 100);
      this.responseCache.clear();
      for (const [key, value] of entries) {
        this.responseCache.set(key, value);
      }
    }
    
    logger.debug(`🧹 Cleanup completed: ${this.activeAnalyses.size} active analyses, ${this.responseCache.size} cached responses`);
  }
  
  /**
   * Get orchestrator statistics
   */
  getStats() {
    const circuitBreakerStats: Record<string, any> = {};
    for (const [agent, breaker] of this.circuitBreakers) {
      circuitBreakerStats[agent] = breaker.getStats();
    }
    
    return {
      metrics: { ...this.metrics },
      activeAnalyses: this.activeAnalyses.size,
      sessionManager: this.sessionManager.getGlobalStats(),
      sseTransport: this.sseTransport.getStats(),
      circuitBreakers: circuitBreakerStats
    };
  }
  
  /**
   * Get active session IDs
   */
  getActiveSessions(): string[] {
    return Array.from(this.activeAnalyses.keys());
  }
  
  /**
   * Force disconnect session
   */
  disconnectSession(sessionId: string, reason = 'forced_disconnect'): void {
    logger.info(`🔌 Force disconnecting session: ${sessionId}`);
    
    this.activeAnalyses.delete(sessionId);
    this.sessionManager.completeSession(sessionId);
    this.sseTransport.disconnectSession(sessionId, reason);
  }
  
  /**
   * Reset circuit breaker for specific agent
   */
  resetCircuitBreaker(agent: string): void {
    const circuitBreaker = this.circuitBreakers.get(agent);
    if (circuitBreaker) {
      circuitBreaker.reset();
      logger.info(`🔄 Circuit breaker reset for ${agent}`);
    }
  }
  
  /**
   * Add response to cache for fallback strategies
   */
  cacheResponse(key: string, response: any): void {
    this.responseCache.set(key, response);
    logger.debug(`💾 Cached response: ${key}`);
  }
  
  /**
   * Shutdown orchestrator and cleanup resources
   */
  shutdown(): void {
    logger.info('🛑 Shutting down Streaming CLI Orchestrator');
    
    // Stop cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    // Disconnect all sessions
    for (const sessionId of this.activeAnalyses.keys()) {
      this.disconnectSession(sessionId, 'orchestrator_shutdown');
    }
    
    // Shutdown components
    this.sseTransport.shutdown();
    this.sessionManager.shutdown();
    
    // Shutdown circuit breakers
    for (const [agent, breaker] of this.circuitBreakers) {
      breaker.shutdown();
    }
    
    this.removeAllListeners();
    
    logger.info('✅ Streaming CLI Orchestrator shutdown complete');
  }
}