/**
 * Core abstraction: ExecutionStrategy
 *
 * Defines how critique agents are orchestrated and how their results are synthesized.
 */

export type AgentCount = 1 | 3 | 'all';

export type ExecutionMode =
  | 'parallel'       // Run all agents simultaneously, combine results
  | 'debate'         // Agents challenge each other's findings
  | 'sequential'     // Run agents one after another
  | 'tournament'     // Agents compete, best result wins
  | 'consensus';     // Keep debating until consensus

export type SynthesisEngine =
  | 'multi_perspective'    // Show all perspectives side-by-side
  | 'consensus_extraction' // Extract common themes
  | 'best_of_breed'        // Pick the most thorough critique
  | 'voting'               // Democratic vote on findings
  | 'concatenate';         // Simple concatenation

export interface ExecutionLimits {
  /** Maximum execution time per agent (ms) */
  timeoutPerAgent: number;

  /** Maximum total execution time (ms) */
  maxTotalTime: number;

  /** Maximum memory per agent (MB) */
  maxMemoryMB?: number;

  /** Maximum output size (characters) */
  maxOutputSize?: number;
}

export interface ExecutionStrategy {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** How many agents to run */
  agentCount: AgentCount;

  /** How agents interact */
  mode: ExecutionMode;

  /** How to synthesize results */
  synthesis: SynthesisEngine;

  /** Resource limits */
  limits: ExecutionLimits;

  /** Optional: custom synthesis function */
  customSynthesis?: (results: any[]) => string;
}

/**
 * Default execution limits
 */
export const DEFAULT_LIMITS: ExecutionLimits = {
  timeoutPerAgent: 1800000,  // 30 minutes per agent
  maxTotalTime: 3600000,     // 1 hour total
  maxMemoryMB: 2048,         // 2GB
  maxOutputSize: 1000000     // 1M characters
};

/**
 * Pre-built execution strategies
 */
export const ExecutionStrategies = {
  /**
   * Standard: Run all available agents in parallel, show all perspectives
   */
  PARALLEL_CRITIQUE: {
    id: 'parallel_critique',
    name: 'Parallel Critique',
    agentCount: 'all' as AgentCount,
    mode: 'parallel' as ExecutionMode,
    synthesis: 'multi_perspective' as SynthesisEngine,
    limits: DEFAULT_LIMITS
  },

  /**
   * Single agent: Fast, focused analysis from one perspective
   */
  SINGLE_AGENT: {
    id: 'single_agent',
    name: 'Single Agent',
    agentCount: 1 as AgentCount,
    mode: 'parallel' as ExecutionMode,
    synthesis: 'concatenate' as SynthesisEngine,
    limits: {
      ...DEFAULT_LIMITS,
      maxTotalTime: 1800000  // 30 minutes
    }
  },

  /**
   * Adversarial debate: Agents challenge each other
   */
  ADVERSARIAL_DEBATE: {
    id: 'adversarial_debate',
    name: 'Adversarial Debate',
    agentCount: 3 as AgentCount,
    mode: 'debate' as ExecutionMode,
    synthesis: 'consensus_extraction' as SynthesisEngine,
    limits: {
      ...DEFAULT_LIMITS,
      maxTotalTime: 5400000  // 90 minutes (multiple rounds)
    }
  },

  /**
   * Tournament: Agents compete, best wins
   */
  TOURNAMENT: {
    id: 'tournament',
    name: 'Tournament',
    agentCount: 'all' as AgentCount,
    mode: 'tournament' as ExecutionMode,
    synthesis: 'best_of_breed' as SynthesisEngine,
    limits: DEFAULT_LIMITS
  },

  /**
   * Sequential: One agent at a time, each builds on previous
   */
  SEQUENTIAL_BUILD: {
    id: 'sequential_build',
    name: 'Sequential Build',
    agentCount: 'all' as AgentCount,
    mode: 'sequential' as ExecutionMode,
    synthesis: 'concatenate' as SynthesisEngine,
    limits: DEFAULT_LIMITS
  }
};

/**
 * Helper to create a custom execution strategy
 */
export function createExecutionStrategy(
  id: string,
  name: string,
  config: Partial<ExecutionStrategy>
): ExecutionStrategy {
  return {
    id,
    name,
    agentCount: config.agentCount || 'all',
    mode: config.mode || 'parallel',
    synthesis: config.synthesis || 'multi_perspective',
    limits: config.limits || DEFAULT_LIMITS,
    customSynthesis: config.customSynthesis
  };
}
