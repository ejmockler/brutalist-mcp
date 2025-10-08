import { EventEmitter } from 'events';
import { logger } from '../logger.js';
import { StreamingEvent } from '../cli-agents.js';

/**
 * Analysis progress phases with detailed milestones
 */
export enum AnalysisPhase {
  INITIALIZING = 'initializing',
  COLLECTING_DATA = 'collecting_data',
  ANALYZING = 'analyzing',
  PROCESSING_RESULTS = 'processing_results',
  GENERATING_REPORT = 'generating_report',
  COMPLETE = 'complete',
  ERROR = 'error'
}

/**
 * Progress milestone definition
 */
export interface ProgressMilestone {
  id: string;
  phase: AnalysisPhase;
  name: string;
  description: string;
  estimatedDuration?: number; // milliseconds
  weight: number; // 0-1, contribution to overall progress
  dependencies?: string[]; // milestone IDs that must complete first
  optional?: boolean; // whether milestone can be skipped
}

/**
 * Progress state tracking
 */
export interface ProgressState {
  currentPhase: AnalysisPhase;
  overallProgress: number; // 0-1
  phaseProgress: number; // 0-1 within current phase
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
export const ANALYSIS_MILESTONES: Record<string, ProgressMilestone[]> = {
  roast_codebase: [
    {
      id: 'init_analysis',
      phase: AnalysisPhase.INITIALIZING,
      name: 'Initialize Analysis',
      description: 'Setting up analysis environment and validating target path',
      estimatedDuration: 5000,
      weight: 0.05
    },
    {
      id: 'scan_structure',
      phase: AnalysisPhase.COLLECTING_DATA,
      name: 'Scan Code Structure',
      description: 'Analyzing directory structure and identifying files',
      estimatedDuration: 15000,
      weight: 0.15,
      dependencies: ['init_analysis']
    },
    {
      id: 'read_core_files',
      phase: AnalysisPhase.COLLECTING_DATA,
      name: 'Read Core Files',
      description: 'Reading and parsing main source files',
      estimatedDuration: 30000,
      weight: 0.20,
      dependencies: ['scan_structure']
    },
    {
      id: 'analyze_architecture',
      phase: AnalysisPhase.ANALYZING,
      name: 'Analyze Architecture',
      description: 'Evaluating system architecture and design patterns',
      estimatedDuration: 45000,
      weight: 0.25,
      dependencies: ['read_core_files']
    },
    {
      id: 'security_audit',
      phase: AnalysisPhase.ANALYZING,
      name: 'Security Audit',
      description: 'Scanning for security vulnerabilities and issues',
      estimatedDuration: 35000,
      weight: 0.20,
      dependencies: ['read_core_files']
    },
    {
      id: 'performance_analysis',
      phase: AnalysisPhase.ANALYZING,
      name: 'Performance Analysis',
      description: 'Identifying performance bottlenecks and inefficiencies',
      estimatedDuration: 25000,
      weight: 0.10,
      dependencies: ['analyze_architecture'],
      optional: true
    },
    {
      id: 'generate_findings',
      phase: AnalysisPhase.PROCESSING_RESULTS,
      name: 'Generate Findings',
      description: 'Compiling analysis results and prioritizing issues',
      estimatedDuration: 20000,
      weight: 0.05,
      dependencies: ['analyze_architecture', 'security_audit']
    }
  ],
  
  roast_idea: [
    {
      id: 'idea_validation',
      phase: AnalysisPhase.INITIALIZING,
      name: 'Validate Idea',
      description: 'Understanding and validating the core concept',
      estimatedDuration: 8000,
      weight: 0.10
    },
    {
      id: 'market_research',
      phase: AnalysisPhase.COLLECTING_DATA,
      name: 'Market Research',
      description: 'Analyzing market conditions and competition',
      estimatedDuration: 25000,
      weight: 0.30,
      dependencies: ['idea_validation']
    },
    {
      id: 'feasibility_analysis',
      phase: AnalysisPhase.ANALYZING,
      name: 'Feasibility Analysis',
      description: 'Evaluating technical and business feasibility',
      estimatedDuration: 30000,
      weight: 0.35,
      dependencies: ['market_research']
    },
    {
      id: 'risk_assessment',
      phase: AnalysisPhase.ANALYZING,
      name: 'Risk Assessment',
      description: 'Identifying potential risks and failure modes',
      estimatedDuration: 20000,
      weight: 0.20,
      dependencies: ['feasibility_analysis']
    },
    {
      id: 'recommendation_synthesis',
      phase: AnalysisPhase.PROCESSING_RESULTS,
      name: 'Synthesize Recommendations',
      description: 'Generating actionable recommendations and critique',
      estimatedDuration: 15000,
      weight: 0.05,
      dependencies: ['risk_assessment']
    }
  ],
  
  roast_security: [
    {
      id: 'threat_modeling',
      phase: AnalysisPhase.INITIALIZING,
      name: 'Threat Modeling',
      description: 'Identifying attack vectors and threat landscape',
      estimatedDuration: 15000,
      weight: 0.20
    },
    {
      id: 'vulnerability_scan',
      phase: AnalysisPhase.ANALYZING,
      name: 'Vulnerability Scan',
      description: 'Scanning for known security vulnerabilities',
      estimatedDuration: 40000,
      weight: 0.40,
      dependencies: ['threat_modeling']
    },
    {
      id: 'privilege_analysis',
      phase: AnalysisPhase.ANALYZING,
      name: 'Privilege Analysis',
      description: 'Analyzing access controls and privilege escalation',
      estimatedDuration: 25000,
      weight: 0.25,
      dependencies: ['vulnerability_scan']
    },
    {
      id: 'compliance_check',
      phase: AnalysisPhase.ANALYZING,
      name: 'Compliance Check',
      description: 'Checking compliance with security standards',
      estimatedDuration: 20000,
      weight: 0.10,
      dependencies: ['privilege_analysis'],
      optional: true
    },
    {
      id: 'security_recommendations',
      phase: AnalysisPhase.PROCESSING_RESULTS,
      name: 'Security Recommendations',
      description: 'Generating prioritized security recommendations',
      estimatedDuration: 10000,
      weight: 0.05,
      dependencies: ['privilege_analysis']
    }
  ]
};

/**
 * Progress milestone system with intelligent phase detection
 * 
 * Features:
 * - Dynamic milestone tracking based on analysis type
 * - Intelligent progress estimation with dependencies
 * - Phase transition detection from CLI output
 * - ETA calculation with adaptive learning
 * - Progress events for real-time updates
 */
export class ProgressTracker extends EventEmitter {
  private state: ProgressState;
  private milestones: ProgressMilestone[];
  private sessionId: string;
  private analysisType: string;
  
  // Pattern matching for phase detection
  private readonly PHASE_PATTERNS = {
    [AnalysisPhase.INITIALIZING]: [
      /initializing|starting|setting up|loading/i,
      /^Starting analysis/i,
      /Validating/i
    ],
    [AnalysisPhase.COLLECTING_DATA]: [
      /reading|scanning|collecting|gathering|loading files/i,
      /Found \d+ files/i,
      /Processing directory/i,
      /Analyzing structure/i
    ],
    [AnalysisPhase.ANALYZING]: [
      /analyzing|examining|evaluating|processing|reviewing/i,
      /Security scan/i,
      /Architecture analysis/i,
      /Performance check/i,
      /^CRITICAL|^WARNING|^ERROR/i
    ],
    [AnalysisPhase.PROCESSING_RESULTS]: [
      /generating|compiling|summarizing|finalizing/i,
      /Creating report/i,
      /Summary of findings/i
    ],
    [AnalysisPhase.COMPLETE]: [
      /analysis complete|finished|done|summary complete/i,
      /Total issues found/i,
      /Analysis completed/i
    ],
    [AnalysisPhase.ERROR]: [
      /failed|error|exception|crashed|timeout/i,
      /Analysis failed/i,
      /Fatal error/i
    ]
  };
  
  // Milestone triggers based on content patterns
  private readonly MILESTONE_TRIGGERS: Record<string, RegExp[]> = {
    scan_structure: [
      /Found \d+ files/i,
      /Directory structure:/i,
      /Scanning.*files/i
    ],
    read_core_files: [
      /Reading.*\.js|\.ts|\.py|\.go/i,
      /Processing.*files/i,
      /File analysis/i
    ],
    security_audit: [
      /Security scan|vulnerability|CRITICAL|HIGH RISK/i,
      /Authentication|Authorization|Injection/i,
      /Security issue/i
    ],
    performance_analysis: [
      /Performance|bottleneck|optimization|slow/i,
      /Memory usage|CPU intensive/i,
      /Performance issue/i
    ],
    threat_modeling: [
      /Threat model|attack vector|threat landscape/i,
      /Potential attacks/i
    ],
    vulnerability_scan: [
      /Vulnerability scan|CVE-|security flaw/i,
      /Known vulnerabilities/i
    ]
  };
  
  constructor(sessionId: string, analysisType: string) {
    super();
    this.sessionId = sessionId;
    this.analysisType = analysisType;
    this.milestones = ANALYSIS_MILESTONES[analysisType] || [];
    
    this.state = {
      currentPhase: AnalysisPhase.INITIALIZING,
      overallProgress: 0,
      phaseProgress: 0,
      completedMilestones: new Set(),
      startTime: Date.now(),
      lastUpdate: Date.now(),
      errors: []
    };
    
    logger.info(`📊 Progress tracker initialized for ${analysisType} (${this.milestones.length} milestones)`);
  }
  
  /**
   * Process streaming event and update progress
   */
  processEvent(event: StreamingEvent): void {
    if (event.sessionId !== this.sessionId) {
      return;
    }
    
    const content = event.content || '';
    this.state.lastUpdate = Date.now();
    
    // Detect phase transitions
    this.detectPhaseFromContent(content);
    
    // Detect milestone completion
    this.detectMilestonesFromContent(content);
    
    // Handle errors
    if (event.type === 'agent_error') {
      this.handleError(content);
    }
    
    // Update progress calculations
    this.updateProgress();
    
    // Emit progress event
    this.emitProgressEvent('progress_updated');
  }
  
  /**
   * Detect current phase from CLI output content
   */
  private detectPhaseFromContent(content: string): void {
    for (const [phase, patterns] of Object.entries(this.PHASE_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(content)) {
          this.transitionToPhase(phase as AnalysisPhase);
          return;
        }
      }
    }
  }
  
  /**
   * Detect milestone completion from content
   */
  private detectMilestonesFromContent(content: string): void {
    for (const milestone of this.milestones) {
      // Skip already completed milestones
      if (this.state.completedMilestones.has(milestone.id)) {
        continue;
      }
      
      // Check if dependencies are met
      if (!this.areDependenciesMet(milestone)) {
        continue;
      }
      
      // Check milestone triggers
      const triggers = this.MILESTONE_TRIGGERS[milestone.id];
      if (triggers) {
        for (const trigger of triggers) {
          if (trigger.test(content)) {
            this.completeMilestone(milestone);
            break;
          }
        }
      }
      
      // Auto-complete milestones when phase advances beyond milestone phase
      if (this.shouldAutoCompleteMilestone(milestone)) {
        this.completeMilestone(milestone);
      }
    }
  }
  
  /**
   * Transition to new phase
   */
  private transitionToPhase(newPhase: AnalysisPhase): void {
    if (this.state.currentPhase === newPhase) {
      return;
    }
    
    logger.debug(`🔄 Phase transition: ${this.state.currentPhase} → ${newPhase}`);
    
    const oldPhase = this.state.currentPhase;
    this.state.currentPhase = newPhase;
    this.state.phaseProgress = 0;
    
    // Auto-complete milestones from previous phases
    this.autoCompletePreviousPhaseMilestones(oldPhase);
    
    this.emitProgressEvent('phase_changed', {
      previousPhase: oldPhase,
      newPhase
    });
  }
  
  /**
   * Complete a milestone
   */
  private completeMilestone(milestone: ProgressMilestone): void {
    if (this.state.completedMilestones.has(milestone.id)) {
      return;
    }
    
    logger.info(`✅ Milestone completed: ${milestone.name}`);
    
    this.state.completedMilestones.add(milestone.id);
    this.state.currentMilestone = milestone;
    
    this.emitProgressEvent('milestone_completed', {
      milestone: milestone.id,
      milestoneName: milestone.name
    });
  }
  
  /**
   * Check if milestone dependencies are met
   */
  private areDependenciesMet(milestone: ProgressMilestone): boolean {
    if (!milestone.dependencies) {
      return true;
    }
    
    return milestone.dependencies.every(depId => 
      this.state.completedMilestones.has(depId)
    );
  }
  
  /**
   * Check if milestone should be auto-completed
   */
  private shouldAutoCompleteMilestone(milestone: ProgressMilestone): boolean {
    // Get phase order
    const phases = Object.values(AnalysisPhase);
    const currentPhaseIndex = phases.indexOf(this.state.currentPhase);
    const milestonePhaseIndex = phases.indexOf(milestone.phase);
    
    // Auto-complete if we've moved past the milestone's phase
    return currentPhaseIndex > milestonePhaseIndex;
  }
  
  /**
   * Auto-complete milestones from previous phases
   */
  private autoCompletePreviousPhaseMilestones(previousPhase: AnalysisPhase): void {
    const phases = Object.values(AnalysisPhase);
    const previousPhaseIndex = phases.indexOf(previousPhase);
    
    for (const milestone of this.milestones) {
      const milestonePhaseIndex = phases.indexOf(milestone.phase);
      
      if (milestonePhaseIndex <= previousPhaseIndex && 
          !this.state.completedMilestones.has(milestone.id) &&
          this.areDependenciesMet(milestone)) {
        
        logger.debug(`🔄 Auto-completing milestone: ${milestone.name}`);
        this.completeMilestone(milestone);
      }
    }
  }
  
  /**
   * Update progress calculations
   */
  private updateProgress(): void {
    // Calculate overall progress based on completed milestone weights
    let totalWeight = 0;
    let completedWeight = 0;
    
    for (const milestone of this.milestones) {
      totalWeight += milestone.weight;
      if (this.state.completedMilestones.has(milestone.id)) {
        completedWeight += milestone.weight;
      }
    }
    
    this.state.overallProgress = totalWeight > 0 ? completedWeight / totalWeight : 0;
    
    // Calculate phase progress
    const phaseMilestones = this.milestones.filter(m => m.phase === this.state.currentPhase);
    const completedPhaseMilestones = phaseMilestones.filter(m => 
      this.state.completedMilestones.has(m.id)
    );
    
    this.state.phaseProgress = phaseMilestones.length > 0 
      ? completedPhaseMilestones.length / phaseMilestones.length 
      : 0;
    
    // Estimate completion time
    this.updateEstimatedCompletion();
  }
  
  /**
   * Update estimated completion time
   */
  private updateEstimatedCompletion(): void {
    if (this.state.overallProgress <= 0) {
      return;
    }
    
    const elapsed = Date.now() - this.state.startTime;
    const estimatedTotal = elapsed / this.state.overallProgress;
    this.state.estimatedCompletion = this.state.startTime + estimatedTotal;
  }
  
  /**
   * Handle error in analysis
   */
  private handleError(error: string): void {
    this.state.errors.push(error);
    this.state.currentPhase = AnalysisPhase.ERROR;
    
    this.emitProgressEvent('analysis_error', {
      error,
      errorCount: this.state.errors.length
    });
  }
  
  /**
   * Mark analysis as complete
   */
  markComplete(): void {
    this.state.currentPhase = AnalysisPhase.COMPLETE;
    this.state.overallProgress = 1.0;
    this.state.phaseProgress = 1.0;
    
    // Auto-complete any remaining milestones
    for (const milestone of this.milestones) {
      if (!this.state.completedMilestones.has(milestone.id) && 
          this.areDependenciesMet(milestone)) {
        this.completeMilestone(milestone);
      }
    }
    
    this.emitProgressEvent('analysis_complete', {
      duration: Date.now() - this.state.startTime,
      totalMilestones: this.milestones.length,
      completedMilestones: this.state.completedMilestones.size,
      errorCount: this.state.errors.length
    });
  }
  
  /**
   * Emit progress event
   */
  private emitProgressEvent(type: ProgressEvent['type'], metadata?: Record<string, any>): void {
    const event: ProgressEvent = {
      type,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      phase: this.state.currentPhase,
      milestone: this.state.currentMilestone,
      progress: {
        overall: this.state.overallProgress,
        phase: this.state.phaseProgress
      },
      estimatedCompletion: this.state.estimatedCompletion,
      metadata
    };
    
    this.emit('progress', event);
  }
  
  /**
   * Get current progress state
   */
  getState(): ProgressState {
    return { ...this.state };
  }
  
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
  } {
    const timeRemaining = this.state.estimatedCompletion 
      ? Math.max(0, this.state.estimatedCompletion - Date.now())
      : undefined;
    
    return {
      phase: this.state.currentPhase,
      overallProgress: Math.round(this.state.overallProgress * 100) / 100,
      phaseProgress: Math.round(this.state.phaseProgress * 100) / 100,
      currentMilestone: this.state.currentMilestone?.name,
      estimatedTimeRemaining: timeRemaining,
      completedMilestones: this.state.completedMilestones.size,
      totalMilestones: this.milestones.length
    };
  }
}