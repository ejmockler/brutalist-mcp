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
