/**
 * @module progress-tracker
 * @deprecated NOT INTEGRATED -- This module provides milestone-based progress
 * tracking for the unintegrated StreamingCLIOrchestrator. The canonical
 * streaming path uses the simpler handleProgressUpdate callback in
 * brutalist-server.ts, which sends MCP notifications/progress directly.
 * Retained for possible future integration. See
 * src/streaming/STREAMING_ARCHITECTURE.md for details.
 */
import { EventEmitter } from 'events';
import { StreamingEvent } from '../cli-agents.js';
/**
 * Analysis progress phases with detailed milestones
 */
export declare enum AnalysisPhase {
    INITIALIZING = "initializing",
    COLLECTING_DATA = "collecting_data",
    ANALYZING = "analyzing",
    PROCESSING_RESULTS = "processing_results",
    GENERATING_REPORT = "generating_report",
    COMPLETE = "complete",
    ERROR = "error"
}
/**
 * Progress milestone definition
 */
export interface ProgressMilestone {
    id: string;
    phase: AnalysisPhase;
    name: string;
    description: string;
    estimatedDuration?: number;
    weight: number;
    dependencies?: string[];
    optional?: boolean;
}
/**
 * Progress state tracking
 */
export interface ProgressState {
    currentPhase: AnalysisPhase;
    overallProgress: number;
    phaseProgress: number;
    completedMilestones: Set<string>;
    currentMilestone?: ProgressMilestone;
    startTime: number;
    lastUpdate: number;
    estimatedCompletion?: number;
    errors: string[];
}
/**
 * Progress event emitted for tracking
 */
export interface ProgressEvent {
    type: 'milestone_started' | 'milestone_completed' | 'phase_changed' | 'progress_updated' | 'analysis_complete' | 'analysis_error';
    sessionId: string;
    timestamp: number;
    phase: AnalysisPhase;
    milestone?: ProgressMilestone;
    progress: {
        overall: number;
        phase: number;
    };
    estimatedCompletion?: number;
    metadata?: Record<string, any>;
}
/**
 * Analysis type-specific milestone definitions
 */
export declare const ANALYSIS_MILESTONES: Record<string, ProgressMilestone[]>;
/**
 * Progress milestone system with intelligent phase detection.
 *
 * Features:
 * - Dynamic milestone tracking based on analysis type
 * - Intelligent progress estimation with dependencies
 * - Phase transition detection from CLI output
 * - ETA calculation with adaptive learning
 * - Progress events for real-time updates
 *
 * @deprecated NOT INTEGRATED -- The canonical streaming path uses the simpler
 * handleProgressUpdate callback in brutalist-server.ts. This tracker is used
 * only by the unintegrated StreamingCLIOrchestrator.
 */
export declare class ProgressTracker extends EventEmitter {
    private state;
    private milestones;
    private sessionId;
    private analysisType;
    private readonly PHASE_PATTERNS;
    private readonly MILESTONE_TRIGGERS;
    constructor(sessionId: string, analysisType: string);
    /**
     * Process streaming event and update progress
     */
    processEvent(event: StreamingEvent): void;
    /**
     * Detect current phase from CLI output content
     */
    private detectPhaseFromContent;
    /**
     * Detect milestone completion from content
     */
    private detectMilestonesFromContent;
    /**
     * Transition to new phase
     */
    private transitionToPhase;
    /**
     * Complete a milestone
     */
    private completeMilestone;
    /**
     * Check if milestone dependencies are met
     */
    private areDependenciesMet;
    /**
     * Check if milestone should be auto-completed
     */
    private shouldAutoCompleteMilestone;
    /**
     * Auto-complete milestones from previous phases
     */
    private autoCompletePreviousPhaseMilestones;
    /**
     * Update progress calculations
     */
    private updateProgress;
    /**
     * Update estimated completion time
     */
    private updateEstimatedCompletion;
    /**
     * Handle error in analysis
     */
    private handleError;
    /**
     * Mark analysis as complete
     */
    markComplete(): void;
    /**
     * Emit progress event
     */
    private emitProgressEvent;
    /**
     * Get current progress state
     */
    getState(): ProgressState;
    /**
     * Get progress summary for display
     */
    getProgressSummary(): {
        phase: string;
        overallProgress: number;
        phaseProgress: number;
        currentMilestone?: string;
        estimatedTimeRemaining?: number;
        completedMilestones: number;
        totalMilestones: number;
    };
}
//# sourceMappingURL=progress-tracker.d.ts.map