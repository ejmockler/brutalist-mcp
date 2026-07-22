import { jest, describe, it, expect, beforeEach } from '@jest/globals';

let capturedHandler:
  | ((args: unknown) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>)
  | undefined;
let capturedQueryParams: any;

const mockQuery = jest.fn() as any;

jest.unstable_mockModule('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: any) => {
    capturedQueryParams = params;
    return mockQuery(params);
  },
  tool: (_name: string, _description: string, _shape: unknown, handler: any) => {
    capturedHandler = handler;
    return { name: _name };
  },
  createSdkMcpServer: (config: any) => ({ type: 'sdk' as const, ...config }),
}));

const { run } = await import('../src/orchestrator.js');

const FIXTURE_OK = {
  schemaVersion: 1 as const,
  findings: [],
  perCli: [
    { cli: 'codex' as const, success: true, executionTimeMs: 123, summary: 'codex only' },
  ],
  synthesis: 'codex only',
  outOfDiff: [],
};

beforeEach(() => {
  capturedHandler = undefined;
  capturedQueryParams = undefined;
  mockQuery.mockReset();
});

describe('single native critic selection', () => {
  it('instructs and mechanically forces the one requested native critic', async () => {
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system' as const };
        await capturedHandler!(FIXTURE_OK);
        yield { type: 'result' as const };
      },
    });

    await run({ repoPath: '/tmp/repo', oauthToken: 'tok', clis: ['codex'] });

    expect(capturedQueryParams.options.systemPrompt).toContain(
      'This review pass is pinned to the `codex` native critic',
    );
    expect(capturedQueryParams.options.systemPrompt).toContain('`clis: ["codex"]`');
    expect(capturedQueryParams.options.systemPrompt).toContain('Do not include `claude` or `agy`');
    expect(capturedQueryParams.prompt).toContain('run ONLY `codex`');
    expect(capturedQueryParams.prompt).toContain('`clis: ["codex"]`');
    expect(
      capturedQueryParams.options.mcpServers.brutalist.env.BRUTALIST_FORCE_CLIS,
    ).toBe('codex');
  });

  it('rejects multi-critic selections at the orchestrator boundary', async () => {
    await expect(
      run({ repoPath: '/tmp/repo', oauthToken: 'tok', clis: ['codex', 'claude'] as any }),
    ).rejects.toThrow(/exactly one native critic/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('per-participant isolation (isolateParticipant)', () => {
  const drive = () =>
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system' as const };
        await capturedHandler!(FIXTURE_OK);
        yield { type: 'result' as const };
      },
    });

  it('a native isolateParticipant sets BRUTALIST_FORCE_CLIS and pins the prompt to that native', async () => {
    drive();
    await run({ repoPath: '/tmp/repo', oauthToken: 'tok', isolateParticipant: 'codex' } as any);
    expect(capturedQueryParams.options.mcpServers.brutalist.env.BRUTALIST_FORCE_CLIS).toBe('codex');
    expect(capturedQueryParams.options.systemPrompt).toContain(
      'This review pass is pinned to the `codex` native critic',
    );
  });

  it("isolateParticipant:'custom' sets BRUTALIST_FORCE_CLIS=custom and instructs custom-only (clis: [])", async () => {
    drive();
    await run({ repoPath: '/tmp/repo', oauthToken: 'tok', isolateParticipant: 'custom' } as any);
    expect(capturedQueryParams.options.mcpServers.brutalist.env.BRUTALIST_FORCE_CLIS).toBe('custom');
    expect(capturedQueryParams.options.systemPrompt).toContain('Custom-Client-Only Mode');
    expect(capturedQueryParams.prompt).toContain('run ONLY the custom Claude-routed client(s)');
  });

  it('isolateParticipant takes precedence over clis[] — no multi-clis throw, and enforcement+prompt both use the isolate', async () => {
    drive();
    // A conflicting, multi-entry clis[] would throw via getSingleNativeCritic if
    // it were still evaluated; the isolate must win and suppress that path.
    await run({
      repoPath: '/tmp/repo',
      oauthToken: 'tok',
      isolateParticipant: 'codex',
      clis: ['claude', 'agy'],
    } as any);
    expect(capturedQueryParams.options.mcpServers.brutalist.env.BRUTALIST_FORCE_CLIS).toBe('codex');
    // The prompt is pinned to codex too (not claude/agy from clis[]).
    expect(capturedQueryParams.options.systemPrompt).toContain(
      'This review pass is pinned to the `codex` native critic',
    );
    expect(capturedQueryParams.options.systemPrompt).not.toContain('pinned to the `claude`');
  });
});
