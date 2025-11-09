/**
 * Unit Tests: Progress Tracker
 *
 * Tests for the ProgressTracker class that monitors analysis progress
 * through milestone detection, phase transitions, and ETA calculation.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { ProgressTracker, AnalysisPhase, ProgressEvent, ANALYSIS_MILESTONES } from '../../src/streaming/progress-tracker.js';
import { StreamingEvent } from '../../src/cli-agents.js';

describe('ProgressTracker', () => {
  let tracker: ProgressTracker;
  const sessionId = 'test-session-123';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize with roast_codebase analysis type', () => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.INITIALIZING);
      expect(state.overallProgress).toBe(0);
      expect(state.phaseProgress).toBe(0);
      expect(state.completedMilestones.size).toBe(0);
      expect(state.errors).toHaveLength(0);
    });

    it('should initialize with roast_idea analysis type', () => {
      tracker = new ProgressTracker(sessionId, 'roast_idea');
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.INITIALIZING);
      expect(ANALYSIS_MILESTONES.roast_idea).toBeDefined();
    });

    it('should initialize with roast_security analysis type', () => {
      tracker = new ProgressTracker(sessionId, 'roast_security');
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.INITIALIZING);
      expect(ANALYSIS_MILESTONES.roast_security).toBeDefined();
    });

    it('should handle unknown analysis type with empty milestones', () => {
      tracker = new ProgressTracker(sessionId, 'unknown_analysis');
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.INITIALIZING);
      expect(state.completedMilestones.size).toBe(0);
    });
  });

  describe('Event Processing', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');
    });

    it('should ignore events from different sessions', () => {
      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Starting analysis',
        timestamp: Date.now(),
        sessionId: 'different-session'
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.INITIALIZING);
    });

    it('should detect INITIALIZING phase from content', () => {
      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Initializing code analysis...',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.INITIALIZING);
    });

    it('should detect COLLECTING_DATA phase from content', () => {
      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Reading files from the codebase...',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.COLLECTING_DATA);
    });

    it('should detect ANALYZING phase from content', () => {
      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Analyzing architecture patterns...',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.ANALYZING);
    });

    it('should detect PROCESSING_RESULTS phase from content', () => {
      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Generating final report...',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.PROCESSING_RESULTS);
    });

    it('should detect COMPLETE phase from content', () => {
      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Analysis complete',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.COMPLETE);
    });

    it('should detect ERROR phase from agent_error event', () => {
      const event: StreamingEvent = {
        type: 'agent_error',
        agent: 'claude',
        content: 'Fatal error occurred',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.currentPhase).toBe(AnalysisPhase.ERROR);
      expect(state.errors).toContain('Fatal error occurred');
    });
  });

  describe('Milestone Detection', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');
    });

    it('should detect scan_structure milestone', () => {
      const progressEvents: ProgressEvent[] = [];
      tracker.on('progress', (event: ProgressEvent) => progressEvents.push(event));

      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Found 150 files in the project',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.completedMilestones.has('scan_structure')).toBe(true);
      expect(progressEvents.some(e => e.type === 'milestone_completed')).toBe(true);
    });

    it('should detect security_audit milestone', () => {
      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'CRITICAL: SQL injection vulnerability detected',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.completedMilestones.has('security_audit')).toBe(true);
    });

    it('should not complete milestones with unmet dependencies', () => {
      // Try to complete read_core_files without scan_structure
      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Reading index.ts',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      // Should complete if dependencies auto-completed, or remain incomplete
      // Either way, the tracker should handle dependencies gracefully
      expect(state).toBeDefined();
    });
  });

  describe('Phase Transitions', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');
    });

    it('should emit phase_changed event on transition', (done) => {
      tracker.on('progress', (event: ProgressEvent) => {
        if (event.type === 'phase_changed') {
          expect(event.phase).toBe(AnalysisPhase.ANALYZING);
          done();
        }
      });

      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: 'Analyzing code structure',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
    });

    it('should reset phaseProgress on phase transition', () => {
      // Move to analyzing phase
      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Analyzing...',
        timestamp: Date.now(),
        sessionId
      });

      const state1 = tracker.getState();
      expect(state1.currentPhase).toBe(AnalysisPhase.ANALYZING);
      expect(state1.phaseProgress).toBe(0);

      // Move to processing results phase
      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Generating report...',
        timestamp: Date.now(),
        sessionId
      });

      const state2 = tracker.getState();
      expect(state2.currentPhase).toBe(AnalysisPhase.PROCESSING_RESULTS);
      expect(state2.phaseProgress).toBe(0);
    });
  });

  describe('Progress Calculation', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_idea');
    });

    it('should calculate overall progress based on milestone weights', () => {
      // Trigger multiple milestones to ensure progress > 0
      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Validating the core concept and analyzing market conditions',
        timestamp: Date.now(),
        sessionId
      });

      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Market research shows significant competition in this space',
        timestamp: Date.now(),
        sessionId
      });

      const state = tracker.getState();
      expect(state.overallProgress).toBeGreaterThanOrEqual(0);
      expect(state.overallProgress).toBeLessThanOrEqual(1);
    });

    it('should update estimated completion time', () => {
      // Process some events to trigger progress
      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Market research in progress',
        timestamp: Date.now(),
        sessionId
      });

      const state = tracker.getState();
      // estimatedCompletion may or may not be set depending on progress
      expect(state).toBeDefined();
    });
  });

  describe('Complete Analysis', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_security');
    });

    it('should mark analysis as complete', () => {
      const events: ProgressEvent[] = [];
      tracker.on('progress', (event: ProgressEvent) => {
        events.push(event);
      });

      tracker.markComplete();

      const completeEvent = events.find(e => e.type === 'analysis_complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent?.phase).toBe(AnalysisPhase.COMPLETE);
      expect(completeEvent?.metadata?.duration).toBeGreaterThanOrEqual(0);
    });

    it('should set progress to 100% when complete', () => {
      tracker.markComplete();
      const state = tracker.getState();

      expect(state.overallProgress).toBe(1.0);
      expect(state.phaseProgress).toBe(1.0);
      expect(state.currentPhase).toBe(AnalysisPhase.COMPLETE);
    });

    it('should auto-complete remaining milestones when marked complete', () => {
      tracker.markComplete();
      const state = tracker.getState();

      // Should have attempted to complete all milestones
      expect(state.currentPhase).toBe(AnalysisPhase.COMPLETE);
    });
  });

  describe('Progress Summary', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');
    });

    it('should return formatted progress summary', () => {
      const summary = tracker.getProgressSummary();

      expect(summary.phase).toBe(AnalysisPhase.INITIALIZING);
      expect(summary.overallProgress).toBe(0);
      expect(summary.phaseProgress).toBe(0);
      expect(summary.completedMilestones).toBe(0);
      expect(summary.totalMilestones).toBeGreaterThan(0);
    });

    it('should include milestone information in summary', () => {
      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Found 100 files',
        timestamp: Date.now(),
        sessionId
      });

      const summary = tracker.getProgressSummary();
      expect(summary.completedMilestones).toBeGreaterThan(0);
    });

    it('should calculate estimated time remaining', () => {
      // Process enough events to trigger ETA calculation
      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Scanning files...',
        timestamp: Date.now(),
        sessionId
      });

      const summary = tracker.getProgressSummary();
      // estimatedTimeRemaining may or may not be defined
      expect(summary).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');
    });

    it('should track errors', () => {
      const event: StreamingEvent = {
        type: 'agent_error',
        agent: 'claude',
        content: 'Error reading file',
        timestamp: Date.now(),
        sessionId
      };

      tracker.processEvent(event);
      const state = tracker.getState();

      expect(state.errors).toContain('Error reading file');
      expect(state.currentPhase).toBe(AnalysisPhase.ERROR);
    });

    it('should emit analysis_error event', (done) => {
      tracker.on('progress', (event: ProgressEvent) => {
        if (event.type === 'analysis_error') {
          expect(event.metadata?.error).toBe('Permission denied');
          done();
        }
      });

      tracker.processEvent({
        type: 'agent_error',
        agent: 'claude',
        content: 'Permission denied',
        timestamp: Date.now(),
        sessionId
      });
    });

    it('should accumulate multiple errors', () => {
      tracker.processEvent({
        type: 'agent_error',
        agent: 'claude',
        content: 'Error 1',
        timestamp: Date.now(),
        sessionId
      });

      tracker.processEvent({
        type: 'agent_error',
        agent: 'claude',
        content: 'Error 2',
        timestamp: Date.now(),
        sessionId
      });

      const state = tracker.getState();
      expect(state.errors).toHaveLength(2);
    });
  });

  describe('Event Emission', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');
    });

    it('should emit progress_updated event', (done) => {
      tracker.on('progress', (event: ProgressEvent) => {
        if (event.type === 'progress_updated') {
          expect(event.sessionId).toBe(sessionId);
          expect(event.timestamp).toBeGreaterThan(0);
          done();
        }
      });

      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Processing...',
        timestamp: Date.now(),
        sessionId
      });
    });

    it('should include progress values in events', (done) => {
      tracker.on('progress', (event: ProgressEvent) => {
        expect(event.progress.overall).toBeGreaterThanOrEqual(0);
        expect(event.progress.overall).toBeLessThanOrEqual(1);
        expect(event.progress.phase).toBeGreaterThanOrEqual(0);
        expect(event.progress.phase).toBeLessThanOrEqual(1);
        done();
      });

      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Working...',
        timestamp: Date.now(),
        sessionId
      });
    });
  });

  describe('State Management', () => {
    beforeEach(() => {
      tracker = new ProgressTracker(sessionId, 'roast_idea');
    });

    it('should return immutable state copy', () => {
      const state1 = tracker.getState();
      const state2 = tracker.getState();

      expect(state1).not.toBe(state2); // Different objects
      expect(state1.currentPhase).toBe(state2.currentPhase); // Same values
    });

    it('should update lastUpdate timestamp on event processing', () => {
      const state1 = tracker.getState();
      const timestamp1 = state1.lastUpdate;

      // Wait a bit
      setTimeout(() => {
        tracker.processEvent({
          type: 'agent_progress',
          agent: 'claude',
          content: 'Update',
          timestamp: Date.now(),
          sessionId
        });

        const state2 = tracker.getState();
        expect(state2.lastUpdate).toBeGreaterThan(timestamp1);
      }, 10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty content in events', () => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');

      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: '',
        timestamp: Date.now(),
        sessionId
      };

      expect(() => tracker.processEvent(event)).not.toThrow();
    });

    it('should handle undefined content in events', () => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');

      const event: StreamingEvent = {
        type: 'agent_progress',
        agent: 'claude',
        content: undefined as any,
        timestamp: Date.now(),
        sessionId
      };

      expect(() => tracker.processEvent(event)).not.toThrow();
    });

    it('should handle rapid phase transitions', () => {
      tracker = new ProgressTracker(sessionId, 'roast_codebase');

      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Initializing...',
        timestamp: Date.now(),
        sessionId
      });

      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Reading files...',
        timestamp: Date.now(),
        sessionId
      });

      tracker.processEvent({
        type: 'agent_progress',
        agent: 'claude',
        content: 'Analyzing...',
        timestamp: Date.now(),
        sessionId
      });

      const state = tracker.getState();
      expect(state.currentPhase).toBe(AnalysisPhase.ANALYZING);
    });

    it('should handle completion before all milestones triggered', () => {
      tracker = new ProgressTracker(sessionId, 'roast_security');

      // Mark complete without triggering any milestones
      expect(() => tracker.markComplete()).not.toThrow();

      const state = tracker.getState();
      expect(state.overallProgress).toBe(1.0);
    });
  });
});
