/**
 * SDK-mocked tests for orchestrator.run().
 *
 * The Claude Agent SDK is mocked at the module boundary so we can:
 *   - inject a controlled SDKMessage stream into query()
 *   - capture the submit_findings tool handler from tool() and invoke
 *     it manually as the agent would, with arbitrary payloads
 *
 * These tests close the run-level coverage gap identified by the
 * brutalist self-review (round 2): without them, submitCount logic,
 * OrchestratorIncompleteError, env composition, and
 * pathToClaudeCodeExecutable wiring were all unguarded.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { existsSync, readFileSync } from 'node:fs';

// Mock the SDK before importing orchestrator. Capture the tool handler
// from the `tool()` call so tests can drive it like the agent would.
let capturedHandler:
  | ((args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>)
  | undefined;
let capturedQueryOptions: any;

const mockQuery = jest.fn() as any;

jest.unstable_mockModule('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: any) => {
    capturedQueryOptions = params.options;
    return mockQuery(params);
  },
  tool: (_name: string, _description: string, _shape: unknown, handler: any) => {
    capturedHandler = handler;
    return { name: _name };
  },
  createSdkMcpServer: (config: any) => ({ type: 'sdk' as const, ...config }),
}));

// Defer the run import until after the mock is registered.
const { run, OrchestratorIncompleteError, OrchestratorTimeoutError } = await import(
  '../src/orchestrator.js'
);

const FIXTURE_OK = {
  schemaVersion: 1 as const,
  findings: [],
  perCli: [],
  synthesis: 'all clear',
  outOfDiff: [],
};

function makeMessageStream(invokeHandler: () => Promise<unknown>) {
  // Return an async generator that calls the captured tool handler
  // before completing — modeling the agent calling submit_findings.
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system' as const };
      await invokeHandler();
      yield { type: 'result' as const };
    },
  };
}

beforeEach(() => {
  capturedHandler = undefined;
  capturedQueryOptions = undefined;
  mockQuery.mockReset();
});

describe('orchestrator.run()', () => {
  it('forwards CLAUDE_CODE_OAUTH_TOKEN to both the SDK env and the brutalist-mcp env', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );

    await run({
      repoPath: '/tmp/repo',
      oauthToken: 'oauth-secret',
    });

    expect(capturedQueryOptions.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-secret');
    const brutalistServer = capturedQueryOptions.mcpServers.brutalist;
    expect(brutalistServer.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-secret');
  });

  it('defaults the brain to the most capable model (claude-opus-4-8)', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );
    await run({ repoPath: '/tmp/repo', oauthToken: 'x' });
    expect(capturedQueryOptions.model).toBe('claude-opus-4-8');
  });

  it('lets an explicit model override the default', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );
    await run({ repoPath: '/tmp/repo', oauthToken: 'x', model: 'claude-sonnet-4-6' });
    expect(capturedQueryOptions.model).toBe('claude-sonnet-4-6');
  });

  // PR-diff delivery to the brutalist-mcp subprocess. A large diff in an env
  // var trips MAX_ARG_STRLEN (~128 KB) and throws `spawn E2BIG` at SDK init,
  // killing the whole review (bobnetsec/core PR #12). The diff must travel via
  // a temp FILE; the inline env var is kept only for small diffs (back-compat).
  describe('PR-diff delivery (E2BIG guard)', () => {
    const SMALL_DIFF = 'diff --git a/s.ts b/s.ts\n@@ -1 +1 @@\n-a\n+b';

    it('routes a large diff via a temp FILE, never inline, and cleans it up', async () => {
      const bigDiff = 'diff --git a/big.ts b/big.ts\n@@ -1 +1 @@\n-x\n+' + 'y'.repeat(200 * 1024);
      let existedDuringRun = false;
      let contentDuringRun = '';
      let filePathDuringRun = '';
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'system' as const };
          // The diff file exists for the lifetime of the query drain.
          filePathDuringRun = capturedQueryOptions.mcpServers.brutalist.env.BRUTALIST_PR_DIFF_FILE;
          existedDuringRun = existsSync(filePathDuringRun);
          contentDuringRun = readFileSync(filePathDuringRun, 'utf-8');
          await capturedHandler!(FIXTURE_OK);
          yield { type: 'result' as const };
        },
      });

      await run({ repoPath: '/tmp/repo', oauthToken: 'x', focus: bigDiff });

      const env = capturedQueryOptions.mcpServers.brutalist.env;
      expect(env.BRUTALIST_PR_DIFF_FILE).toBeTruthy();
      expect(env.BRUTALIST_PR_DIFF).toBeUndefined(); // large diff is NEVER inline
      expect(existedDuringRun).toBe(true);
      expect(contentDuringRun).toBe(bigDiff); // full diff, no truncation
      expect(existsSync(filePathDuringRun)).toBe(false); // unlinked in finally
    });

    it('also passes a small diff inline (back-compat) alongside the file', async () => {
      mockQuery.mockReturnValue(
        makeMessageStream(async () => {
          await capturedHandler!(FIXTURE_OK);
        }),
      );

      await run({ repoPath: '/tmp/repo', oauthToken: 'x', focus: SMALL_DIFF });

      const env = capturedQueryOptions.mcpServers.brutalist.env;
      expect(env.BRUTALIST_PR_DIFF_FILE).toBeTruthy();
      expect(env.BRUTALIST_PR_DIFF).toBe(SMALL_DIFF);
    });

    it('sets neither diff var when focus is not a unified diff', async () => {
      mockQuery.mockReturnValue(
        makeMessageStream(async () => {
          await capturedHandler!(FIXTURE_OK);
        }),
      );

      await run({ repoPath: '/tmp/repo', oauthToken: 'x', focus: 'review the architecture please' });

      const env = capturedQueryOptions.mcpServers.brutalist.env;
      expect(env.BRUTALIST_PR_DIFF_FILE).toBeUndefined();
      expect(env.BRUTALIST_PR_DIFF).toBeUndefined();
    });
  });

  it('inherits PATH/HOME from process.env into spawned subprocesses', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );
    process.env.PATH = '/test/path';
    process.env.HOME = '/test/home';

    await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });

    expect(capturedQueryOptions.env.PATH).toBe('/test/path');
    expect(capturedQueryOptions.env.HOME).toBe('/test/home');
    expect(capturedQueryOptions.mcpServers.brutalist.env.PATH).toBe('/test/path');
    expect(capturedQueryOptions.mcpServers.brutalist.env.HOME).toBe('/test/home');
  });

  it('passes claudeCodeExecutablePath through to the SDK options when provided', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );

    await run({
      repoPath: '/tmp/repo',
      oauthToken: 'tok',
      claudeCodeExecutablePath: '/usr/local/bin/claude',
    });

    expect(capturedQueryOptions.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
  });

  it('omits claudeCodeExecutablePath when not provided so the SDK auto-detects', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );

    await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });

    expect(capturedQueryOptions.pathToClaudeCodeExecutable).toBeUndefined();
  });

  it('aborts the SDK iterator when the wall-clock budget elapses', async () => {
    // Return an iterator that stalls forever on the FIRST message
    // — simulates a wedged child CLI subprocess. The orchestrator's
    // AbortController must fire and surface OrchestratorTimeoutError.
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        // Look up the abort signal from the captured query options and
        // throw when it fires, mirroring SDK behavior.
        const signal = capturedQueryOptions.abortController.signal as AbortSignal;
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
        yield { type: 'never' as const };
      },
    });

    await expect(
      run({
        repoPath: '/tmp/repo',
        oauthToken: 'tok',
        timeoutMs: 50, // very tight; the abort fires almost immediately
      }),
    ).rejects.toThrow(OrchestratorTimeoutError);
  });

  it('passes an abortController on queryOptions for cancellation', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );

    await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });

    expect(capturedQueryOptions.abortController).toBeInstanceOf(AbortController);
  });

  it('caps agent turns to bound runaway loops (maxTurns)', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );

    await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });

    // The exact number is a guardrail; the contract is "non-trivial finite cap"
    // with real headroom above the old 20 (pagination alone can burn that).
    expect(typeof capturedQueryOptions.maxTurns).toBe('number');
    expect(capturedQueryOptions.maxTurns).toBeGreaterThanOrEqual(40);
    expect(capturedQueryOptions.maxTurns).toBeLessThan(100);
  });

  it('lets an explicit maxTurns option override the default', async () => {
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
      }),
    );

    await run({ repoPath: '/tmp/repo', oauthToken: 'tok', maxTurns: 7 });

    expect(capturedQueryOptions.maxTurns).toBe(7);
  });

  it('honors BRUTALIST_ORCHESTRATOR_MAX_TURNS, but the explicit option wins', async () => {
    const prev = process.env.BRUTALIST_ORCHESTRATOR_MAX_TURNS;
    try {
      process.env.BRUTALIST_ORCHESTRATOR_MAX_TURNS = '12';

      mockQuery.mockReturnValue(
        makeMessageStream(async () => {
          await capturedHandler!(FIXTURE_OK);
        }),
      );
      await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });
      expect(capturedQueryOptions.maxTurns).toBe(12);

      // Explicit option takes precedence over the env var.
      mockQuery.mockReturnValue(
        makeMessageStream(async () => {
          await capturedHandler!(FIXTURE_OK);
        }),
      );
      await run({ repoPath: '/tmp/repo', oauthToken: 'tok', maxTurns: 33 });
      expect(capturedQueryOptions.maxTurns).toBe(33);
    } finally {
      if (prev === undefined) delete process.env.BRUTALIST_ORCHESTRATOR_MAX_TURNS;
      else process.env.BRUTALIST_ORCHESTRATOR_MAX_TURNS = prev;
    }
  });

  it('throws OrchestratorIncompleteError when the agent never calls submit_findings', async () => {
    // Stream completes without invoking the tool handler.
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system' as const };
        yield { type: 'result' as const };
      },
    });

    await expect(run({ repoPath: '/tmp/repo', oauthToken: 'tok' })).rejects.toThrow(
      OrchestratorIncompleteError,
    );
  });

  it('captures the validated payload when submit_findings is called', async () => {
    const fixture = {
      schemaVersion: 1 as const,
      findings: [
        {
          cli: 'codex' as const,
          path: 'src/auth.ts',
          side: 'RIGHT' as const,
          severity: 'critical' as const,
          category: 'security',
          title: 'JWT in localStorage',
          body: 'Detail',
          verbatimQuote: 'localStorage.getItem',
        },
      ],
      perCli: [],
      synthesis: 'cap submitted',
      outOfDiff: [],
    };
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(fixture);
      }),
    );

    const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });
    expect(result.findings).toHaveLength(1);
    expect(result.synthesis).toBe('cap submitted');
  });

  it('rejects a second submit_findings call (terminal-action contract)', async () => {
    let secondResult: any;
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        await capturedHandler!(FIXTURE_OK);
        // Agent attempts a second submission — must be rejected.
        secondResult = await capturedHandler!(FIXTURE_OK);
      }),
    );

    const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });
    expect(result.synthesis).toBe('all clear');
    expect(secondResult.isError).toBe(true);
    expect(secondResult.content[0].text).toMatch(/already been called/);
  });

  it('rejects an entirely-empty submit_findings payload as terminal action', async () => {
    // If perCli/findings/outOfDiff are all empty and synthesis is blank,
    // the agent is signaling "nothing happened" — operationally
    // identical to a failed run. Force OrchestratorIncompleteError
    // downstream rather than letting it look like success.
    let firstResult: any;
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        firstResult = await capturedHandler!({
          schemaVersion: 1,
          findings: [],
          perCli: [],
          synthesis: '',
          outOfDiff: [],
        });
      }),
    );

    await expect(run({ repoPath: '/tmp/repo', oauthToken: 'tok' })).rejects.toThrow(
      OrchestratorIncompleteError,
    );
    expect(firstResult.isError).toBe(true);
    expect(firstResult.content[0].text).toMatch(/entirely empty/);
  });

  it('admits a retry when the first submit_findings throws on schema mismatch', async () => {
    // The defensive Zod re-parse rejects malformed input → captured stays
    // undefined → second call must still be allowed (post-#42 fix).
    let firstError: unknown;
    mockQuery.mockReturnValue(
      makeMessageStream(async () => {
        try {
          await capturedHandler!({ schemaVersion: 2 }); // Invalid: wrong schemaVersion
        } catch (e) {
          firstError = e;
        }
        // Retry with valid payload — should succeed now, not be rejected
        // by the submitCount guard.
        await capturedHandler!(FIXTURE_OK);
      }),
    );

    const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });
    expect(firstError).toBeDefined();
    expect(result.synthesis).toBe('all clear');
  });

  describe('submit_findings clientId clamping (knownClientIds)', () => {
    function findingWith(cli: string, clientId?: string) {
      return {
        cli,
        clientId,
        path: 'src/a.ts',
        side: 'RIGHT' as const,
        severity: 'high' as const,
        category: 'security',
        title: 'T',
        body: 'B',
        verbatimQuote: 'x',
      };
    }

    it('drops a phantom clientId to undefined (unknown id → native)', async () => {
      const fixture = {
        schemaVersion: 1 as const,
        findings: [findingWith('claude', 'phantom')],
        perCli: [{ cli: 'claude' as const, clientId: 'phantom', success: true, executionTimeMs: 100, summary: 's' }],
        synthesis: 'test',
        outOfDiff: [],
      };
      mockQuery.mockReturnValue(makeMessageStream(async () => { await capturedHandler!(fixture); }));
      const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok', knownClientIds: ['glm'] });
      expect(result.findings[0].clientId).toBeUndefined();
      expect(result.perCli[0].clientId).toBeUndefined();
    });

    it('preserves a known provisioned clientId (glm)', async () => {
      const fixture = {
        schemaVersion: 1 as const,
        findings: [findingWith('claude', 'glm')],
        perCli: [{ cli: 'claude' as const, clientId: 'glm', success: true, executionTimeMs: 100, summary: 's' }],
        synthesis: 'test',
        outOfDiff: [],
      };
      mockQuery.mockReturnValue(makeMessageStream(async () => { await capturedHandler!(fixture); }));
      const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok', knownClientIds: ['glm'] });
      expect(result.findings[0].clientId).toBe('glm');
      expect(result.perCli[0].clientId).toBe('glm');
    });

    it('native finding (no clientId) stays undefined and is distinct from glm', async () => {
      const fixture = {
        schemaVersion: 1 as const,
        findings: [findingWith('claude', undefined), findingWith('claude', 'glm')],
        perCli: [],
        synthesis: 'test',
        outOfDiff: [],
      };
      mockQuery.mockReturnValue(makeMessageStream(async () => { await capturedHandler!(fixture); }));
      const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok', knownClientIds: ['glm'] });
      expect(result.findings[0].clientId).toBeUndefined();
      expect(result.findings[1].clientId).toBe('glm');
    });

    it('back-compat: knownClientIds omitted => no change (no normalization counter)', async () => {
      // Without knownClientIds, native ids pass through as-is; non-native still dropped.
      const fixture = {
        schemaVersion: 1 as const,
        findings: [findingWith('claude', undefined)],
        perCli: [],
        synthesis: 'back-compat',
        outOfDiff: [],
      };
      mockQuery.mockReturnValue(makeMessageStream(async () => { await capturedHandler!(fixture); }));
      const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok' });
      expect(result.synthesis).toBe('back-compat');
      expect(result.findings[0].clientId).toBeUndefined();
    });

    it('dedupes perCli after clamping: native + phantom-clamped claude rows collapse to one', async () => {
      // The brain emits a genuine native {cli:'claude'} row AND a hallucinated
      // {cli:'claude', clientId:'phantom'} row. The phantom clamps to
      // clientId:undefined, making it byte-identical to the native row. The
      // single-chunk action path skips chunk-diff.ts's mergePerCli, so without
      // an explicit dedupe here two identical native rows would surface. Keying
      // on (clientId ?? cli) keep-first must collapse them to one — matching
      // mergePerCli so single-chunk and multi-chunk paths agree.
      const fixture = {
        schemaVersion: 1 as const,
        findings: [],
        perCli: [
          { cli: 'claude' as const, success: true, executionTimeMs: 100, summary: 'native' },
          { cli: 'claude' as const, clientId: 'phantom', success: true, executionTimeMs: 200, summary: 'phantom' },
        ],
        synthesis: 'dedupe test',
        outOfDiff: [],
      };
      mockQuery.mockReturnValue(makeMessageStream(async () => { await capturedHandler!(fixture); }));
      const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok', knownClientIds: ['glm'] });
      // Both rows clamp to native claude (clientId undefined) and collapse.
      expect(result.perCli).toHaveLength(1);
      expect(result.perCli[0].cli).toBe('claude');
      expect(result.perCli[0].clientId).toBeUndefined();
      // Keep-first: the genuine native row (summary 'native') survives.
      expect(result.perCli[0].summary).toBe('native');
    });

    it('keeps distinct perCli rows when a known clientId survives clamping', async () => {
      // A native claude row and a glm-attributed row are genuinely distinct
      // (keys 'claude' vs 'glm'); dedupe must NOT collapse them.
      const fixture = {
        schemaVersion: 1 as const,
        findings: [],
        perCli: [
          { cli: 'claude' as const, success: true, executionTimeMs: 100, summary: 'native' },
          { cli: 'claude' as const, clientId: 'glm', success: true, executionTimeMs: 200, summary: 'glm-row' },
        ],
        synthesis: 'distinct test',
        outOfDiff: [],
      };
      mockQuery.mockReturnValue(makeMessageStream(async () => { await capturedHandler!(fixture); }));
      const result = await run({ repoPath: '/tmp/repo', oauthToken: 'tok', knownClientIds: ['glm'] });
      expect(result.perCli).toHaveLength(2);
      expect(result.perCli.map((e) => e.clientId)).toEqual([undefined, 'glm']);
    });

    it('appends normalization count to the success message when phantom ids were dropped', async () => {
      // We verify via the success tool-result text returned by the handler.
      let successText = '';
      mockQuery.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield { type: 'system' as const };
          const fixture = {
            schemaVersion: 1 as const,
            findings: [findingWith('claude', 'phantom')],
            perCli: [],
            synthesis: 'test',
            outOfDiff: [],
          };
          const res = await capturedHandler!(fixture);
          if (!('isError' in res)) {
            successText = res.content[0].text;
          }
          yield { type: 'result' as const };
        },
      });
      await run({ repoPath: '/tmp/repo', oauthToken: 'tok', knownClientIds: ['glm'] });
      expect(successText).toMatch(/unknown clientId/);
    });
  });
});
