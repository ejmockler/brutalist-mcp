/**
 * Shared test helper: builds a DebateOrchestratorDeps bag pre-populated with
 * a fresh metrics registry and a scoped test logger. Tests that construct
 * DebateOrchestrator directly use this to avoid boilerplate.
 *
 * Design choices:
 *   - `createMetricsRegistry()` returns a fresh registry per call (no
 *     cross-test contamination). This matches the registry's factory
 *     contract (`createMetricsRegistry() !== createMetricsRegistry()`).
 *   - Scoped logger is bound to `{ module: 'debate', operation: 'test' }`
 *     at the module scope the production composition root uses
 *     (`module='debate'`), so any structured-logging assertions that would
 *     be added later operate on the canonical module name.
 *   - Override pattern accepts partial deps so individual tests can
 *     replace specific fields (e.g., custom cliOrchestrator mocks) without
 *     rebuilding the whole bag.
 */
import { jest } from '@jest/globals';
import type { DebateOrchestratorDeps } from '../../../src/debate/index.js';
import { createMetricsRegistry } from '../../../src/metrics/index.js';
import { Logger } from '../../../src/logger.js';

/**
 * Build a minimal DebateOrchestratorDeps suitable for unit tests. All
 * collaborators default to inert jest mocks; callers override the ones
 * they need to exercise via the `overrides` parameter.
 */
export function createTestDebateDeps(
  overrides: Partial<DebateOrchestratorDeps> = {},
): DebateOrchestratorDeps {
  const defaults: DebateOrchestratorDeps = {
    cliOrchestrator: {
      detectCLIContext: jest.fn<any>(),
      executeSingleCLI: jest.fn<any>(),
      selectSingleCLI: jest.fn<any>(),
      executeAllCLIs: jest.fn<any>(),
    } as any,
    responseCache: {
      generateCacheKey: jest.fn<any>().mockReturnValue('test-key'),
      get: jest.fn<any>().mockResolvedValue(null),
      set: jest.fn<any>().mockResolvedValue({ contextId: 'ctx-test' }),
      findContextIdForKey: jest.fn<any>(),
      getByContextId: jest.fn<any>(),
      createAlias: jest.fn<any>(),
      generateContextId: jest.fn<any>(),
      updateByContextId: jest.fn<any>(),
    } as any,
    formatter: {
      formatToolResponse: jest.fn().mockReturnValue({ content: [] }),
      formatErrorResponse: jest.fn().mockReturnValue({ content: [] }),
      extractFullContent: jest.fn().mockReturnValue('full content'),
    } as any,
    config: { workingDirectory: '/tmp', defaultTimeout: 60000 },
    onStreamingEvent: jest.fn(),
    onProgressUpdate: jest.fn(),
    metrics: createMetricsRegistry(),
    log: Logger.getInstance().for({ module: 'debate', operation: 'test' }),
  };
  return { ...defaults, ...overrides };
}
