/**
 * Quirk-Pinning Tests at Extracted Locations
 *
 * These tests directly import from the extracted module locations
 * (src/cli-adapters/ and src/debate/) to pin known behavioral quirks.
 *
 * Purpose: The characterization tests exercise these quirks through
 * composition-root proxy wrappers (cli-agents.ts, brutalist-server.ts).
 * If someone "fixes" a quirk in the extracted file and adds a compatibility
 * shim in the proxy wrapper, the characterization tests could still pass
 * while the actual production behavior changes. These tests prevent that
 * by importing from the extracted locations directly.
 *
 * Quirks pinned:
 *   1. parseNDJSON second-object loss (src/cli-adapters/shared.ts)
 *   2. agentAsymmetries always-true in 2-agent debates (src/debate/debate-orchestrator.ts)
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ---- Quirk 1: parseNDJSON second-object loss --------------------------------

// Direct import from extracted location (NOT from cli-agents.ts proxy)
import { parseNDJSON } from '../../src/cli-adapters/shared.js';

// Mock logger since parseNDJSON uses it for warnings.
// Also provides the structured-logger interface (`for`, `forOperation`) so
// BrutalistServer/DebateOrchestrator can bind scoped loggers against a stub.
// `shutdown` stays on the root stub for BrutalistServer.cleanup().
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

describe('Quirk pinning: parseNDJSON at extracted location (src/cli-adapters/shared.ts)', () => {

  it('parses first valid object but loses second when separated by non-JSON text', () => {
    // KNOWN QUIRK: When two valid JSON objects are separated by non-JSON text
    // (e.g., "NOT_JSON"), the second object is lost because the parser's start
    // pointer stays past the first object and the slice for the second object
    // includes the garbage prefix, causing JSON.parse to fail.
    //
    // This is the documented behavior. If this test starts failing (returning 2
    // objects instead of 1), it means the quirk was "fixed" -- which requires
    // coordinated verification that no downstream behavior depends on the loss.
    const input = '{"valid":true}\nNOT_JSON\n{"also_valid":true}';
    const result = parseNDJSON(input);

    expect(result).toHaveLength(1);
    expect((result[0] as any).valid).toBe(true);
    // The second object {"also_valid":true} is lost -- this is the quirk.
  });

  it('correctly parses consecutive objects without separating garbage', () => {
    // Baseline: when there is no non-JSON garbage between objects, both parse fine.
    const input = '{"a":1}\n{"b":2}';
    const result = parseNDJSON(input);

    expect(result).toHaveLength(2);
    expect((result[0] as any).a).toBe(1);
    expect((result[1] as any).b).toBe(2);
  });

  it('correctly parses objects separated only by whitespace', () => {
    const input = '{"a":1}   \n  \n  {"b":2}';
    const result = parseNDJSON(input);

    expect(result).toHaveLength(2);
    expect((result[0] as any).a).toBe(1);
    expect((result[1] as any).b).toBe(2);
  });

  it('loses second object when non-brace garbage separates two valid objects', () => {
    // Variant of the quirk: any non-brace text between objects triggers the loss.
    const input = '{"first":1}\nsome random text here\n{"second":2}';
    const result = parseNDJSON(input);

    expect(result).toHaveLength(1);
    expect((result[0] as any).first).toBe(1);
    // {"second":2} is lost due to the same mechanism.
  });

  it('returns empty array for empty input', () => {
    expect(parseNDJSON('')).toEqual([]);
    expect(parseNDJSON('   ')).toEqual([]);
  });
});

// ---- Quirk 2: agentAsymmetries always-true in 2-agent debates ---------------

// Direct import from extracted location (NOT through BrutalistServer proxy)
import { DebateOrchestrator } from '../../src/debate/index.js';
import type { DebateOrchestratorDeps } from '../../src/debate/index.js';
import type { DebateBehaviorSummary } from '../../src/types/brutalist.js';
import { createMetricsRegistry } from '../../src/metrics/index.js';
import { Logger } from '../../src/logger.js';

// Mock MCP SDK
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    tool: jest.fn(),
    connect: jest.fn(),
    close: jest.fn(),
    server: { notification: jest.fn() },
    sendLoggingMessage: jest.fn()
  }))
}));

describe('Quirk pinning: agentAsymmetries at extracted location (src/debate/debate-orchestrator.ts)', () => {
  let orchestrator: DebateOrchestrator;
  let mockExecuteSingleCLI: jest.Mock;

  beforeEach(() => {
    mockExecuteSingleCLI = jest.fn().mockImplementation(async (agent: any) => ({
      agent,
      success: true,
      output: 'Substantive analytical content with real arguments and evidence.',
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
        formatToolResponse: jest.fn<any>().mockReturnValue({ content: [] }),
        formatErrorResponse: jest.fn<any>().mockReturnValue({ content: [] }),
        extractFullContent: jest.fn<any>().mockReturnValue('full content'),
      } as any,
      config: { workingDirectory: '/tmp', defaultTimeout: 60000 },
      onStreamingEvent: jest.fn(),
      onProgressUpdate: jest.fn(),
      // Integrate-observability: deps bag now requires metrics + scoped log.
      metrics: createMetricsRegistry(),
      log: Logger.getInstance().for({ module: 'debate', operation: 'test' }),
    };

    orchestrator = new DebateOrchestrator(deps);
  });

  it('agentAsymmetries always reports asymmetric=true for each agent in a 2-agent debate, even when all turns are engaged', async () => {
    // KNOWN QUIRK: In a 2-agent debate, each agent is assigned exactly one
    // position (PRO or CON). The agentAsymmetries logic checks whether each
    // agent engaged on BOTH positions. Since an agent only ever has turns
    // for its assigned position, proEngaged !== conEngaged is always true,
    // making asymmetric=true for every agent.
    //
    // This means asymmetryDetected is ALWAYS true in a standard 2-agent
    // debate, even when all turns are fully engaged with no refusals.
    //
    // If this test starts failing (asymmetric becomes false), it means the
    // quirk was "fixed" in the extracted module -- which needs coordinated
    // verification across the codebase.

    // Call executeCLIDebate directly on the extracted DebateOrchestrator
    const result = await (orchestrator as any).executeCLIDebate({
      topic: 'Agent asymmetry quirk verification',
      proPosition: 'Pro thesis',
      conPosition: 'Con thesis',
      agents: ['claude', 'codex'],
      rounds: 1,
    });

    const behavior: DebateBehaviorSummary = result.debateBehavior;

    // asymmetryDetected should be true (the quirk)
    expect(behavior.asymmetry.detected).toBe(true);

    // Each agent should show asymmetric=true
    const asymmetries = behavior.asymmetry.agentAsymmetries;
    expect(asymmetries.length).toBe(2);

    for (const a of asymmetries) {
      expect(['claude', 'codex']).toContain(a.agent);
      // The quirk: asymmetric is always true because each agent only occupies one position
      expect(a.asymmetric).toBe(true);
      // Exactly one of proEngaged/conEngaged is true (the one the agent was assigned)
      expect(a.proEngaged !== a.conEngaged).toBe(true);
    }

    // Refusal rates should be 0 (no refusals occurred)
    expect(behavior.asymmetry.proRefusalRate).toBe(0);
    expect(behavior.asymmetry.conRefusalRate).toBe(0);
  });

  it('asymmetry detection is not a false positive from refusal rates', async () => {
    // Verify that the asymmetry comes from the agent position quirk,
    // not from refusal rate differences.
    const result = await (orchestrator as any).executeCLIDebate({
      topic: 'Refusal rate isolation',
      proPosition: 'Pro',
      conPosition: 'Con',
      agents: ['claude', 'codex'],
      rounds: 1,
    });

    const behavior: DebateBehaviorSummary = result.debateBehavior;

    // Both refusal rates are 0 -- so the 0.3 threshold is not triggered
    expect(Math.abs(behavior.asymmetry.proRefusalRate - behavior.asymmetry.conRefusalRate)).toBeLessThanOrEqual(0.3);

    // Yet asymmetry is still detected -- proving it comes from agentAsymmetries, not refusal rates
    expect(behavior.asymmetry.detected).toBe(true);
    expect(behavior.asymmetry.agentAsymmetries.some(a => a.asymmetric)).toBe(true);
  });
});
