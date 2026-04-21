/**
 * Debate module — extracted from brutalist-server.ts.
 *
 * Public API:
 *   - DebateOrchestrator: main class, accepts dependencies via constructor injection
 *   - DebateOrchestratorDeps: dependency interface for constructor
 *   - DebateToolArgs: argument type for handleDebateToolExecution()
 *   - detectRefusal: refusal detection function (13 direct + 11 evasive patterns)
 *   - constitutionalAnchor: 3-tier position anchoring generator
 *   - synthesizeDebate: debate results -> markdown formatter
 *   - DebateTier: 'standard' | 'escalated' | 'decomposed'
 *   - DIRECT_REFUSAL_PATTERNS, EVASIVE_REFUSAL_PATTERNS: pattern arrays
 */

export {
  DebateOrchestrator,
  type DebateOrchestratorDeps,
  type DebateToolArgs,
  type DebateTier,
} from './debate-orchestrator.js';

export {
  detectRefusal,
  DIRECT_REFUSAL_PATTERNS,
  EVASIVE_REFUSAL_PATTERNS,
} from './refusal-detection.js';

export {
  constitutionalAnchor,
} from './constitutional.js';

export {
  synthesizeDebate,
} from './synthesis.js';
