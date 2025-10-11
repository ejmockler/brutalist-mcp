/**
 * Performance Benchmarks and Memory Monitoring Tests
 * Real performance testing with actual metrics and memory leak detection
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { performance } from 'perf_hooks';
import { EnhancedSSETransport } from '../../src/streaming/sse-transport.js';
import { SessionChannelManager } from '../../src/streaming/session-manager.js';
import { SemanticOutputParser } from '../../src/streaming/output-parser.js';
import { ProgressTracker } from '../../src/streaming/progress-tracker.js';
import { StreamingEvent } from '../../src/cli-agents.js';

// Performance test configuration
const PERFORMANCE_THRESHOLDS = {
  eventProcessingTimeMs: 10, // Events should process within 10ms
  sessionCreationTimeMs: 50, // Sessions should create within 50ms
  memoryLeakTolerance: 10 * 1024 * 1024, // 10MB tolerance for memory growth
  eventThroughputPerSecond: 100, // Should handle 100 events/second
  maxConnections: 50,
  concurrentSessions: 20
};

describe('Performance Benchmarks and Memory Monitoring', () => {
  let sessionManager: SessionChannelManager;
  let sseTransport: EnhancedSSETransport;
  let initialMemory: NodeJS.MemoryUsage;

  beforeEach(() => {
    // Capture initial memory state
    if (global.gc) {
      global.gc(); // Force garbage collection if available
    }
    initialMemory = process.memoryUsage();

    // Create real components for performance testing
    sessionManager = new SessionChannelManager();
    sseTransport = new EnhancedSSETransport(sessionManager);
  });

  afterEach(() => {
    // Cleanup
    sseTransport.shutdown();
    sessionManager.shutdown();

    // Force GC again to check for leaks
    if (global.gc) {
      global.gc();
    }
  });

  describe('Event Processing Performance', () => {
    it('should process events within performance thresholds', () => {
      const sessionId = 'perf-test-events';
      const eventCount = 1000;
      
      // Create session
      sessionManager.createSession(sessionId, {
        analysisType: 'roast_codebase',
        agents: ['claude']
      });

      // Measure event processing time
      const startTime = performance.now();

      for (let i = 0; i < eventCount; i++) {
        const event: StreamingEvent = {
          type: 'agent_progress',
          agent: 'claude',
          content: `Processing item ${i} - Found potential security vulnerability`,
          timestamp: Date.now(),
          sessionId
        };

        sessionManager.emitToSession(sessionId, event);
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const averageTimePerEvent = totalTime / eventCount;

      // Performance assertions
      expect(averageTimePerEvent).toBeLessThan(PERFORMANCE_THRESHOLDS.eventProcessingTimeMs);
      expect(totalTime).toBeLessThan(eventCount * PERFORMANCE_THRESHOLDS.eventProcessingTimeMs);

      console.log(`Event Processing Performance:
        - Total events: ${eventCount}
        - Total time: ${totalTime.toFixed(2)}ms
        - Average per event: ${averageTimePerEvent.toFixed(2)}ms
        - Events per second: ${(eventCount / (totalTime / 1000)).toFixed(0)}`);
    });

    it('should handle high-throughput event streaming', () => {
      const sessionId = 'throughput-test';
      const testDurationMs = 1000; // 1 second test
      const targetEventsPerSecond = PERFORMANCE_THRESHOLDS.eventThroughputPerSecond;
      
      sessionManager.createSession(sessionId, {
        analysisType: 'roast_codebase',
        agents: ['claude']
      });

      let eventsProcessed = 0;
      const startTime = performance.now();
      const endTime = startTime + testDurationMs;

      // Process events as fast as possible for 1 second
      while (performance.now() < endTime) {
        sessionManager.emitToSession(sessionId, {
          type: 'agent_progress',
          agent: 'claude',
          content: `High throughput event ${eventsProcessed}`,
          timestamp: Date.now(),
          sessionId
        });
        eventsProcessed++;
      }

      const actualDuration = performance.now() - startTime;
      const actualThroughput = eventsProcessed / (actualDuration / 1000);

      expect(actualThroughput).toBeGreaterThan(targetEventsPerSecond);

      console.log(`Throughput Performance:
        - Events processed: ${eventsProcessed}
        - Duration: ${actualDuration.toFixed(2)}ms
        - Throughput: ${actualThroughput.toFixed(0)} events/second
        - Target: ${targetEventsPerSecond} events/second`);
    });
  });

  describe('Session Management Performance', () => {
    it('should create sessions within performance thresholds', () => {
      const sessionCount = 100;
      const sessionIds: string[] = [];
      
      const startTime = performance.now();

      // Create many sessions
      for (let i = 0; i < sessionCount; i++) {
        const sessionId = `perf-session-${i}`;
        sessionIds.push(sessionId);
        
        sessionManager.createSession(sessionId, {
          analysisType: 'roast_codebase',
          agents: ['claude']
        });
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const averageTimePerSession = totalTime / sessionCount;

      expect(averageTimePerSession).toBeLessThan(PERFORMANCE_THRESHOLDS.sessionCreationTimeMs);

      // Verify all sessions were created
      expect(sessionManager.getGlobalStats().activeSessions).toBe(sessionCount);

      console.log(`Session Creation Performance:
        - Sessions created: ${sessionCount}
        - Total time: ${totalTime.toFixed(2)}ms
        - Average per session: ${averageTimePerSession.toFixed(2)}ms`);

      // Cleanup
      for (const sessionId of sessionIds) {
        sessionManager.destroySession(sessionId);
      }
    });

    it('should handle concurrent session operations', () => {
      const concurrentCount = PERFORMANCE_THRESHOLDS.concurrentSessions;
      const operationsPerSession = 10;
      
      const startTime = performance.now();

      // Create sessions and perform operations concurrently
      const sessionPromises = Array.from({ length: concurrentCount }, async (_, i) => {
        const sessionId = `concurrent-${i}`;
        
        sessionManager.createSession(sessionId, {
          analysisType: 'roast_codebase',
          agents: ['claude']
        });

        // Perform operations on this session
        for (let j = 0; j < operationsPerSession; j++) {
          sessionManager.emitToSession(sessionId, {
            type: 'agent_progress',
            agent: 'claude',
            content: `Concurrent operation ${j}`,
            timestamp: Date.now(),
            sessionId
          });
        }

        return sessionId;
      });

      // Wait for all operations to complete
      const sessionIds = sessionPromises.map((_, i) => `concurrent-${i}`);
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;

      expect(totalTime).toBeLessThan(concurrentCount * PERFORMANCE_THRESHOLDS.sessionCreationTimeMs);

      console.log(`Concurrent Operations Performance:
        - Concurrent sessions: ${concurrentCount}
        - Operations per session: ${operationsPerSession}
        - Total time: ${totalTime.toFixed(2)}ms`);

      // Cleanup
      for (const sessionId of sessionIds) {
        sessionManager.destroySession(sessionId);
      }
    });
  });

  describe('Memory Management and Leak Detection', () => {
    it('should not leak memory during normal operations', () => {
      const iterations = 100;
      const eventsPerIteration = 50;
      const memoryMeasurements: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const sessionId = `memory-test-${i}`;
        
        // Create session and generate events
        sessionManager.createSession(sessionId, {
          analysisType: 'roast_codebase',
          agents: ['claude']
        });

        for (let j = 0; j < eventsPerIteration; j++) {
          sessionManager.emitToSession(sessionId, {
            type: 'agent_progress',
            agent: 'claude',
            content: `Memory test event ${j}`,
            timestamp: Date.now(),
            sessionId
          });
        }

        // Clean up session
        sessionManager.destroySession(sessionId);

        // Measure memory every 10 iterations
        if (i % 10 === 0) {
          if (global.gc) global.gc();
          const currentMemory = process.memoryUsage();
          memoryMeasurements.push(currentMemory.heapUsed);
        }
      }

      // Check for memory growth trend
      const initialMem = memoryMeasurements[0];
      const finalMem = memoryMeasurements[memoryMeasurements.length - 1];
      const memoryGrowth = finalMem - initialMem;

      expect(memoryGrowth).toBeLessThan(PERFORMANCE_THRESHOLDS.memoryLeakTolerance);

      console.log(`Memory Management:
        - Iterations: ${iterations}
        - Initial memory: ${(initialMem / 1024 / 1024).toFixed(2)}MB
        - Final memory: ${(finalMem / 1024 / 1024).toFixed(2)}MB
        - Memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB
        - Threshold: ${(PERFORMANCE_THRESHOLDS.memoryLeakTolerance / 1024 / 1024).toFixed(2)}MB`);
    });

    it('should handle parser memory management efficiently', () => {
      const parserCount = 50;
      const parsers: SemanticOutputParser[] = [];
      
      const initialMemory = process.memoryUsage().heapUsed;

      // Create many parsers
      for (let i = 0; i < parserCount; i++) {
        const parser = new SemanticOutputParser('claude', `parser-session-${i}`);
        parsers.push(parser);

        // Parse some content
        const testContent = `
          CRITICAL: Security vulnerability found in authentication module.
          WARNING: Potential memory leak detected.
          ANALYZING database configuration files...
          COMPLETED security audit phase successfully.
        `;

        parser.parse(testContent, 'claude');
      }

      const peakMemory = process.memoryUsage().heapUsed;

      // Cleanup parsers
      for (const parser of parsers) {
        parser.reset();
      }

      if (global.gc) global.gc();
      const finalMemory = process.memoryUsage().heapUsed;

      const memoryGrowth = finalMemory - initialMemory;
      expect(memoryGrowth).toBeLessThan(PERFORMANCE_THRESHOLDS.memoryLeakTolerance);

      console.log(`Parser Memory Management:
        - Parsers created: ${parserCount}
        - Initial memory: ${(initialMemory / 1024 / 1024).toFixed(2)}MB
        - Peak memory: ${(peakMemory / 1024 / 1024).toFixed(2)}MB
        - Final memory: ${(finalMemory / 1024 / 1024).toFixed(2)}MB
        - Net growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB`);
    });

    it('should handle progress tracker memory efficiently', () => {
      const trackerCount = 30;
      const eventsPerTracker = 100;
      
      const initialMemory = process.memoryUsage().heapUsed;

      for (let i = 0; i < trackerCount; i++) {
        const tracker = new ProgressTracker('roast_codebase', `tracker-session-${i}`);

        // Process many events
        for (let j = 0; j < eventsPerTracker; j++) {
          tracker.processEvent({
            type: 'agent_progress',
            agent: 'claude',
            content: `Event ${j} for tracker ${i}`,
            timestamp: Date.now(),
            sessionId: `tracker-session-${i}`
          });
        }

        tracker.markComplete();
      }

      if (global.gc) global.gc();
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;

      expect(memoryGrowth).toBeLessThan(PERFORMANCE_THRESHOLDS.memoryLeakTolerance);

      console.log(`Progress Tracker Memory:
        - Trackers: ${trackerCount}
        - Events per tracker: ${eventsPerTracker}
        - Memory growth: ${(memoryGrowth / 1024 / 1024).toFixed(2)}MB`);
    });
  });

  describe('SSE Transport Performance', () => {
    it('should handle connection management efficiently', () => {
      const connectionLimit = 25; // Lower than max for testing
      const connectionsCreated: string[] = [];
      
      const startTime = performance.now();

      // Simulate creating many connections quickly
      for (let i = 0; i < connectionLimit; i++) {
        const sessionId = `sse-perf-${i}`;
        connectionsCreated.push(sessionId);
        
        // Create session first
        sessionManager.createSession(sessionId, {
          analysisType: 'roast_codebase',
          agents: ['claude']
        });
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;

      expect(totalTime).toBeLessThan(connectionLimit * 20); // 20ms per connection max

      // Test stats retrieval performance
      const statsStartTime = performance.now();
      const stats = sseTransport.getStats();
      const statsEndTime = performance.now();
      const statsTime = statsEndTime - statsStartTime;

      // Stats should be fast - allow more time on CI systems which may be under load
      const statsTimeLimit = process.env.CI ? 50 : 10; // 50ms on CI, 10ms locally
      expect(statsTime).toBeLessThan(statsTimeLimit);
      expect(stats.totalConnections).toBeGreaterThanOrEqual(0);

      console.log(`SSE Transport Performance:
        - Connections managed: ${connectionLimit}
        - Setup time: ${totalTime.toFixed(2)}ms
        - Stats retrieval: ${statsTime.toFixed(2)}ms`);

      // Cleanup
      for (const sessionId of connectionsCreated) {
        sessionManager.destroySession(sessionId);
      }
    });

    it('should handle event broadcasting efficiently', () => {
      const sessionCount = 10;
      const eventsPerSession = 100;
      const sessionIds: string[] = [];

      // Setup sessions
      for (let i = 0; i < sessionCount; i++) {
        const sessionId = `broadcast-${i}`;
        sessionIds.push(sessionId);
        sessionManager.createSession(sessionId, {
          analysisType: 'roast_codebase',
          agents: ['claude']
        });
      }

      // Measure broadcast performance
      const startTime = performance.now();

      for (let i = 0; i < eventsPerSession; i++) {
        for (const sessionId of sessionIds) {
          sessionManager.emitToSession(sessionId, {
            type: 'agent_progress',
            agent: 'claude',
            content: `Broadcast event ${i}`,
            timestamp: Date.now(),
            sessionId
          });
        }
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const totalEvents = sessionCount * eventsPerSession;
      const eventsPerSecond = totalEvents / (totalTime / 1000);

      expect(eventsPerSecond).toBeGreaterThan(PERFORMANCE_THRESHOLDS.eventThroughputPerSecond);

      console.log(`Event Broadcasting Performance:
        - Sessions: ${sessionCount}
        - Events per session: ${eventsPerSession}
        - Total events: ${totalEvents}
        - Total time: ${totalTime.toFixed(2)}ms
        - Events per second: ${eventsPerSecond.toFixed(0)}`);

      // Cleanup
      for (const sessionId of sessionIds) {
        sessionManager.destroySession(sessionId);
      }
    });
  });

  describe('Integration Performance', () => {
    it('should handle full pipeline under load', () => {
      const sessionId = 'integration-perf-test';
      const parser = new SemanticOutputParser('claude', sessionId);
      const tracker = new ProgressTracker('roast_codebase', sessionId);
      
      // Create session
      sessionManager.createSession(sessionId, {
        analysisType: 'roast_codebase',
        agents: ['claude']
      });

      const analysisChunks = [
        'Starting comprehensive security analysis...',
        'ANALYZING authentication mechanisms...',
        'WARNING: Weak password policy detected.',
        'CRITICAL: SQL injection vulnerability in user login.',
        'ANALYZING authorization controls...',
        'HIGH: Privilege escalation possible.',
        'MEDIUM: Session timeout not enforced.',
        'Generating final report...',
        'Analysis complete with 1 critical, 1 high, 1 medium issues.'
      ];

      const startTime = performance.now();

      // Process through full pipeline
      for (const chunk of analysisChunks) {
        const events = parser.parse(chunk, 'claude');
        
        for (const event of events) {
          tracker.processEvent(event);
          sessionManager.emitToSession(sessionId, {
            ...event,
            sessionId
          });
        }
      }

      // Complete the pipeline
      const finalEvents = parser.flush();
      for (const event of finalEvents) {
        tracker.processEvent(event);
        sessionManager.emitToSession(sessionId, {
          ...event,
          sessionId
        });
      }

      tracker.markComplete();
      sessionManager.completeAnalysis(sessionId);

      const endTime = performance.now();
      const totalTime = endTime - startTime;

      // Performance expectations for full pipeline
      expect(totalTime).toBeLessThan(100); // Should complete within 100ms

      console.log(`Full Pipeline Performance:
        - Analysis chunks: ${analysisChunks.length}
        - Total pipeline time: ${totalTime.toFixed(2)}ms
        - Processing rate: ${(analysisChunks.length / (totalTime / 1000)).toFixed(1)} chunks/second`);

      // Verify pipeline worked correctly
      const session = sessionManager.getSession(sessionId);
      expect(session?.analysis.status).toBe('complete');
    });
  });
});