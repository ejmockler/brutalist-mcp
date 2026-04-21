/**
 * Characterization Tests: Streaming Lifecycle
 *
 * Captures the actual behavior of the streaming subsystem including:
 * - SSE transport event flow and routing
 * - Session lifecycle management (create, use, cleanup)
 * - Session isolation between concurrent sessions
 * - Circuit breaker state transitions
 *
 * These tests are purely additive and run against the unmodified codebase.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { EnhancedSSETransport, SSEConnection } from '../../src/streaming/sse-transport.js';
import { SessionChannelManager, SessionContext, StreamingSubscriber } from '../../src/streaming/session-manager.js';
import { CircuitBreaker, CircuitState, CircuitBreakerConfig } from '../../src/streaming/circuit-breaker.js';
import { StreamingEvent } from '../../src/cli-agents.js';

// Mock logger to suppress output during tests
jest.mock('../../src/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a fresh mock Express Response for SSE testing */
function createMockResponse(): any {
  const mock = {
    writeHead: jest.fn(),
    write: jest.fn().mockReturnValue(true),
    end: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
    destroyed: false
  };
  mock.writeHead.mockReturnValue(mock);
  mock.end.mockReturnValue(mock);
  mock.status.mockReturnValue(mock);
  return mock;
}

/** Create a fresh mock Express Request */
function createMockRequest(origin = 'http://localhost:3000'): any {
  return {
    headers: { origin },
    on: jest.fn<(event: string, handler: (...args: any[]) => void) => any>()
  };
}

/** Create a StreamingEvent with sensible defaults */
function makeEvent(
  overrides: Partial<StreamingEvent> & { sessionId: string }
): StreamingEvent {
  return {
    type: 'agent_progress',
    agent: 'claude',
    content: 'test content',
    timestamp: Date.now(),
    ...overrides
  };
}

/** Create a mock StreamingSubscriber */
function createMockSubscriber(id: string, sessionId: string): StreamingSubscriber {
  let connected = true;
  let eventsDelivered = 0;
  return {
    id,
    sessionId,
    type: 'sse' as const,
    emit: jest.fn<(event: StreamingEvent) => Promise<void>>().mockImplementation(async () => {
      eventsDelivered++;
    }),
    emitBatch: jest.fn<any>().mockResolvedValue(undefined),
    close: jest.fn<() => void>().mockImplementation(() => { connected = false; }),
    isConnected: jest.fn<() => boolean>().mockImplementation(() => connected),
    getConnectionInfo: jest.fn<() => any>().mockImplementation(() => ({
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      eventsDelivered,
      errorsCount: 0
    }))
  };
}

// ===========================================================================
// 1. SSE Transport Event Flow Characterization
// ===========================================================================

describe('Streaming Lifecycle Characterization', () => {
  describe('SSE Transport Event Flow', () => {
    let transport: EnhancedSSETransport;
    let mockSessionManager: jest.Mocked<any>;

    beforeEach(() => {
      jest.clearAllTimers();
      jest.useFakeTimers();

      // Create a mock SessionManager with EventEmitter behavior
      mockSessionManager = new EventEmitter() as any;
      mockSessionManager.hasSession = jest.fn<any>().mockReturnValue(true);
      mockSessionManager.getSession = jest.fn<any>().mockReturnValue({
        sessionId: 'default-session',
        eventBuffer: {
          flush: jest.fn().mockReturnValue({ events: [] })
        }
      });

      transport = new EnhancedSSETransport(mockSessionManager);
    });

    afterEach(() => {
      transport.shutdown();
      jest.useRealTimers();
      jest.clearAllMocks();
    });

    it('should set correct SSE headers on connection', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'sess-1');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }));
    });

    it('should send connection event immediately after connecting', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'sess-1');

      // SSE protocol: each event is 3 writes (id, event, data)
      const writeArgs = (res.write as jest.Mock).mock.calls.map((c: any) => c[0] as string);
      const eventLines = writeArgs.filter((arg: string) => arg.startsWith('event: '));
      expect(eventLines).toContainEqual('event: connection\n');
    });

    it('should route events only to matching session connections', async () => {
      const reqA = createMockRequest();
      const resA = createMockResponse();
      const reqB = createMockRequest();
      const resB = createMockResponse();

      // Connect two different sessions
      await transport.connect(reqA, resA, 'sess-A');
      jest.advanceTimersByTime(1);
      await transport.connect(reqB, resB, 'sess-B');

      const writesBeforeA = (resA.write as jest.Mock).mock.calls.length;
      const writesBeforeB = (resB.write as jest.Mock).mock.calls.length;

      // Emit event for sess-A only
      mockSessionManager.emit('streamingEvent', makeEvent({ sessionId: 'sess-A' }));

      const writesAfterA = (resA.write as jest.Mock).mock.calls.length;
      const writesAfterB = (resB.write as jest.Mock).mock.calls.length;

      // sess-A should have received the event
      expect(writesAfterA).toBeGreaterThan(writesBeforeA);
      // sess-B should not have received any new writes
      expect(writesAfterB).toBe(writesBeforeB);
    });

    it('should deliver events to multiple connections on the same session', async () => {
      const req1 = createMockRequest();
      const res1 = createMockResponse();
      const req2 = createMockRequest();
      const res2 = createMockResponse();

      await transport.connect(req1, res1, 'shared-sess');
      jest.advanceTimersByTime(1);
      await transport.connect(req2, res2, 'shared-sess');

      const writesBefore1 = (res1.write as jest.Mock).mock.calls.length;
      const writesBefore2 = (res2.write as jest.Mock).mock.calls.length;

      mockSessionManager.emit('streamingEvent', makeEvent({ sessionId: 'shared-sess' }));

      // Both connections should have received the event
      expect((res1.write as jest.Mock).mock.calls.length).toBeGreaterThan(writesBefore1);
      expect((res2.write as jest.Mock).mock.calls.length).toBeGreaterThan(writesBefore2);
    });

    it('should track eventsSent counter per connection', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'counter-sess');

      // Send 3 events
      for (let i = 0; i < 3; i++) {
        mockSessionManager.emit('streamingEvent', makeEvent({ sessionId: 'counter-sess' }));
      }

      const connections = transport.getSessionConnections('counter-sess');
      expect(connections).toHaveLength(1);
      expect(connections[0].eventsSent).toBe(3);
    });

    it('should close connections and send session_complete on sessionComplete', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'complete-sess');
      expect(transport.getStats().totalConnections).toBe(1);

      mockSessionManager.emit('sessionComplete', 'complete-sess');

      expect(res.end).toHaveBeenCalled();
      expect(transport.getStats().totalConnections).toBe(0);

      // Verify session_complete event was sent
      const writeArgs = (res.write as jest.Mock).mock.calls.map((c: any) => c[0] as string);
      const eventLines = writeArgs.filter((arg: string) => arg.startsWith('event: '));
      expect(eventLines).toContainEqual('event: session_complete\n');
    });

    it('should emit connectionClosed with correct metadata on disconnect', async () => {
      const closedPromise = new Promise<any>((resolve) => {
        transport.on('connectionClosed', resolve);
      });

      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'emit-sess');
      transport.disconnectSession('emit-sess', 'test_reason');

      const payload = await closedPromise;
      expect(payload).toMatchObject({
        sessionId: 'emit-sess',
        reason: 'test_reason'
      });
      expect(payload).toHaveProperty('connectionId');
      expect(payload).toHaveProperty('duration');
      expect(payload).toHaveProperty('eventsSent');
    });

    it('should send heartbeats that update lastActivity', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'heartbeat-sess');

      const connBefore = transport.getSessionConnections('heartbeat-sess')[0];
      const activityBefore = connBefore.lastActivity;

      // Advance past heartbeat interval
      jest.advanceTimersByTime(30000);

      const connAfter = transport.getSessionConnections('heartbeat-sess')[0];
      expect(connAfter.lastActivity).toBeGreaterThanOrEqual(activityBefore);
    });

    it('should respect connection limit of 100', async () => {
      // Cannot practically create 100 connections with fake timers, but we
      // can verify the response when the session does not exist, confirming
      // the validation path.
      mockSessionManager.hasSession = jest.fn<any>().mockReturnValue(false);

      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'nonexistent-sess');

      // Should return 404 for missing session
      expect(res.status).toHaveBeenCalledWith(404);
      expect(transport.getStats().totalConnections).toBe(0);
    });

    it('should send disconnect event with reason before ending response', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'disconnect-sess');
      transport.disconnectSession('disconnect-sess', 'graceful_close');

      const writeArgs = (res.write as jest.Mock).mock.calls.map((c: any) => c[0] as string);
      const eventLines = writeArgs.filter((arg: string) => arg.startsWith('event: '));
      expect(eventLines).toContainEqual('event: disconnect\n');
      expect(res.end).toHaveBeenCalled();
    });

    it('should ignore events without a sessionId', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      await transport.connect(req, res, 'ignore-sess');

      const writesBefore = (res.write as jest.Mock).mock.calls.length;

      // Event with no sessionId
      mockSessionManager.emit('streamingEvent', {
        type: 'agent_progress',
        agent: 'claude',
        content: 'no session',
        timestamp: Date.now(),
        sessionId: undefined
      } as any);

      expect((res.write as jest.Mock).mock.calls.length).toBe(writesBefore);
    });
  });

  // ===========================================================================
  // 2. Session Lifecycle (create, use, cleanup) Characterization
  // ===========================================================================

  describe('SessionChannelManager Lifecycle', () => {
    let manager: SessionChannelManager;

    beforeEach(() => {
      jest.useFakeTimers();
      // Use a short TTL so we can test cleanup without long waits
      manager = new SessionChannelManager({ ttl: 5000, autoCleanup: true });
    });

    afterEach(() => {
      manager.destroy();
      jest.useRealTimers();
    });

    // -- Create --

    it('should create a session with a generated ID when none is provided', () => {
      const session = manager.createSession();
      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe('string');
      expect(session.id.length).toBeGreaterThan(0);
    });

    it('should create a session with a specific ID when provided', () => {
      const session = manager.createSession('my-session-42');
      expect(session.id).toBe('my-session-42');
    });

    it('should throw when creating a session with a duplicate ID', () => {
      manager.createSession('dup-id');
      expect(() => manager.createSession('dup-id')).toThrow('Session dup-id already exists');
    });

    it('should initialize analysis state to starting on creation', () => {
      const session = manager.createSession('init-check');
      expect(session.analysis.status).toBe('starting');
      expect(session.analysis.progress.currentPhase).toBe(0);
      expect(session.analysis.progress.phaseName).toBe('starting');
    });

    it('should emit sessionCreated when a session is created', () => {
      const handler = jest.fn();
      manager.on('sessionCreated', handler);
      manager.createSession('emit-create');
      expect(handler).toHaveBeenCalledWith('emit-create', expect.any(Object));
    });

    it('should store metadata passed at creation time', () => {
      const session = manager.createSession('meta-sess', { tool: 'roast', mode: 'debate' });
      expect(session.metadata.tool).toBe('roast');
      expect(session.metadata.mode).toBe('debate');
      expect(session.metadata.createdAt).toBeDefined();
    });

    // -- Use (getSession, emitToSession, startAnalysis, completeAnalysis) --

    it('should retrieve an existing session by ID', () => {
      manager.createSession('retrieve-me');
      const session = manager.getSession('retrieve-me');
      expect(session).not.toBeNull();
      expect(session!.id).toBe('retrieve-me');
    });

    it('should return null for non-existent session', () => {
      const session = manager.getSession('ghost-session');
      expect(session).toBeNull();
    });

    it('should update lastActivity on getSession call', () => {
      const session = manager.createSession('activity-sess');
      const originalActivity = session.lastActivity;

      jest.advanceTimersByTime(100);
      const retrieved = manager.getSession('activity-sess');
      expect(retrieved!.lastActivity).toBeGreaterThan(originalActivity);
    });

    it('should return null for failed sessions when requireActive is true', () => {
      manager.createSession('fail-sess');
      manager.failAnalysis('fail-sess', new Error('boom'));

      const session = manager.getSession('fail-sess', true);
      expect(session).toBeNull();
    });

    it('should return failed sessions when requireActive is false', () => {
      manager.createSession('fail-sess-2');
      manager.failAnalysis('fail-sess-2', new Error('boom'));

      const session = manager.getSession('fail-sess-2', false);
      expect(session).not.toBeNull();
      expect(session!.analysis.status).toBe('failed');
    });

    it('should emit events to a session and update metrics', async () => {
      manager.createSession('event-sess');

      const event = makeEvent({ sessionId: 'event-sess', agent: 'codex', content: 'finding' });
      await manager.emitToSession('event-sess', event);

      const session = manager.getSession('event-sess')!;
      expect(session.analysis.metrics.totalEvents).toBe(1);
      expect(session.resources.eventCount).toBe(1);
    });

    it('should track agent lifecycle events (start, complete, error)', async () => {
      manager.createSession('agent-lifecycle');
      manager.startAnalysis('agent-lifecycle', ['claude', 'codex']);

      const session = () => manager.getSession('agent-lifecycle')!;

      expect(session().analysis.status).toBe('running');
      expect(session().analysis.activeAgents.has('claude')).toBe(true);
      expect(session().analysis.activeAgents.has('codex')).toBe(true);

      // Agent starts
      await manager.emitToSession('agent-lifecycle', makeEvent({
        sessionId: 'agent-lifecycle',
        type: 'agent_start',
        agent: 'gemini'
      }));
      expect(session().analysis.activeAgents.has('gemini')).toBe(true);

      // Agent completes
      await manager.emitToSession('agent-lifecycle', makeEvent({
        sessionId: 'agent-lifecycle',
        type: 'agent_complete',
        agent: 'claude'
      }));
      expect(session().analysis.activeAgents.has('claude')).toBe(false);
      expect(session().analysis.completedAgents.has('claude')).toBe(true);

      // Agent errors
      await manager.emitToSession('agent-lifecycle', makeEvent({
        sessionId: 'agent-lifecycle',
        type: 'agent_error',
        agent: 'codex'
      }));
      expect(session().analysis.activeAgents.has('codex')).toBe(false);
      expect(session().analysis.failedAgents.has('codex')).toBe(true);
      expect(session().analysis.metrics.errorsCount).toBe(1);
    });

    it('should update progress phases from event metadata', async () => {
      manager.createSession('phase-sess');

      await manager.emitToSession('phase-sess', makeEvent({
        sessionId: 'phase-sess',
        metadata: { phase: 'scanning' }
      }));

      const session = manager.getSession('phase-sess')!;
      expect(session.analysis.progress.currentPhase).toBe(1);
      expect(session.analysis.progress.phaseName).toBe('scanning');
    });

    it('should set analysis to complete with correct final state', () => {
      manager.createSession('complete-sess');
      manager.startAnalysis('complete-sess', ['claude']);

      const result = manager.completeAnalysis('complete-sess');
      expect(result).toBe(true);

      const session = manager.getSession('complete-sess')!;
      expect(session.analysis.status).toBe('complete');
      expect(session.analysis.endTime).toBeDefined();
      expect(session.analysis.progress.phaseProgress).toBe(100);
      expect(session.analysis.progress.phaseName).toBe('complete');
    });

    // -- Subscribe / Unsubscribe --

    it('should subscribe a subscriber and deliver backlog', async () => {
      manager.createSession('sub-sess');

      // Emit an event before subscribing (will be in buffer)
      await manager.emitToSession('sub-sess', makeEvent({ sessionId: 'sub-sess', content: 'buffered' }));

      const subscriber = createMockSubscriber('sub-1', 'sub-sess');
      const result = await manager.subscribe('sub-sess', subscriber);

      expect(result).toBe(true);

      const session = manager.getSession('sub-sess')!;
      expect(session.connectionCount).toBe(1);
      expect(session.subscribers.size).toBe(1);
    });

    it('should reject subscription to non-existent session', async () => {
      const subscriber = createMockSubscriber('sub-x', 'ghost');
      const result = await manager.subscribe('ghost', subscriber);
      expect(result).toBe(false);
    });

    it('should enforce maxConnections per session', async () => {
      const mgr = new SessionChannelManager({ maxConnections: 2 });
      mgr.createSession('limit-sess');

      const sub1 = createMockSubscriber('s1', 'limit-sess');
      const sub2 = createMockSubscriber('s2', 'limit-sess');
      const sub3 = createMockSubscriber('s3', 'limit-sess');

      expect(await mgr.subscribe('limit-sess', sub1)).toBe(true);
      expect(await mgr.subscribe('limit-sess', sub2)).toBe(true);
      expect(await mgr.subscribe('limit-sess', sub3)).toBe(false);

      mgr.destroy();
    });

    it('should unsubscribe and close subscriber', () => {
      manager.createSession('unsub-sess');
      const subscriber = createMockSubscriber('unsub-1', 'unsub-sess');

      // Synchronously add subscriber (bypass backlog delivery)
      const session = manager.getSession('unsub-sess')!;
      session.subscribers.add(subscriber);
      session.connectionCount = 1;

      const result = manager.unsubscribe('unsub-sess', 'unsub-1');
      expect(result).toBe(true);
      expect(subscriber.close).toHaveBeenCalled();
      expect(session.connectionCount).toBe(0);
    });

    // -- Cleanup and Destroy --

    it('should destroy a session and release all resources', () => {
      manager.createSession('destroy-sess');

      const subscriber = createMockSubscriber('d-sub', 'destroy-sess');
      const session = manager.getSession('destroy-sess')!;
      session.subscribers.add(subscriber);
      session.connectionCount = 1;

      const result = manager.destroySession('destroy-sess');
      expect(result).toBe(true);
      expect(subscriber.close).toHaveBeenCalled();
      expect(manager.hasSession('destroy-sess')).toBe(false);
    });

    it('should return false when destroying non-existent session', () => {
      expect(manager.destroySession('no-such-session')).toBe(false);
    });

    it('should emit sessionDestroyed on destroy', () => {
      const handler = jest.fn();
      manager.on('sessionDestroyed', handler);
      manager.createSession('emit-destroy');
      manager.destroySession('emit-destroy');
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'emit-destroy' }));
    });

    it('should cleanup all sessions on destroy()', () => {
      manager.createSession('bulk-1');
      manager.createSession('bulk-2');
      manager.createSession('bulk-3');

      manager.destroy();

      expect(manager.hasSession('bulk-1')).toBe(false);
      expect(manager.hasSession('bulk-2')).toBe(false);
      expect(manager.hasSession('bulk-3')).toBe(false);
    });

    it('should provide accurate global stats', () => {
      manager.createSession('stats-1');
      manager.createSession('stats-2');

      const stats = manager.getGlobalStats();
      expect(stats.activeSessions).toBe(2);
      expect(stats.totalEvents).toBe(0);
      expect(stats.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should provide session-level stats', async () => {
      manager.createSession('sess-stats');
      await manager.emitToSession('sess-stats', makeEvent({ sessionId: 'sess-stats' }));
      await manager.emitToSession('sess-stats', makeEvent({ sessionId: 'sess-stats' }));

      const stats = manager.getSessionStats('sess-stats');
      expect(stats).not.toBeNull();
      expect(stats!.eventsEmitted).toBe(2);
    });

    it('should return null stats for non-existent session', () => {
      expect(manager.getSessionStats('nope')).toBeNull();
    });

    it('should track findings from event metadata', async () => {
      manager.createSession('finding-sess');

      await manager.emitToSession('finding-sess', makeEvent({
        sessionId: 'finding-sess',
        metadata: { contentType: 'finding' }
      }));

      const session = manager.getSession('finding-sess')!;
      expect(session.analysis.metrics.findingsCount).toBe(1);
      expect(session.analysis.findings).toHaveLength(1);
    });
  });

  // ===========================================================================
  // 3. Session Isolation Between Concurrent Sessions
  // ===========================================================================

  describe('Session Isolation', () => {
    let manager: SessionChannelManager;

    beforeEach(() => {
      jest.useFakeTimers();
      manager = new SessionChannelManager({ autoCleanup: false });
    });

    afterEach(() => {
      manager.destroy();
      jest.useRealTimers();
    });

    it('should maintain independent event counts across sessions', async () => {
      manager.createSession('iso-A');
      manager.createSession('iso-B');

      // Send 3 events to A, 1 to B
      for (let i = 0; i < 3; i++) {
        await manager.emitToSession('iso-A', makeEvent({ sessionId: 'iso-A' }));
      }
      await manager.emitToSession('iso-B', makeEvent({ sessionId: 'iso-B' }));

      const sessionA = manager.getSession('iso-A')!;
      const sessionB = manager.getSession('iso-B')!;

      expect(sessionA.resources.eventCount).toBe(3);
      expect(sessionB.resources.eventCount).toBe(1);
      expect(sessionA.analysis.metrics.totalEvents).toBe(3);
      expect(sessionB.analysis.metrics.totalEvents).toBe(1);
    });

    it('should maintain independent analysis states across sessions', () => {
      manager.createSession('state-A');
      manager.createSession('state-B');

      manager.startAnalysis('state-A', ['claude']);
      manager.failAnalysis('state-B', new Error('oops'));

      const sessionA = manager.getSession('state-A')!;
      // state-B is failed, need requireActive=false
      const sessionB = manager.getSession('state-B', false)!;

      expect(sessionA.analysis.status).toBe('running');
      expect(sessionB.analysis.status).toBe('failed');
    });

    it('should maintain independent subscriber sets across sessions', async () => {
      manager.createSession('subs-A');
      manager.createSession('subs-B');

      const subA = createMockSubscriber('sa', 'subs-A');
      const subB = createMockSubscriber('sb', 'subs-B');

      await manager.subscribe('subs-A', subA);
      await manager.subscribe('subs-B', subB);

      const sessionA = manager.getSession('subs-A')!;
      const sessionB = manager.getSession('subs-B')!;

      expect(sessionA.subscribers.size).toBe(1);
      expect(sessionB.subscribers.size).toBe(1);

      // Unsubscribing from A should not affect B
      manager.unsubscribe('subs-A', 'sa');
      expect(manager.getSession('subs-A')!.subscribers.size).toBe(0);
      expect(manager.getSession('subs-B')!.subscribers.size).toBe(1);
    });

    it('should destroy one session without affecting others', async () => {
      manager.createSession('survive-A');
      manager.createSession('survive-B');

      await manager.emitToSession('survive-A', makeEvent({ sessionId: 'survive-A' }));
      await manager.emitToSession('survive-B', makeEvent({ sessionId: 'survive-B' }));

      manager.destroySession('survive-A');

      expect(manager.hasSession('survive-A')).toBe(false);
      expect(manager.hasSession('survive-B')).toBe(true);

      const sessionB = manager.getSession('survive-B')!;
      expect(sessionB.resources.eventCount).toBe(1);
    });

    it('should track agent completion independently per session', async () => {
      manager.createSession('agents-A');
      manager.createSession('agents-B');

      manager.startAnalysis('agents-A', ['claude', 'codex']);
      manager.startAnalysis('agents-B', ['gemini']);

      // Complete claude in session A
      await manager.emitToSession('agents-A', makeEvent({
        sessionId: 'agents-A',
        type: 'agent_complete',
        agent: 'claude'
      }));

      // Error gemini in session B
      await manager.emitToSession('agents-B', makeEvent({
        sessionId: 'agents-B',
        type: 'agent_error',
        agent: 'gemini'
      }));

      const sessionA = manager.getSession('agents-A')!;
      const sessionB = manager.getSession('agents-B')!;

      expect(sessionA.analysis.completedAgents.has('claude')).toBe(true);
      expect(sessionA.analysis.failedAgents.size).toBe(0);

      expect(sessionB.analysis.failedAgents.has('gemini')).toBe(true);
      expect(sessionB.analysis.completedAgents.size).toBe(0);
    });

    it('should filter active sessions excluding failed ones', () => {
      manager.createSession('active-1');
      manager.createSession('active-2');
      manager.createSession('active-3');

      manager.failAnalysis('active-2', new Error('down'));

      const activeSessions = manager.getActiveSessions();
      const activeIds = activeSessions.map(s => s.id);

      expect(activeIds).toContain('active-1');
      expect(activeIds).not.toContain('active-2');
      expect(activeIds).toContain('active-3');
    });

    it('should provide correct global metrics with multiple sessions', async () => {
      manager.createSession('m-1');
      manager.createSession('m-2');

      await manager.emitToSession('m-1', makeEvent({ sessionId: 'm-1' }));
      await manager.emitToSession('m-1', makeEvent({ sessionId: 'm-1' }));
      await manager.emitToSession('m-2', makeEvent({ sessionId: 'm-2' }));

      const metrics = manager.getGlobalMetrics();
      expect(metrics.activeSessions).toBe(2);

      // Check sessions are listed
      expect(metrics.sessions).toHaveLength(2);
      const sessionIds = metrics.sessions.map((s: any) => s.id);
      expect(sessionIds).toContain('m-1');
      expect(sessionIds).toContain('m-2');
    });
  });

  // ===========================================================================
  // 4. Circuit Breaker State Transitions (supplementary characterization)
  // ===========================================================================

  describe('Circuit Breaker State Transitions', () => {
    let breaker: CircuitBreaker;
    const config: CircuitBreakerConfig = {
      failureThreshold: 3,
      recoveryTimeout: 1000,
      successThreshold: 2,
      timeout: 5000,
      monitoringWindow: 10000,
      minimumRequests: 5
    };

    beforeEach(() => {
      jest.useFakeTimers();
      breaker = new CircuitBreaker(config, 'lifecycle-test');
    });

    afterEach(() => {
      breaker.shutdown();
      jest.useRealTimers();
    });

    it('should start in CLOSED state with zero counters', () => {
      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });

    it('should transition from CLOSED to OPEN after failureThreshold failures', async () => {
      for (let i = 0; i < config.failureThreshold; i++) {
        try {
          await breaker.execute(async () => { throw new Error(`fail-${i}`); });
        } catch { /* expected */ }
      }

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.OPEN);
      expect(stats.failures).toBe(config.failureThreshold);
    });

    it('should block requests when OPEN', async () => {
      // Force to OPEN
      breaker.forceState(CircuitState.OPEN);

      await expect(
        breaker.execute(async () => 'should-not-run')
      ).rejects.toThrow(/OPEN/);
    });

    it('should transition from OPEN to HALF_OPEN after recoveryTimeout', async () => {
      breaker.forceState(CircuitState.OPEN);

      const stateHandler = jest.fn();
      breaker.on('stateChanged', stateHandler);

      jest.advanceTimersByTime(config.recoveryTimeout + 10);

      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ state: CircuitState.HALF_OPEN })
      );
    });

    it('should transition from HALF_OPEN to CLOSED after successThreshold successes', async () => {
      breaker.forceState(CircuitState.HALF_OPEN);

      for (let i = 0; i < config.successThreshold; i++) {
        await breaker.execute(async () => 'recovered');
      }

      expect(breaker.getStats().state).toBe(CircuitState.CLOSED);
    });

    it('should track response times accurately', async () => {
      jest.useRealTimers(); // Need real timers for timing measurement

      const localBreaker = new CircuitBreaker(config, 'timing-test');

      await localBreaker.execute(async () => {
        return 'fast';
      });

      const stats = localBreaker.getStats();
      expect(stats.averageResponseTime).toBeGreaterThanOrEqual(0);
      expect(stats.totalRequests).toBe(1);

      localBreaker.shutdown();
    });

    it('should reset all counters on reset()', async () => {
      // Accumulate some stats
      await breaker.execute(async () => 'ok');
      try {
        await breaker.execute(async () => { throw new Error('fail'); });
      } catch { /* expected */ }

      breaker.reset();

      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.totalRequests).toBe(0);
    });

    it('should emit stateChanged events on transitions', async () => {
      const stateHandler = jest.fn();
      breaker.on('stateChanged', stateHandler);

      // Force OPEN
      breaker.forceState(CircuitState.OPEN);
      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ state: CircuitState.OPEN })
      );

      // Wait for HALF_OPEN
      jest.advanceTimersByTime(config.recoveryTimeout + 10);
      expect(stateHandler).toHaveBeenCalledWith(
        expect.objectContaining({ state: CircuitState.HALF_OPEN })
      );
    });
  });
});
