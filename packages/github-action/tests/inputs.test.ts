/**
 * Unit tests for readInputs() — context-window governing-min logic.
 *
 * @actions/core.getInput reads from INPUT_<NAME> environment variables
 * (upper-cased, hyphens to underscores). We set/unset those vars directly
 * to drive the test without needing a jest.unstable_mockModule pattern.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { readInputs } from '../src/inputs.js';

// Snapshot of env vars set by this suite so we can restore them.
const MANAGED_VARS = [
  'INPUT_ANTHROPIC-OAUTH-TOKEN',
  'INPUT_GITHUB-TOKEN',
  'INPUT_MINIMUM-SEVERITY',
  'INPUT_MAX-DIFF-CHARS',
  'INPUT_MODEL',
  'INPUT_CLAUDE-CRITIC-MODEL',
  'INPUT_CUSTOM-CLAUDE-BASE-URL',
  'INPUT_CUSTOM-CLAUDE-AUTH-TOKEN',
  'INPUT_CUSTOM-CLAUDE-MODEL',
  'INPUT_CUSTOM-CLAUDE-SMALL-FAST-MODEL',
  'INPUT_CUSTOM-CLAUDE-CLIENT-ID',
  'INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW',
  'INPUT_CUSTOM-CLAUDE-CLIENTS',
  'INPUT_CONTEXT-WINDOW-TOKENS',
  'INPUT_CONTEXT-HEADROOM-PCT',
  'INPUT_CHUNK-CONCURRENCY',
  'INPUT_WORKING-DIRECTORY',
  'INPUT_OPENAI-API-KEY',
  'INPUT_CODEX-AUTH',
  'INPUT_AGY-OAUTH-TOKEN',
  'GITHUB_TOKEN',
];

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Save and clear all managed vars.
  for (const k of MANAGED_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  // Set required baseline values.
  process.env['INPUT_ANTHROPIC-OAUTH-TOKEN'] = 'test-token-abcdef';
  process.env['GITHUB_TOKEN'] = 'ghp_test_env';
  process.env['INPUT_MINIMUM-SEVERITY'] = 'low';
  process.env['INPUT_MAX-DIFF-CHARS'] = '2000000';
  process.env['INPUT_MODEL'] = 'claude-opus-4-8';
  process.env['INPUT_CUSTOM-CLAUDE-CLIENT-ID'] = 'custom-claude';
  process.env['INPUT_CONTEXT-WINDOW-TOKENS'] = '200000';
  process.env['INPUT_CONTEXT-HEADROOM-PCT'] = '40';
  process.env['INPUT_CHUNK-CONCURRENCY'] = '2';
  process.env['INPUT_WORKING-DIRECTORY'] = '.';
});

afterEach(() => {
  // Restore all managed vars.
  for (const k of MANAGED_VARS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
  savedEnv = {};
});

describe('contextWindowTokens governing-min logic', () => {
  it('unset custom-claude-context-window => contextWindowTokens === configured (200000)', () => {
    // custom-claude-context-window is not set (delete to be sure).
    delete process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'];
    const inputs = readInputs();
    expect(inputs.contextWindowTokens).toBe(200_000);
    expect(inputs.customClaudeContextWindow).toBeUndefined();
  });

  // Helper: set the custom-claude routing trio so the custom critic activates
  // and its context window is allowed to fold into the governing min.
  function enableCustomClaudeRouting(): void {
    process.env['INPUT_CUSTOM-CLAUDE-BASE-URL'] = 'https://example.test/v1';
    process.env['INPUT_CUSTOM-CLAUDE-AUTH-TOKEN'] = 'sk-custom-abcdef';
    process.env['INPUT_CUSTOM-CLAUDE-MODEL'] = 'glm-5.1';
  }

  it('custom window BELOW configured (routing enabled) => governing is the custom window (min wins)', () => {
    enableCustomClaudeRouting();
    process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'] = '128000';
    const inputs = readInputs();
    expect(inputs.contextWindowTokens).toBe(128_000);
    expect(inputs.customClaudeContextWindow).toBe(128_000);
  });

  it('custom window ABOVE configured (routing enabled) => governing stays configured (min never raises)', () => {
    enableCustomClaudeRouting();
    process.env['INPUT_CONTEXT-WINDOW-TOKENS'] = '100000';
    process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'] = '200000';
    const inputs = readInputs();
    expect(inputs.contextWindowTokens).toBe(100_000);
    expect(inputs.customClaudeContextWindow).toBe(200_000);
  });

  it('custom window set WITHOUT routing => governing stays the configured value (no shrink for a critic that never runs)', () => {
    // No base-url/auth-token/model => the custom critic never activates, so its
    // window must NOT fold into the governing min even though it is smaller.
    process.env['INPUT_CONTEXT-WINDOW-TOKENS'] = '200000';
    process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'] = '128000';
    const inputs = readInputs();
    expect(inputs.contextWindowTokens).toBe(200_000);
    // The parsed value is still surfaced for diagnostics; only the fold is gated.
    expect(inputs.customClaudeContextWindow).toBe(128_000);
  });

  it('custom window set WITH routing => the min applies (governing shrinks)', () => {
    enableCustomClaudeRouting();
    process.env['INPUT_CONTEXT-WINDOW-TOKENS'] = '200000';
    process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'] = '128000';
    const inputs = readInputs();
    expect(inputs.contextWindowTokens).toBe(128_000);
  });

  it('maxChunkChars is derived from the governing contextWindowTokens, not the configured value', () => {
    // With custom=128000 (governing, routing enabled) and headroom=40%:
    //   usable = floor(128000 * 0.60) = 76800 tokens
    //   maxChunkChars = max(1000, 76800 * 3) = 230400
    enableCustomClaudeRouting();
    process.env['INPUT_CONTEXT-WINDOW-TOKENS'] = '200000';
    process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'] = '128000';
    process.env['INPUT_CONTEXT-HEADROOM-PCT'] = '40';
    const inputs = readInputs();
    const expectedChars = Math.max(1000, Math.floor(128_000 * 0.6) * 3);
    expect(inputs.maxChunkChars).toBe(expectedChars);
    // Verify this is less than what 200000 would give.
    expect(inputs.maxChunkChars).toBeLessThan(Math.max(1000, Math.floor(200_000 * 0.6) * 3));
  });

  it('floor enforcement: custom-claude-context-window below 10000 is rejected', () => {
    process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'] = '5000';
    expect(() => readInputs()).toThrow(/custom-claude-context-window/);
  });

  it('floor enforcement: context-window-tokens below 10000 is rejected', () => {
    process.env['INPUT_CONTEXT-WINDOW-TOKENS'] = '5000';
    expect(() => readInputs()).toThrow(/context-window-tokens/);
  });

  it('custom window equal to configured (routing ON) => fold is idempotent', () => {
    // Enable routing so the custom window actually participates in the min;
    // otherwise the fold is gated off and the assertion would pass vacuously.
    enableCustomClaudeRouting();
    process.env['INPUT_CONTEXT-WINDOW-TOKENS'] = '150000';
    process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'] = '150000';
    const inputs = readInputs();
    expect(inputs.contextWindowTokens).toBe(150_000);
  });

  it('customClaudeContextWindow is undefined when input is empty string', () => {
    process.env['INPUT_CUSTOM-CLAUDE-CONTEXT-WINDOW'] = '';
    const inputs = readInputs();
    expect(inputs.customClaudeContextWindow).toBeUndefined();
    expect(inputs.contextWindowTokens).toBe(200_000);
  });
});

describe('custom-claude-clients (multi-client) parse + merge + dedup + cap', () => {
  const setClients = (v: string) => { process.env['INPUT_CUSTOM-CLAUDE-CLIENTS'] = v; };
  const C = (over: Record<string, unknown> = {}) =>
    ({ id: 'glm', baseUrl: 'https://glm.test/v1', authToken: 'sk-a', model: 'glm-5.1', ...over });

  it('unset / empty => customClaudeClients is []', () => {
    expect(readInputs().customClaudeClients).toEqual([]);
    setClients('');
    expect(readInputs().customClaudeClients).toEqual([]);
  });

  it('parses a JSON array, order preserved, tokens carried (redaction depends on this)', () => {
    setClients(JSON.stringify([C({ id: 'glm' }), C({ id: 'kimi', model: 'kimi-k2' })]));
    const cs = readInputs().customClaudeClients;
    expect(cs.map((c) => c.id)).toEqual(['glm', 'kimi']);
    expect(cs[0].authToken).toBe('sk-a');
  });

  it('the singular trio appends ONE more client at the end', () => {
    setClients(JSON.stringify([C({ id: 'glm' })]));
    process.env['INPUT_CUSTOM-CLAUDE-BASE-URL'] = 'https://s.test/v1';
    process.env['INPUT_CUSTOM-CLAUDE-AUTH-TOKEN'] = 'sk-singular';
    process.env['INPUT_CUSTOM-CLAUDE-MODEL'] = 'sng-1';
    process.env['INPUT_CUSTOM-CLAUDE-CLIENT-ID'] = 'singular';
    expect(readInputs().customClaudeClients.map((c) => c.id)).toEqual(['glm', 'singular']);
  });

  it('id collision (plural + singular) keeps the plural entry (keep-first)', () => {
    setClients(JSON.stringify([C({ id: 'dup', authToken: 'sk-plural' })]));
    process.env['INPUT_CUSTOM-CLAUDE-BASE-URL'] = 'https://s.test/v1';
    process.env['INPUT_CUSTOM-CLAUDE-AUTH-TOKEN'] = 'sk-singular';
    process.env['INPUT_CUSTOM-CLAUDE-MODEL'] = 'sng-1';
    process.env['INPUT_CUSTOM-CLAUDE-CLIENT-ID'] = 'dup';
    const cs = readInputs().customClaudeClients;
    expect(cs).toHaveLength(1);
    expect(cs[0].authToken).toBe('sk-plural');
  });

  it('dedup is by SANITIZED id (glm/1 and glm-1 collide)', () => {
    setClients(JSON.stringify([C({ id: 'glm/1', authToken: 'first' }), C({ id: 'glm-1', authToken: 'second' })]));
    const cs = readInputs().customClaudeClients;
    expect(cs).toHaveLength(1);
    expect(cs[0].authToken).toBe('first');
  });

  it('folds EVERY client window into the governing min', () => {
    setClients(JSON.stringify([C({ id: 'a', contextWindow: 180_000 }), C({ id: 'b', model: 'm', contextWindow: 96_000 })]));
    expect(readInputs().contextWindowTokens).toBe(96_000);
  });

  it('invalid JSON throws a clear error', () => {
    setClients('[not json');
    expect(() => readInputs()).toThrow(/custom-claude-clients must be a JSON array/);
  });

  it('non-array JSON throws', () => {
    setClients('{"id":"x"}');
    expect(() => readInputs()).toThrow(/must be a JSON array/);
  });

  it('missing required field throws, naming the entry index + field', () => {
    setClients(JSON.stringify([{ id: 'glm', baseUrl: 'https://x', model: 'm' }]));
    expect(() => readInputs()).toThrow(/custom-claude-clients\[0\] requires a non-empty string "authToken"/);
  });

  it('unknown per-entry field is rejected (no silent drop)', () => {
    setClients(JSON.stringify([C({ apiKey: 'oops' })]));
    expect(() => readInputs()).toThrow(/unknown field "apiKey"/);
  });

  it('bad containment value is rejected', () => {
    setClients(JSON.stringify([C({ containment: 'loose' })]));
    expect(() => readInputs()).toThrow(/containment.*hardened.*standard/);
  });

  it('out-of-range contextWindow is rejected', () => {
    setClients(JSON.stringify([C({ contextWindow: 5000 })]));
    expect(() => readInputs()).toThrow(/contextWindow.*10000.*2000000/);
  });

  it('exceeding the 16-client cap throws', () => {
    setClients(JSON.stringify(Array.from({ length: 17 }, (_, i) => C({ id: `c${i}` }))));
    expect(() => readInputs()).toThrow(/Too many custom Claude clients/);
  });
});
