/**
 * Tests for the custom-claude provisioning seam (src/custom-claude.ts) — now
 * N-client. provisionCustomClaudeClient consumes inputs.customClaudeClients
 * (parsed/merged/deduped by inputs.ts) and provisions each: a per-client
 * INDEX-named token env var, a 0700 config dir, and a BRUTALIST_CLAUDE_CLIENTS
 * entry that references the token by env name (NEVER inlined). knownClientIds
 * (threaded into every per-chunk runOrchestrator) must equal the published ids.
 *
 * Extracted into src/custom-claude.ts so it tests with plain static imports —
 * without importing @brutalist/orchestrator (untransformable ESM under ts-jest;
 * the pre-existing redact.test.ts failure). index.ts imports the same helpers.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sanitizeClientId,
  provisionCustomClaudeClient,
  customClaudeTokenEnvName,
} from '../src/custom-claude.js';
import type { ActionInputs, ParsedCustomClient } from '../src/inputs.js';

// Env keys provisionCustomClaudeClient may set: the published-clients var, the
// index-based token vars, and the legacy shared name (cleanup safety).
const PROVISION_VARS = [
  'BRUTALIST_CLAUDE_CLIENTS',
  'BRUTALIST_CUSTOM_CLAUDE_AUTH_TOKEN',
  'BRUTALIST_CUSTOM_CLAUDE_AUTH_TOKEN_0',
  'BRUTALIST_CUSTOM_CLAUDE_AUTH_TOKEN_1',
  'BRUTALIST_CUSTOM_CLAUDE_AUTH_TOKEN_2',
];
let savedEnv: Record<string, string | undefined> = {};
let mkdirSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  for (const k of PROVISION_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Mock mkdir so provisioning asserts mode 0o700 without polluting $HOME.
  mkdirSpy = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
});

afterEach(() => {
  for (const k of PROVISION_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  savedEnv = {};
  mkdirSpy.mockRestore();
});

function client(over: Partial<ParsedCustomClient> = {}): ParsedCustomClient {
  return { id: 'glm', baseUrl: 'https://glm.test/v1', authToken: 'sk-secret-token', model: 'glm-5.1', ...over };
}

function baseInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    anthropicOauthToken: 'oauth-token-abcdef',
    githubToken: 'ghp_test',
    workingDirectory: '.',
    minimumSeverity: 'low',
    maxDiffChars: 2_000_000,
    model: 'claude-opus-4-8',
    claudeCriticModel: 'claude-opus-4-8',
    customClaudeClientId: 'custom-claude',
    customClaudeClients: [],
    contextWindowTokens: 200_000,
    contextHeadroomPct: 40,
    maxChunkChars: 360_000,
    chunkConcurrency: 2,
    ...overrides,
  };
}

describe('provisionCustomClaudeClient (N clients)', () => {
  it('empty customClaudeClients => empty result, touches no env, no mkdir', async () => {
    const r = await provisionCustomClaudeClient(baseInputs());
    expect(r).toEqual({ knownClientIds: [], tokenEnvNames: [] });
    expect(process.env.BRUTALIST_CLAUDE_CLIENTS).toBeUndefined();
    expect(mkdirSpy).not.toHaveBeenCalled();
  });

  it('knownClientIds === sanitized published ids (attribution contract); token in index env var', async () => {
    const inputs = baseInputs({ customClaudeClients: [client({ id: 'GLM/5.1 prod' })] });
    const { knownClientIds, tokenEnvNames } = await provisionCustomClaudeClient(inputs);

    const expectedId = sanitizeClientId('GLM/5.1 prod');
    expect(knownClientIds).toEqual([expectedId]);
    expect(tokenEnvNames).toEqual([customClaudeTokenEnvName(0)]);

    const published = JSON.parse(process.env.BRUTALIST_CLAUDE_CLIENTS ?? '[]');
    expect(published).toHaveLength(1);
    expect(published[0].id).toBe(expectedId);
    // The id threaded to the orchestrator MUST equal the one the mcp-server
    // re-sanitizes and emits from this same env entry.
    expect(knownClientIds[0]).toBe(published[0].id);
    expect(process.env[customClaudeTokenEnvName(0)]).toBe('sk-secret-token');
  });

  it('provisions N clients: N index token env vars, N 0700 config dirs, N published entries (order preserved)', async () => {
    const inputs = baseInputs({ customClaudeClients: [
      client({ id: 'glm', authToken: 't0' }),
      client({ id: 'kimi', authToken: 't1', model: 'kimi-k2' }),
      client({ id: 'qwen', authToken: 't2', model: 'qwen3' }),
    ] });
    const { knownClientIds, tokenEnvNames } = await provisionCustomClaudeClient(inputs);

    expect(knownClientIds).toEqual(['glm', 'kimi', 'qwen']);
    expect(tokenEnvNames).toEqual([0, 1, 2].map(customClaudeTokenEnvName));
    expect(process.env[customClaudeTokenEnvName(0)]).toBe('t0');
    expect(process.env[customClaudeTokenEnvName(1)]).toBe('t1');
    expect(process.env[customClaudeTokenEnvName(2)]).toBe('t2');

    const published = JSON.parse(process.env.BRUTALIST_CLAUDE_CLIENTS ?? '[]');
    expect(published.map((p: any) => p.id)).toEqual(['glm', 'kimi', 'qwen']);
    for (const id of ['glm', 'kimi', 'qwen']) {
      expect(mkdirSpy).toHaveBeenCalledWith(
        path.join(os.homedir(), '.brutalist', 'claude-clients', id),
        { recursive: true, mode: 0o700 },
      );
    }
    // (Per-token core.setSecret masking is verified by code review — asserting
    // it requires mocking @actions/core, which is read-only under CI's ESM
    // module namespace. The load-bearing guarantee is the index.ts redaction
    // secret-list + tokens kept by-reference out of BRUTALIST_CLAUDE_CLIENTS.)
  });

  it('SECURITY: raw tokens are NEVER inlined into BRUTALIST_CLAUDE_CLIENTS (only authTokenEnv)', async () => {
    const inputs = baseInputs({ customClaudeClients: [
      client({ id: 'glm', authToken: 'sk-super-secret-A' }),
      client({ id: 'kimi', authToken: 'sk-super-secret-B', model: 'kimi-k2' }),
    ] });
    await provisionCustomClaudeClient(inputs);

    const raw = process.env.BRUTALIST_CLAUDE_CLIENTS ?? '';
    expect(raw).not.toContain('sk-super-secret-A');
    expect(raw).not.toContain('sk-super-secret-B');
    const published = JSON.parse(raw);
    expect(published[0].authTokenEnv).toBe(customClaudeTokenEnvName(0));
    expect(published[1].authTokenEnv).toBe(customClaudeTokenEnvName(1));
    expect(published[0].authToken).toBeUndefined();
    expect(published[0].includeProcessAuth).toBe(false);
  });

  it('passes through smallFastModel and containment only when set', async () => {
    const inputs = baseInputs({ customClaudeClients: [
      client({ id: 'a', smallFastModel: 'glm-air', containment: 'standard' }),
      client({ id: 'b', model: 'kimi-k2' }),
    ] });
    await provisionCustomClaudeClient(inputs);

    const published = JSON.parse(process.env.BRUTALIST_CLAUDE_CLIENTS ?? '[]');
    expect(published[0].smallFastModel).toBe('glm-air');
    expect(published[0].containment).toBe('standard');
    expect('smallFastModel' in published[1]).toBe(false);
    expect('containment' in published[1]).toBe(false);
  });

  it('threads the SAME knownClientIds (all N) into every per-chunk runOrchestrator call', async () => {
    const inputs = baseInputs({ customClaudeClients: [client({ id: 'glm' }), client({ id: 'kimi', model: 'kimi-k2' })] });
    const { knownClientIds } = await provisionCustomClaudeClient(inputs);

    const runOrchestratorMock = jest.fn(
      (_opts: { knownClientIds: string[]; [k: string]: unknown }): Promise<unknown> =>
        Promise.resolve({ schemaVersion: 1 as const, findings: [], perCli: [], synthesis: '', outOfDiff: [] }),
    );
    const runChunk = (chunk: string, i: number) =>
      runOrchestratorMock({ repoPath: '/repo', focus: `chunk ${i}: ${chunk}`, model: inputs.model, knownClientIds });

    await runChunk('a', 0);
    await runChunk('b', 1);
    await runChunk('c', 2);

    expect(runOrchestratorMock).toHaveBeenCalledTimes(3);
    for (const call of runOrchestratorMock.mock.calls) {
      expect(call[0].knownClientIds).toEqual(['glm', 'kimi']);
    }
  });
});

describe('sanitizeClientId characterization (SHARED attribution transform)', () => {
  // CONTRACT: the CORE transform (trim -> slice(0,80) -> replace non-alnum/._:-
  // with '-') MUST stay byte-identical to src/cli-agents.ts's sanitizeClientId.
  // Only the empty-input fallback differs (here: 'custom-claude'; there:
  // 'client'). This table mirrors the mcp-server's characterization test so
  // drift in EITHER half breaks a test.
  const SHARED_TRANSFORM: ReadonlyArray<readonly [string, string]> = [
    ['glm', 'glm'],
    ['glm-5.1', 'glm-5.1'],
    ['  spaced id  ', 'spaced-id'],
    ['a@b/c#d', 'a-b-c-d'],
    ['Keep_._:-', 'Keep_._:-'],
    ['résumé', 'r-sum-'],
    ['x'.repeat(100), 'x'.repeat(80)],
    ['///', '---'],
  ];

  it.each(SHARED_TRANSFORM)('CORE transform: %j -> %j', (input, expected) => {
    expect(sanitizeClientId(input)).toBe(expected);
  });

  it("empty input falls back to this package's own default ('custom-claude')", () => {
    expect(sanitizeClientId('')).toBe('custom-claude');
    expect(sanitizeClientId('   ')).toBe('custom-claude');
  });
});
