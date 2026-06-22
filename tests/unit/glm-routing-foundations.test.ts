/**
 * Foundational tests for the custom-Claude-routing hardening (CH1–CH10).
 *
 * Covers the env-isolation invariants (A1/A2), routing classification,
 * normalize/resolve, containment denylist (B), schema semantics (C1/C2),
 * and failed-critic attribution (D4). The security-critical claim — a
 * native critic never inherits ambient routing vars, and a routed client
 * never inherits native credentials — is asserted directly against the
 * pure overlay builder.
 */
import { describe, it, expect, afterEach, jest } from '@jest/globals';

jest.mock('../../src/logger.js', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('child_process');
jest.mock('../../src/mcp-registry.js', () => ({
  resolveServers: jest.fn<() => Record<string, any>>().mockReturnValue({ playwright: { command: 'npx', args: ['playwright'] } }),
  listRegisteredServers: jest.fn<() => string[]>().mockReturnValue(['playwright']),
  writeClaudeMcpConfigSecure: jest.fn<() => Promise<string>>().mockResolvedValue('/tmp/mock-secure-mcp.json'),
  cleanupTempConfig: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any),
  ensurePlaywrightBrowsers: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any),
  sanitizeMcpServerNames: jest.fn((names: string[]) => names),
}));

import {
  classifyRouting,
  isRoutedClient,
  normalizeClaudeClient,
  sanitizeClientId,
  parseDefaultClientsFromEnv,
  MAX_CLAUDE_CLIENTS,
  CLIAgentOrchestrator,
  CLIClientSpec,
  CLIAgentOptions,
} from '../../src/cli-agents.js';
import { promises as fs } from 'fs';
import { buildClaudeProviderEnv, classifyClaudeErrorReason } from '../../src/cli-adapters/claude-adapter.js';
import { getProvider } from '../../src/cli-adapters/index.js';
import { BASE_ROAST_SCHEMA } from '../../src/types/tool-config.js';
import type { CLIAgentResponse } from '../../src/types/brutalist.js';

const noopLog: any = { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() };

// ───────────────────────────────────────────────────────────────────────────
// classifyRouting
// ───────────────────────────────────────────────────────────────────────────
describe('classifyRouting', () => {
  it('treats undefined / bare claude client as native', () => {
    expect(classifyRouting(undefined)).toBe('native');
    expect(classifyRouting({ id: 'c', provider: 'claude' })).toBe('native');
    expect(classifyRouting({ id: 'c', provider: 'claude', model: 'opus' })).toBe('native');
  });

  it('marks any routing signal as routed', () => {
    expect(classifyRouting({ id: 'g', provider: 'claude', baseUrl: 'https://g.x' })).toBe('routed');
    expect(classifyRouting({ id: 'g', provider: 'claude', authToken: 't' })).toBe('routed');
    expect(classifyRouting({ id: 'g', provider: 'claude', authTokenEnv: 'T' })).toBe('routed');
    expect(classifyRouting({ id: 'g', provider: 'claude', env: { ANTHROPIC_BASE_URL: 'https://g.x' } })).toBe('routed');
    expect(classifyRouting({ id: 'g', provider: 'claude', includeProcessAuth: false })).toBe('routed');
    expect(isRoutedClient({ id: 'g', provider: 'claude', baseUrl: 'https://g.x' })).toBe(true);
    expect(isRoutedClient({ id: 'c', provider: 'claude' })).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// normalizeClaudeClient
// ───────────────────────────────────────────────────────────────────────────
describe('normalizeClaudeClient', () => {
  it('passes non-claude providers through unchanged (idempotent)', () => {
    const codex: CLIClientSpec = { id: 'cx', provider: 'codex' };
    expect(normalizeClaudeClient(codex, {}, noopLog)).toBe(codex);
  });

  it('stamps native mode + inheritNativeAuth for a bare claude client', () => {
    const out = normalizeClaudeClient({ id: 'c', provider: 'claude' }, {}, noopLog);
    expect(out.routingMode).toBe('native');
    expect(out.inheritNativeAuth).toBe(true);
  });

  it('A3: defaults resolvedSmallFastModel to model when omitted', () => {
    const out = normalizeClaudeClient(
      { id: 'g', provider: 'claude', baseUrl: 'https://g.x', authToken: 't', model: 'glm-5.1' },
      {},
      noopLog,
    );
    expect(out.routingMode).toBe('routed');
    expect(out.resolvedSmallFastModel).toBe('glm-5.1');
  });

  it('A3: explicit smallFastModel wins', () => {
    const out = normalizeClaudeClient(
      { id: 'g', provider: 'claude', baseUrl: 'https://g.x', authToken: 't', model: 'glm-5.1', smallFastModel: 'glm-4.5-air' },
      {},
      noopLog,
    );
    expect(out.resolvedSmallFastModel).toBe('glm-4.5-air');
  });

  it('A4: defaults resolvedConfigDir per-id and keeps distinct ids distinct', () => {
    const a = normalizeClaudeClient({ id: 'glm', provider: 'claude', baseUrl: 'https://g.x', authToken: 't' }, {}, noopLog);
    const b = normalizeClaudeClient({ id: 'glm2', provider: 'claude', baseUrl: 'https://g.x', authToken: 't' }, {}, noopLog);
    expect(a.resolvedConfigDir).toMatch(/\.brutalist[\/\\]claude-clients[\/\\]glm$/);
    expect(b.resolvedConfigDir).not.toBe(a.resolvedConfigDir);
  });

  it('resolves authToken from authTokenEnv against the provided env', () => {
    const out = normalizeClaudeClient(
      { id: 'g', provider: 'claude', baseUrl: 'https://g.x', authTokenEnv: 'GLM_TOK' },
      { GLM_TOK: 'secret' },
      noopLog,
    );
    expect(out.resolvedAuthToken).toBe('secret');
  });

  it('routed opt-in: includeProcessAuth:true sets inheritNativeAuth', () => {
    const out = normalizeClaudeClient(
      { id: 'g', provider: 'claude', baseUrl: 'https://g.x', authToken: 't', includeProcessAuth: true },
      {},
      noopLog,
    );
    expect(out.inheritNativeAuth).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// buildClaudeProviderEnv — the isolation crux
// ───────────────────────────────────────────────────────────────────────────
describe('buildClaudeProviderEnv', () => {
  const ambient = {
    ANTHROPIC_API_KEY: 'native-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'native-oauth',
    ANTHROPIC_AUTH_TOKEN: 'ambient-token',
    ANTHROPIC_BASE_URL: 'https://ambient.proxy',
    ANTHROPIC_MODEL: 'ambient-model',
    ANTHROPIC_SMALL_FAST_MODEL: 'ambient-haiku',
    CLAUDE_CONFIG_DIR: '/ambient/dir',
  } as NodeJS.ProcessEnv;

  it('INV-1: native critic inherits ONLY the auth pair, never ambient routing vars', () => {
    const env = buildClaudeProviderEnv(undefined, ambient);
    expect(env.ANTHROPIC_API_KEY).toBe('native-key');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('native-oauth');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('INV-7: a named NON-routed claude client under ambient base url stays native (no ANTHROPIC_BASE_URL)', () => {
    const env = buildClaudeProviderEnv(
      normalizeClaudeClient({ id: 'plain', provider: 'claude', model: 'opus' }, ambient, noopLog),
      ambient,
    );
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe('native-key');
    expect(env.ANTHROPIC_MODEL).toBe('opus'); // its own pin, not ambient
  });

  it('INV-2: routed client (no includeProcessAuth) inherits NO native creds, isolated endpoint', () => {
    const client = normalizeClaudeClient(
      { id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authTokenEnv: 'GLM_TOK', model: 'glm-5.1' },
      { ...ambient, GLM_TOK: 'glm-token' },
      noopLog,
    );
    const env = buildClaudeProviderEnv(client, { ...ambient, GLM_TOK: 'glm-token' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://glm.x');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-token');
    expect(env.ANTHROPIC_MODEL).toBe('glm-5.1');
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('glm-5.1'); // A3 default
  });

  it('INV-3: routed + includeProcessAuth:true inherits the native auth pair, client token still wins', () => {
    const client = normalizeClaudeClient(
      { id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 'glm-token', includeProcessAuth: true },
      ambient,
      noopLog,
    );
    const env = buildClaudeProviderEnv(client, ambient);
    expect(env.ANTHROPIC_API_KEY).toBe('native-key');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('native-oauth');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-token');
  });

  it('INV-8: explicit client.env wins last over the resolved ANTHROPIC_MODEL', () => {
    const client = normalizeClaudeClient(
      { id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 't', model: 'glm-5.1', env: { ANTHROPIC_MODEL: 'override' } },
      {},
      noopLog,
    );
    const env = buildClaudeProviderEnv(client, {});
    expect(env.ANTHROPIC_MODEL).toBe('override');
  });

  it('INV-10: a RAW routed spec (no routingMode) still isolates via classifyRouting fallback', () => {
    const env = buildClaudeProviderEnv(
      { id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 'glm-token', model: 'glm-5.1' },
      ambient,
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://glm.x');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-token');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Containment denylist (B) via buildCLICommand
// ───────────────────────────────────────────────────────────────────────────
describe('Containment (B) — routed critics deny web egress + MCP', () => {
  function orch(): CLIAgentOrchestrator {
    const o = new CLIAgentOrchestrator();
    (o as any).cliContext = { availableCLIs: ['claude', 'codex'] };
    (o as any).cliContextCached = true;
    return o;
  }
  async function build(opts: CLIAgentOptions) {
    return (orch() as any).buildCLICommand('claude', 'Analyze', 'Be brutal', opts);
  }
  const denylist = (r: any) => r.args[r.args.indexOf('--disallowedTools') + 1] as string;

  it('native critic keeps web tools (denylist exactly Bash,Edit,Write,NotebookEdit)', async () => {
    const r = await build({});
    expect(denylist(r)).toBe('Bash,Edit,Write,NotebookEdit');
  });

  it('routed (hardened-by-default) client denies WebFetch + WebSearch', async () => {
    const r = await build({ activeClient: { id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 't', model: 'glm-5.1' } });
    expect(denylist(r)).toContain('WebFetch');
    expect(denylist(r)).toContain('WebSearch');
    expect(denylist(r)).toContain('Bash');
  });

  it("containment:'standard' on a routed client restores the native denylist", async () => {
    const r = await build({ activeClient: { id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 't', containment: 'standard' } });
    expect(denylist(r)).toBe('Bash,Edit,Write,NotebookEdit');
  });

  it('B3: hardened routed client suppresses MCP even when mcpServers supplied', async () => {
    const r = await build({ activeClient: { id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 't' }, mcpServers: ['playwright'] });
    expect(r.args).not.toContain('--mcp-config');
    expect(r.args).not.toContain('--strict-mcp-config');
  });

  it('native critic with mcpServers still wires MCP', async () => {
    const r = await build({ mcpServers: ['playwright'] });
    expect(r.args).toContain('--mcp-config');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Schema (C1 override hatch, C2 claude-only endpoint fields)
// ───────────────────────────────────────────────────────────────────────────
describe('roast schema (C1/C2)', () => {
  it('C1: clis accepts an explicit empty array (override hatch)', () => {
    expect(BASE_ROAST_SCHEMA.clis.safeParse([]).success).toBe(true);
  });

  it('C2: codex client carrying endpoint fields is rejected', () => {
    const res = BASE_ROAST_SCHEMA.clients.safeParse([{ id: 'x', provider: 'codex', baseUrl: 'https://e.x' }]);
    expect(res.success).toBe(false);
  });

  it('C2: claude client with endpoint fields is accepted; bare codex is accepted', () => {
    expect(BASE_ROAST_SCHEMA.clients.safeParse([{ id: 'g', provider: 'claude', baseUrl: 'https://e.x' }]).success).toBe(true);
    expect(BASE_ROAST_SCHEMA.clients.safeParse([{ id: 'cx', provider: 'codex' }]).success).toBe(true);
  });

  it('accepts the containment enum on a claude client', () => {
    expect(BASE_ROAST_SCHEMA.clients.safeParse([{ id: 'g', provider: 'claude', baseUrl: 'https://e.x', containment: 'standard' }]).success).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// BRUTALIST_CLAUDE_CLIENTS env path — cap + claude-only strip
// ───────────────────────────────────────────────────────────────────────────
describe('parseDefaultClientsFromEnv', () => {
  const orig = process.env.BRUTALIST_CLAUDE_CLIENTS;
  afterEach(() => {
    if (orig === undefined) delete process.env.BRUTALIST_CLAUDE_CLIENTS;
    else process.env.BRUTALIST_CLAUDE_CLIENTS = orig;
  });
  const parse = (v: string) => {
    process.env.BRUTALIST_CLAUDE_CLIENTS = v;
    return parseDefaultClientsFromEnv(noopLog);
  };

  it('empty / invalid JSON / non-array => []', () => {
    delete process.env.BRUTALIST_CLAUDE_CLIENTS;
    expect(parseDefaultClientsFromEnv(noopLog)).toEqual([]);
    expect(parse('[not json')).toEqual([]);
    expect(parse('{"id":"x"}')).toEqual([]);
  });

  it('caps the array at MAX_CLAUDE_CLIENTS (keep-first)', () => {
    const many = Array.from({ length: MAX_CLAUDE_CLIENTS + 5 }, (_, i) => ({ id: `c${i}`, provider: 'claude' }));
    const out = parse(JSON.stringify(many));
    expect(out).toHaveLength(MAX_CLAUDE_CLIENTS);
    expect(out[0].id).toBe('c0');
  });

  it('warn-and-strips a non-claude entry carrying claude-only routing fields', () => {
    const out = parse(JSON.stringify([
      { id: 'cx', provider: 'codex', baseUrl: 'https://e.x' },
      { id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 't' },
    ]));
    expect(out.map((c) => c.id)).toEqual(['glm']);
  });

  it('keeps a bare codex entry and sanitizes ids', () => {
    const out = parse(JSON.stringify([{ id: 'CX/1', provider: 'codex' }]));
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(sanitizeClientId('CX/1'));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D5 — gateway-aware error classifier
// ───────────────────────────────────────────────────────────────────────────
describe('classifyClaudeErrorReason (D5)', () => {
  it('classifies auth failures (401/403/authentication_error/invalid_api_key)', () => {
    expect(classifyClaudeErrorReason('authentication_error: bad token')).toBe('auth');
    expect(classifyClaudeErrorReason('HTTP 401 Unauthorized')).toBe('auth');
    expect(classifyClaudeErrorReason('gateway returned 403')).toBe('auth');
    expect(classifyClaudeErrorReason('{"error":"invalid_api_key"}')).toBe('auth');
  });

  it('classifies unknown/unsupported model errors', () => {
    expect(classifyClaudeErrorReason('model_not_found: glm-9')).toBe('model');
    expect(classifyClaudeErrorReason('unknown model: glm-5.1')).toBe('model');
    expect(classifyClaudeErrorReason('unsupported model requested')).toBe('model');
  });

  it('classifies gateway + Anthropic quota vocab', () => {
    expect(classifyClaudeErrorReason('429 Too Many Requests')).toBe('quota');
    expect(classifyClaudeErrorReason('insufficient_quota')).toBe('quota');
    expect(classifyClaudeErrorReason('usage limit reached')).toBe('quota'); // Anthropic regression
  });

  it('auth takes precedence over quota when both markers are present', () => {
    expect(classifyClaudeErrorReason('401 unauthorized; also rate limit')).toBe('auth');
  });

  it('returns unknown for empty / unmatched envelopes (no loose-substring fabrication)', () => {
    expect(classifyClaudeErrorReason(undefined)).toBe('unknown');
    expect(classifyClaudeErrorReason('something opaque happened')).toBe('unknown');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C1 / C4 / D1 — execution-spec assembly (additive, dedup, pre-flight)
// ───────────────────────────────────────────────────────────────────────────
describe('executeBrutalistAnalysis spec assembly (C1/C4/D1)', () => {
  function orch(): CLIAgentOrchestrator {
    const o = new CLIAgentOrchestrator();
    (o as any).cliContext = { availableCLIs: ['claude', 'codex', 'agy'] };
    (o as any).cliContextCached = true;
    return o;
  }
  function stubExec(o: CLIAgentOrchestrator) {
    return jest.spyOn(o as any, 'executeSingleCLI').mockImplementation(
      async (...a: any[]) => ({ agent: a[0], clientId: a[3]?.activeClient?.id, success: true, output: 'roast', error: undefined, executionTime: 10 }),
    );
  }
  const ranIds = (spy: any) => spy.mock.calls.map((c: any[]) => c[3]?.activeClient?.id).sort();

  it('C1: clients[] is ADDITIVE to the native critic set', async () => {
    const o = orch();
    const spy = stubExec(o);
    await o.executeBrutalistAnalysis('code' as any, 'content', 'spec', undefined, {
      clients: [{ id: 'extra', provider: 'claude' }],
    });
    expect(ranIds(spy)).toEqual(['agy', 'claude', 'codex', 'extra']);
  });

  it('C1: clis:[] is the explicit override hatch — only the named clients run', async () => {
    const o = orch();
    const spy = stubExec(o);
    await o.executeBrutalistAnalysis('code' as any, 'content', 'spec', undefined, {
      clis: [],
      clients: [{ id: 'extra', provider: 'claude' }],
    });
    expect(ranIds(spy)).toEqual(['extra']);
  });

  it('C4: a routed client impersonating a native id is dropped (native wins)', async () => {
    const o = orch();
    const spy = stubExec(o);
    await o.executeBrutalistAnalysis('code' as any, 'content', 'spec', undefined, {
      clients: [{ id: 'claude', provider: 'claude', baseUrl: 'https://evil.x', authToken: 't' }],
    });
    expect(ranIds(spy)).toEqual(['agy', 'claude', 'codex']);
    const claudeCall = spy.mock.calls.find((c: any[]) => c[3]?.activeClient?.id === 'claude') as any[];
    expect(claudeCall[3].activeClient.baseUrl).toBeUndefined(); // the native spec, not the impersonator
  });

  it('D1: a dead routed gateway is pre-flighted out, attributed, and never aborts the panel', async () => {
    const realFetch = (global as any).fetch;
    (global as any).fetch = jest.fn<() => Promise<any>>().mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      const o = orch();
      const spy = stubExec(o);
      const results = await o.executeBrutalistAnalysis('code' as any, 'content', 'spec', undefined, {
        clients: [{ id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 't', configDir: '/tmp/glm-preflight-test' }],
      });
      // glm was pre-flighted out — executeSingleCLI never ran for it.
      expect(ranIds(spy)).toEqual(['agy', 'claude', 'codex']);
      // native critics still ran; glm surfaced as an attributed failure.
      const glm = results.find((r) => r.clientId === 'glm');
      expect(glm).toBeDefined();
      expect(glm!.success).toBe(false);
      expect(glm!.error).toContain('pre-flight');
      expect(results.filter((r) => r.success).length).toBe(3);
    } finally {
      (global as any).fetch = realFetch;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D5 — decode maps gateway errors to the right DecodeResult kind/reason
// ───────────────────────────────────────────────────────────────────────────
describe('claude decode → DecodeResult (D5)', () => {
  const decode = (envelope: string) =>
    getProvider('claude').decode(
      JSON.stringify({ type: 'result', subtype: 'error', error: envelope }),
      '', ['--output-format', 'stream-json'], noopLog,
    ) as any;

  it('auth envelope → refused/auth', () => {
    const r = decode('authentication_error: invalid x-api-key (401)');
    expect(r.kind).toBe('refused');
    expect(r.reason).toBe('auth');
  });

  it('model envelope → error with detail "model" (config defect, not a refusal)', () => {
    const r = decode('model_not_found: glm-9 is not a known model');
    expect(r.kind).toBe('error');
    expect(r.detail).toBe('model');
  });

  it('quota envelope → refused/quota', () => {
    const r = decode('429 Too Many Requests');
    expect(r.kind).toBe('refused');
    expect(r.reason).toBe('quota');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D1 — pre-flight auth gating (#4): only fail on 401 when a token was sent
// ───────────────────────────────────────────────────────────────────────────
describe('pre-flight auth gating (inherit-native vs token)', () => {
  function orch(): CLIAgentOrchestrator {
    const o = new CLIAgentOrchestrator();
    (o as any).cliContext = { availableCLIs: ['claude', 'codex', 'agy'] };
    (o as any).cliContextCached = true;
    return o;
  }
  function stubExec(o: CLIAgentOrchestrator) {
    return jest.spyOn(o as any, 'executeSingleCLI').mockImplementation(
      async (...a: any[]) => ({ agent: a[0], clientId: a[3]?.activeClient?.id, success: true, output: 'roast', error: undefined, executionTime: 10 }),
    );
  }
  const ranIds = (spy: any) => spy.mock.calls.map((c: any[]) => c[3]?.activeClient?.id).sort();

  it('a 401 does NOT kill a client that presented NO token (inherit-native)', async () => {
    const realFetch = (global as any).fetch;
    (global as any).fetch = jest.fn<() => Promise<any>>().mockResolvedValue({ status: 401 });
    try {
      const o = orch();
      const spy = stubExec(o);
      const results = await o.executeBrutalistAnalysis('code' as any, 'x', 'spec', undefined, {
        clients: [{ id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', includeProcessAuth: true, configDir: '/tmp/glm-inherit-test' }],
      });
      expect(ranIds(spy)).toContain('glm'); // stayed live — real spawn supplies inherited auth
      expect(results.find((r) => r.clientId === 'glm')?.success).toBe(true);
    } finally {
      (global as any).fetch = realFetch;
    }
  });

  it('a 401 DOES kill a client that presented a token', async () => {
    const realFetch = (global as any).fetch;
    (global as any).fetch = jest.fn<() => Promise<any>>().mockResolvedValue({ status: 401 });
    try {
      const o = orch();
      const spy = stubExec(o);
      const results = await o.executeBrutalistAnalysis('code' as any, 'x', 'spec', undefined, {
        clients: [{ id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 'bad', configDir: '/tmp/glm-auth-test' }],
      });
      expect(ranIds(spy)).not.toContain('glm'); // pre-flighted out
      const glm = results.find((r) => r.clientId === 'glm');
      expect(glm?.success).toBe(false);
      expect(glm?.error).toContain('auth');
    } finally {
      (global as any).fetch = realFetch;
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D4 — failed-critic attribution in synthesis
// ───────────────────────────────────────────────────────────────────────────
describe('synthesizeBrutalistFeedback failed-critic attribution (D4)', () => {
  const orch = new CLIAgentOrchestrator();
  const failed = (over: Partial<CLIAgentResponse>): CLIAgentResponse => ({
    agent: 'claude', success: false, output: '', error: 'gateway 401', executionTime: 0, ...over,
  } as CLIAgentResponse);

  it('a lone GLM failure (all-failed path) is attributed to glm, not bare CLAUDE', () => {
    const out = orch.synthesizeBrutalistFeedback([failed({ clientId: 'glm', error: 'pre-flight auth: 401' })], 'codebase');
    expect(out).toContain('BRUTALIST_CLI_BEGIN cli="claude"');
    expect(out).toContain('BRUTALIST_CLI_CLIENT id="glm"');
    expect(out).toContain('glm (CLAUDE)');
    expect(out).not.toMatch(/- \*\*CLAUDE\*\*/); // not the bare/redundant form
  });

  it('a native-only failure renders CLAUDE without the redundant "claude (CLAUDE)"', () => {
    const out = orch.synthesizeBrutalistFeedback([failed({})], 'codebase');
    expect(out).toContain('**CLAUDE**');
    expect(out).not.toContain('claude (CLAUDE)');
  });

  it('partial failure: a successful native critic + failed GLM both attributed', () => {
    const ok: CLIAgentResponse = { agent: 'codex', success: true, output: 'roast', error: undefined, executionTime: 100 } as CLIAgentResponse;
    const out = orch.synthesizeBrutalistFeedback([ok, failed({ clientId: 'glm' })], 'codebase');
    expect(out).toContain('## Failed Critics');
    expect(out).toContain('BRUTALIST_CLI_CLIENT id="glm"');
    expect(out).toContain('glm (CLAUDE)');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D-correctness — marker fields can't break out of the BRUTALIST_CLI comment
// ───────────────────────────────────────────────────────────────────────────
describe('synthesizeBrutalistFeedback marker robustness (no comment break-out)', () => {
  const orch = new CLIAgentOrchestrator();

  // The orchestrator brain parses BEGIN ... END HTML-comment markers. A literal
  // `-->` (or newline) in model/error must NOT prematurely close the BEGIN
  // comment, or the marker stream is corrupted.
  it('a failed response with "-->" in model AND error still produces well-formed markers', () => {
    const failed: CLIAgentResponse = {
      agent: 'claude',
      clientId: 'glm',
      success: false,
      output: '',
      error: 'gateway said --> boom\nsecond line',
      model: 'glm-->5.1',
      executionTime: 0,
    } as CLIAgentResponse;

    const out = orch.synthesizeBrutalistFeedback([failed], 'codebase');

    // The ONLY `-->` sequences left are the intentional marker terminators
    // (the success/failed BEGIN comments and the END comment). Neither the
    // injected model nor error may contribute a raw `-->`.
    const begin = '<!-- BRUTALIST_CLI_BEGIN cli="claude"';
    expect(out).toContain(begin);
    // BEGIN comment closes exactly once, with success="false" -->, and the
    // model attribute is neutralized (no raw --> inside it).
    expect(out).toMatch(/BRUTALIST_CLI_BEGIN cli="claude" model="glm--&gt;5\.1" exec_ms="0" success="false" -->/);
    // END marker is present and parseable.
    expect(out).toContain('<!-- BRUTALIST_CLI_END cli="claude" -->');
    // The raw newline in error is collapsed (no CR/LF inside the rendered block body line).
    expect(out).toContain('gateway said --&gt; boom second line');
    // Sanity: every `-->` occurrence is a legitimate marker terminator — the
    // BEGIN comment (ends success="..." ), the CLIENT comment (ends id="..." ),
    // or the END comment (ends cli="..." ) — never an injected break-out.
    const stray = out.split('-->').slice(0, -1).filter((seg) =>
      !/(?:success="(?:true|false)"|BRUTALIST_CLI_CLIENT id="[^"]*"|BRUTALIST_CLI_END cli="[^"]*") $/.test(seg)
    );
    expect(stray).toEqual([]);
  });

  it('a successful response with "-->" in model neutralizes it in the BEGIN comment', () => {
    const ok: CLIAgentResponse = {
      agent: 'codex', success: true, output: 'roast', error: undefined,
      model: 'evil-->model', executionTime: 5,
    } as CLIAgentResponse;
    const out = orch.synthesizeBrutalistFeedback([ok], 'codebase');
    expect(out).toMatch(/BRUTALIST_CLI_BEGIN cli="codex" model="evil--&gt;model" exec_ms="5" success="true" -->/);
    expect(out).toContain('<!-- BRUTALIST_CLI_END cli="codex" -->');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E — sanitizeClientId characterization (SHARED transform contract)
// ───────────────────────────────────────────────────────────────────────────
describe('sanitizeClientId (mcp-server half of the shared attribution contract)', () => {
  // The CORE transform here MUST stay byte-for-byte identical to
  // packages/github-action/src/index.ts's sanitizeClientId. This table is
  // mirrored by a characterization test in the action; drift breaks one of
  // the two. Only the empty-input fallback intentionally differs
  // ('client' here, 'custom-claude' there).
  it.each([
    ['glm', 'glm'],
    ['glm-5.1', 'glm-5.1'],
    ['  spaced id  ', 'spaced-id'],
    ['a@b/c#d', 'a-b-c-d'],
    ['Keep_._:-', 'Keep_._:-'],
    ['résumé', 'r-sum-'],
    ['x'.repeat(100), 'x'.repeat(80)],
    ['///', '---'],
  ])('CORE transform: %p -> %p', (input, expected) => {
    expect(sanitizeClientId(input)).toBe(expected);
  });

  it('empty input falls back to the mcp-server sentinel "client"', () => {
    expect(sanitizeClientId('')).toBe('client');
    expect(sanitizeClientId('   ')).toBe('client');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D-missing — routed config-dir provisioning + 200-OK pre-flight + swallowed mkdir
// ───────────────────────────────────────────────────────────────────────────
describe('routed config-dir provisioning + pre-flight liveness', () => {
  function orch(): CLIAgentOrchestrator {
    const o = new CLIAgentOrchestrator();
    (o as any).cliContext = { availableCLIs: ['claude', 'codex', 'agy'] };
    (o as any).cliContextCached = true;
    return o;
  }
  function stubExec(o: CLIAgentOrchestrator) {
    return jest.spyOn(o as any, 'executeSingleCLI').mockImplementation(
      async (...a: any[]) => ({ agent: a[0], clientId: a[3]?.activeClient?.id, success: true, output: 'roast', error: undefined, executionTime: 10 }),
    );
  }
  const ranIds = (spy: any) => spy.mock.calls.map((c: any[]) => c[3]?.activeClient?.id).sort();

  afterEach(() => { jest.restoreAllMocks(); });

  it('(a) a routed client WITHOUT configDir provisions its default dir at mode 0o700 and still runs', async () => {
    const mkdirSpy = jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    const realFetch = (global as any).fetch;
    (global as any).fetch = jest.fn<() => Promise<any>>().mockResolvedValue({ status: 200 });
    try {
      const o = orch();
      const spy = stubExec(o);
      const results = await o.executeBrutalistAnalysis('code' as any, 'content', 'spec', undefined, {
        clients: [{ id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 't', model: 'glm-5.1' }],
      });
      // Provisioned the per-id isolated dir with 0o700, recursive.
      const call = mkdirSpy.mock.calls.find((c: any[]) =>
        typeof c[0] === 'string' && /[/\\]\.brutalist[/\\]claude-clients[/\\]glm$/.test(c[0] as string)
      );
      expect(call).toBeDefined();
      expect(call![1]).toEqual({ recursive: true, mode: 0o700 });
      // The client still ran (200-OK pre-flight kept it live).
      expect(ranIds(spy)).toContain('glm');
      expect(results.find((r) => r.clientId === 'glm')?.success).toBe(true);
    } finally {
      (global as any).fetch = realFetch;
    }
  });

  it('(b) a 200-OK pre-flight keeps a token-presenting routed client LIVE', async () => {
    jest.spyOn(fs, 'mkdir').mockResolvedValue(undefined as any);
    const realFetch = (global as any).fetch;
    (global as any).fetch = jest.fn<() => Promise<any>>().mockResolvedValue({ status: 200 });
    try {
      const o = orch();
      const spy = stubExec(o);
      const results = await o.executeBrutalistAnalysis('code' as any, 'x', 'spec', undefined, {
        clients: [{ id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 'good', configDir: '/tmp/glm-200-test' }],
      });
      expect(ranIds(spy)).toContain('glm');
      expect(results.find((r) => r.clientId === 'glm')?.success).toBe(true);
    } finally {
      (global as any).fetch = realFetch;
    }
  });

  it('(c) an fs.mkdir REJECTION is swallowed; the panel completes and native critics run', async () => {
    jest.spyOn(fs, 'mkdir').mockRejectedValue(new Error('EACCES: permission denied'));
    const o = orch();
    const spy = stubExec(o);
    // Resolves (does not throw) despite the provisioning failure.
    const results = await o.executeBrutalistAnalysis('code' as any, 'content', 'spec', undefined, {
      clients: [{ id: 'glm', provider: 'claude', baseUrl: 'https://glm.x', authToken: 't' }],
    });
    // Native critics still ran.
    expect(ranIds(spy)).toEqual(expect.arrayContaining(['agy', 'claude', 'codex']));
    expect(results.filter((r) => r.success).length).toBeGreaterThanOrEqual(3);
  });
});
