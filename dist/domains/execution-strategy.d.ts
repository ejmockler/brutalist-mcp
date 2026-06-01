/**
 * Core abstraction: ExecutionStrategy
 *
 * Defines how critique agents are orchestrated and how their results are synthesized.
 */
export type AgentCount = 1 | 3 | 'all';
export type ExecutionMode = 'parallel' | 'debate' | 'sequential' | 'tournament' | 'consensus';
export type SynthesisEngine = 'multi_perspective' | 'consensus_extraction' | 'best_of_breed' | 'voting' | 'concatenate';
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
export declare const DEFAULT_LIMITS: ExecutionLimits;
/**
 * Pre-built execution strategies
 */
export declare const ExecutionStrategies: {
    /**
     * Standard: Run all available agents in parallel, show all perspectives
     */
    PARALLEL_CRITIQUE: {
        id: string;
        name: string;
        agentCount: AgentCount;
        mode: ExecutionMode;
        synthesis: SynthesisEngine;
        limits: ExecutionLimits;
    };
    /**
     * Single agent: Fast, focused analysis from one perspective
     */
    SINGLE_AGENT: {
        id: string;
        name: string;
        agentCount: AgentCount;
        mode: ExecutionMode;
        synthesis: SynthesisEngine;
        limits: {
            maxTotalTime: number;
            /** Maximum execution time per agent (ms) */
            timeoutPerAgent: number;
            /** Maximum memory per agent (MB) */
            maxMemoryMB?: number;
            /** Maximum output size (characters) */
            maxOutputSize?: number;
        };
    };
    /**
     * Adversarial debate: Agents challenge each other
     */
    ADVERSARIAL_DEBATE: {
        id: string;
        name: string;
        agentCount: AgentCount;
        mode: ExecutionMode;
        synthesis: SynthesisEngine;
        limits: {
            maxTotalTime: number;
            /** Maximum execution time per agent (ms) */
            timeoutPerAgent: number;
            /** Maximum memory per agent (MB) */
            maxMemoryMB?: number;
            /** Maximum output size (characters) */
            maxOutputSize?: number;
        };
    };
    /**
     * Tournament: Agents compete, best wins
     */
    TOURNAMENT: {
        id: string;
        name: string;
        agentCount: AgentCount;
        mode: ExecutionMode;
        synthesis: SynthesisEngine;
        limits: ExecutionLimits;
    };
    /**
     * Sequential: One agent at a time, each builds on previous
     */
    SEQUENTIAL_BUILD: {
        id: string;
        name: string;
        agentCount: AgentCount;
        mode: ExecutionMode;
        synthesis: SynthesisEngine;
        limits: ExecutionLimits;
    };
};
/**
 * Helper to create a custom execution strategy
 */
export declare function createExecutionStrategy(id: string, name: string, config: Partial<ExecutionStrategy>): ExecutionStrategy;
//# sourceMappingURL=execution-strategy.d.ts.map