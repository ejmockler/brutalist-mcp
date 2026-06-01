/**
 * Core abstraction: ExecutionStrategy
 *
 * Defines how critique agents are orchestrated and how their results are synthesized.
 */
/**
 * Default execution limits
 */
export const DEFAULT_LIMITS = {
    timeoutPerAgent: 1800000, // 30 minutes per agent
    maxTotalTime: 3600000, // 1 hour total
    maxMemoryMB: 2048, // 2GB
    maxOutputSize: 1000000 // 1M characters
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
        agentCount: 'all',
        mode: 'parallel',
        synthesis: 'multi_perspective',
        limits: DEFAULT_LIMITS
    },
    /**
     * Single agent: Fast, focused analysis from one perspective
     */
    SINGLE_AGENT: {
        id: 'single_agent',
        name: 'Single Agent',
        agentCount: 1,
        mode: 'parallel',
        synthesis: 'concatenate',
        limits: {
            ...DEFAULT_LIMITS,
            maxTotalTime: 1800000 // 30 minutes
        }
    },
    /**
     * Adversarial debate: Agents challenge each other
     */
    ADVERSARIAL_DEBATE: {
        id: 'adversarial_debate',
        name: 'Adversarial Debate',
        agentCount: 3,
        mode: 'debate',
        synthesis: 'consensus_extraction',
        limits: {
            ...DEFAULT_LIMITS,
            maxTotalTime: 5400000 // 90 minutes (multiple rounds)
        }
    },
    /**
     * Tournament: Agents compete, best wins
     */
    TOURNAMENT: {
        id: 'tournament',
        name: 'Tournament',
        agentCount: 'all',
        mode: 'tournament',
        synthesis: 'best_of_breed',
        limits: DEFAULT_LIMITS
    },
    /**
     * Sequential: One agent at a time, each builds on previous
     */
    SEQUENTIAL_BUILD: {
        id: 'sequential_build',
        name: 'Sequential Build',
        agentCount: 'all',
        mode: 'sequential',
        synthesis: 'concatenate',
        limits: DEFAULT_LIMITS
    }
};
/**
 * Helper to create a custom execution strategy
 */
export function createExecutionStrategy(id, name, config) {
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
//# sourceMappingURL=execution-strategy.js.map