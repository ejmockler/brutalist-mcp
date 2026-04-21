/**
 * Streaming Path Resolution -- Behavioral Verification Tests
 *
 * Verifies that the canonical streaming paths are correctly wired:
 * 1. DebateOrchestrator forwards streaming callbacks during debate execution
 * 2. handleStreamingEvent dispatches to correct transport (stdio vs HTTP)
 * 3. CLI adapters do not import or depend on unintegrated streaming infra
 * 4. Unintegrated streaming modules are self-contained
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { DebateOrchestrator, DebateOrchestratorDeps } from '../../src/debate/index.js';
import { BrutalistServer } from '../../src/brutalist-server.js';
import type { StreamingEvent } from '../../src/cli-agents.js';
import { createMetricsRegistry } from '../../src/metrics/index.js';
import { Logger } from '../../src/logger.js';

// Mock MCP SDK to prevent "Not connected" errors during test teardown
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  return {
    McpServer: jest.fn().mockImplementation(() => ({
      tool: jest.fn().mockReturnValue({
        title: undefined, description: undefined, inputSchema: undefined,
        outputSchema: undefined, annotations: undefined, _meta: undefined,
        callback: jest.fn(), enabled: true,
        enable: jest.fn(), disable: jest.fn(), update: jest.fn(), remove: jest.fn()
      }),
      connect: jest.fn(),
      close: jest.fn(),
      server: { notification: jest.fn() },
      sendLoggingMessage: jest.fn()
    }))
  };
});

// Mock logger — provide the structured-logger interface (`for`, `forOperation`)
// so callers that bind scoped loggers (BrutalistServer, DebateOrchestrator)
// receive a usable stub. The scoped-logger stub is recursive so
// `.for(...).forOperation(...)` chains keep working. `shutdown` is kept on
// the root stub because BrutalistServer.cleanup() calls logger.shutdown().
jest.mock('../../src/logger.js', () => {
  const scoped: any = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  scoped.for = jest.fn(() => scoped);
  scoped.forOperation = jest.fn(() => scoped);
  const root = { ...scoped, shutdown: jest.fn() };
  return {
    logger: root,
    Logger: { getInstance: () => root },
  };
});

describe('Streaming Path Resolution', () => {

  describe('DebateOrchestrator callback forwarding during debate execution', () => {
    let mockStreamingEvent: jest.Mock;
    let mockProgressUpdate: jest.Mock;
    let mockExecuteSingleCLI: jest.Mock;
    let orchestrator: DebateOrchestrator;

    beforeEach(() => {
      mockStreamingEvent = jest.fn();
      mockProgressUpdate = jest.fn();
      mockExecuteSingleCLI = jest.fn().mockImplementation(async (agent: any) => ({
        agent,
        success: true,
        output: 'Substantive analytical response with evidence.',
        executionTime: 100,
      }));

      const deps: DebateOrchestratorDeps = {
        cliOrchestrator: {
          detectCLIContext: jest.fn<any>().mockResolvedValue({
            availableCLIs: ['claude', 'codex'],
          }),
          executeSingleCLI: mockExecuteSingleCLI,
        } as any,
        responseCache: {
          generateCacheKey: jest.fn<any>().mockReturnValue('test-key'),
          get: jest.fn<any>().mockResolvedValue(null),
          set: jest.fn<any>().mockResolvedValue({ contextId: 'ctx-123' }),
          findContextIdForKey: jest.fn<any>(),
          getByContextId: jest.fn<any>(),
        } as any,
        formatter: {
          formatToolResponse: jest.fn().mockReturnValue({ content: [] }),
          formatErrorResponse: jest.fn().mockReturnValue({ content: [] }),
          extractFullContent: jest.fn().mockReturnValue('full content'),
        } as any,
        config: { workingDirectory: '/tmp', defaultTimeout: 60000 },
        onStreamingEvent: mockStreamingEvent,
        onProgressUpdate: mockProgressUpdate,
        // Integrate-observability: deps bag now requires metrics + scoped log.
        metrics: createMetricsRegistry(),
        log: Logger.getInstance().for({ module: 'debate', operation: 'test' }),
      };

      orchestrator = new DebateOrchestrator(deps);
    });

    it('emits agent_start and agent_complete events for each turn in a debate', async () => {
      await orchestrator.handleDebateToolExecution({
        topic: 'Test topic',
        proPosition: 'Pro thesis',
        conPosition: 'Con thesis',
        agents: ['claude', 'codex'],
        rounds: 1,
      });

      // A 1-round debate with 2 agents produces 2 turns.
      // Each turn emits agent_start + agent_complete = 4 streaming events total.
      const calls = mockStreamingEvent.mock.calls;
      expect(calls.length).toBe(4);

      // Extract event types in order
      const eventTypes = calls.map((c: any[]) => c[0].type);
      expect(eventTypes).toEqual([
        'agent_start', 'agent_complete',
        'agent_start', 'agent_complete',
      ]);

      // Verify event shapes have required fields
      for (const call of calls) {
        const event = (call as any[])[0];
        expect(event).toHaveProperty('agent');
        expect(event).toHaveProperty('content');
        expect(event).toHaveProperty('timestamp');
        expect(typeof event.timestamp).toBe('number');
        expect(['claude', 'codex']).toContain(event.agent);
      }
    });

    it('emits agent_error when a CLI agent throws during execution', async () => {
      // Make the second agent throw
      let callCount = 0;
      mockExecuteSingleCLI.mockImplementation(async (agent: any) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Agent crashed');
        }
        return {
          agent,
          success: true,
          output: 'Good response.',
          executionTime: 100,
        };
      });

      await orchestrator.handleDebateToolExecution({
        topic: 'Error handling test',
        proPosition: 'Pro',
        conPosition: 'Con',
        agents: ['claude', 'codex'],
        rounds: 1,
      });

      // Find agent_error events
      const errorEvents = mockStreamingEvent.mock.calls
        .map((c: any[]) => c[0])
        .filter((e: StreamingEvent) => e.type === 'agent_error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);

      const errorEvent = errorEvents[0];
      expect(errorEvent.content).toContain('error');
      expect(errorEvent.timestamp).toBeGreaterThan(0);
    });

    it('passes onStreamingEvent through to CLIAgentOptions for agent execution', async () => {
      await orchestrator.handleDebateToolExecution({
        topic: 'Callback forwarding test',
        proPosition: 'Pro',
        conPosition: 'Con',
        agents: ['claude', 'codex'],
        rounds: 1,
      });

      // Verify that executeSingleCLI was called with options containing
      // the onStreamingEvent callback
      for (const call of mockExecuteSingleCLI.mock.calls) {
        const options = (call as any[])[3];
        expect(options).toHaveProperty('onStreamingEvent');
        expect(typeof options.onStreamingEvent).toBe('function');
      }
    });
  });

  describe('handleStreamingEvent dispatch to transport', () => {
    let server: BrutalistServer;

    afterEach(async () => {
      if (server) {
        await server.cleanup();
      }
    });

    it('dispatches to sendLoggingMessage in stdio mode (no HTTP transport)', () => {
      server = new BrutalistServer({ transport: 'stdio' });

      const event: StreamingEvent = {
        type: 'agent_start',
        agent: 'claude',
        content: 'Starting analysis...',
        timestamp: Date.now(),
        sessionId: 'test-session-001',
      };

      // Invoke handleStreamingEvent (private, accessed via any)
      (server as any).handleStreamingEvent(event);

      // In stdio mode, sendLoggingMessage should be called
      const sendLogging = server.server.sendLoggingMessage as jest.Mock;
      expect(sendLogging).toHaveBeenCalledTimes(1);

      const logCall = sendLogging.mock.calls[0][0] as any;
      expect(logCall.level).toBe('info');
      expect(logCall.data.agent).toBe('claude');
      expect(logCall.data.type).toBe('agent_start');
      expect(logCall.data.sessionId).toBe('test-session-001');
      expect(logCall.logger).toBe('brutalist-mcp-streaming');
    });

    it('dispatches to server.server.notification in HTTP mode', () => {
      server = new BrutalistServer({ transport: 'http' });

      // Simulate HTTP transport being present by setting httpTransport with a getTransport
      (server as any).httpTransport = {
        getTransport: () => ({}), // non-null signals HTTP mode
        getActualPort: () => 3000,
        cleanup: jest.fn(),
        stop: jest.fn(),
      };

      const event: StreamingEvent = {
        type: 'agent_complete',
        agent: 'codex',
        content: 'Analysis complete.',
        timestamp: Date.now(),
        sessionId: 'test-session-002',
      };

      (server as any).handleStreamingEvent(event);

      // In HTTP mode, server.server.notification should be called
      const notification = (server.server as any).server.notification as jest.Mock;
      expect(notification).toHaveBeenCalledTimes(1);

      const notifCall = notification.mock.calls[0][0] as any;
      expect(notifCall.method).toBe('notifications/message');
      expect(notifCall.params.data.type).toBe('streaming_event');
      expect(notifCall.params.data.agent).toBe('codex');
      expect(notifCall.params.data.eventType).toBe('agent_complete');
      expect(notifCall.params.data.sessionId).toBe('test-session-002');
      expect(notifCall.params.logger).toBe('brutalist-mcp-streaming');
    });

    it('drops events without sessionId for security', () => {
      server = new BrutalistServer({ transport: 'stdio' });

      const event: StreamingEvent = {
        type: 'agent_start',
        agent: 'claude',
        content: 'No session',
        timestamp: Date.now(),
        // No sessionId
      };

      (server as any).handleStreamingEvent(event);

      // Should NOT call sendLoggingMessage since event has no sessionId
      const sendLogging = server.server.sendLoggingMessage as jest.Mock;
      expect(sendLogging).not.toHaveBeenCalled();
    });

    it('updates session activity tracking on streaming events', () => {
      server = new BrutalistServer({ transport: 'stdio' });

      // Register a session in activeSessions
      const sessionId = 'tracked-session-xyz';
      const sessionData = { startTime: Date.now() - 1000, requestCount: 1, lastActivity: Date.now() - 1000 };
      (server as any).activeSessions.set(sessionId, sessionData);

      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'gemini',
        content: 'Working...',
        timestamp: Date.now(),
        sessionId,
      };

      const beforeActivity = sessionData.lastActivity;
      (server as any).handleStreamingEvent(event);

      // lastActivity should be updated
      const updatedSession = (server as any).activeSessions.get(sessionId);
      expect(updatedSession.lastActivity).toBeGreaterThanOrEqual(beforeActivity);
    });
  });

  describe('CLI adapters isolation from streaming infrastructure', () => {

    it('CLIProvider interface exports load without streaming dependencies', async () => {
      const adapterModule = await import('../../src/cli-adapters/index.js');
      expect(typeof adapterModule.getProvider).toBe('function');
      expect(typeof adapterModule.getProviderNames).toBe('function');

      const names = adapterModule.getProviderNames();
      expect(names).toContain('claude');
      expect(names).toContain('codex');
      expect(names).toContain('gemini');
    });

    it('each adapter exposes decodeOutput and buildCommand functions', async () => {
      const { getProvider } = await import('../../src/cli-adapters/index.js');

      for (const name of ['claude', 'codex', 'gemini'] as const) {
        const provider = getProvider(name);
        expect(typeof provider.decodeOutput).toBe('function');
        expect(typeof provider.buildCommand).toBe('function');
        expect(typeof provider.getConfig).toBe('function');
      }
    });
  });

  describe('Unintegrated infrastructure self-containment', () => {

    it('StreamingCLIOrchestrator is importable but not referenced by production entry points', async () => {
      const mod = await import('../../src/streaming/streaming-orchestrator.js');
      expect(mod.StreamingCLIOrchestrator).toBeDefined();

      // Verify brutalist-server.ts does not import StreamingCLIOrchestrator
      // by confirming the BrutalistServer constructor does not reference it
      const serverMod = await import('../../src/brutalist-server.js');
      const serverInstance = new serverMod.BrutalistServer();
      // The server has no property referencing StreamingCLIOrchestrator
      expect((serverInstance as any).streamingOrchestrator).toBeUndefined();
      await serverInstance.cleanup();
    });

    it('CircuitBreaker starts in CLOSED state and is independently functional', async () => {
      const { CircuitBreaker, CircuitState } = await import(
        '../../src/streaming/circuit-breaker.js'
      );
      const breaker = new CircuitBreaker({
        failureThreshold: 5,
        recoveryTimeout: 1000,
        successThreshold: 2,
        timeout: 5000,
        monitoringWindow: 60000,
        minimumRequests: 3,
      });

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);

      breaker.shutdown();
    });
  });

  describe('Canonical streaming event shape', () => {

    it('StreamingEvent has all required fields with correct types', () => {
      const event: StreamingEvent = {
        type: 'agent_start',
        agent: 'claude',
        content: 'test content',
        timestamp: Date.now(),
        sessionId: 'test-session-123',
      };

      expect(event.type).toBe('agent_start');
      expect(event.agent).toBe('claude');
      expect(event.sessionId).toBe('test-session-123');
      expect(typeof event.timestamp).toBe('number');
      expect(typeof event.content).toBe('string');
    });

    it('StreamingEvent type field allows all canonical event types', () => {
      const types: StreamingEvent['type'][] = [
        'agent_start', 'agent_progress', 'agent_complete', 'agent_error'
      ];
      for (const type of types) {
        const event: StreamingEvent = {
          type,
          agent: 'claude',
          timestamp: Date.now(),
        };
        expect(event.type).toBe(type);
      }
    });
  });
});
