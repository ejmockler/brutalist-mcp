/**
 * Characterization tests for CLI provider command construction,
 * output decoding, and error handling.
 *
 * These tests capture the ACTUAL current behavior of the three CLI
 * provider paths (Claude, Codex, Gemini) so that module extraction
 * can proceed without regressions.
 *
 * Scope: cli-agents.ts lines 561-612 (command construction),
 *        654-863 (output decoders), 925-1032 (MCP config),
 *        1224-1320 (error detection), 385-403 (timeout escalation).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { CLIAgentOrchestrator, CLIAgentOptions } from '../../src/cli-agents.js';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
jest.mock('child_process');
jest.mock('../../src/logger.js', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock mcp-registry to avoid filesystem side-effects
jest.mock('../../src/mcp-registry.js', () => ({
  resolveServers: jest.fn<() => Record<string, any>>().mockReturnValue({ playwright: { command: 'npx', args: ['playwright'] } }),
  listRegisteredServers: jest.fn<() => string[]>().mockReturnValue(['playwright']),
  buildClaudeMcpConfigJson: jest.fn<() => string>().mockReturnValue('{"mcpServers":{"playwright":{"command":"npx","args":["playwright"]}}}'),
  writeClaudeMcpConfigSecure: jest.fn<() => Promise<string>>().mockResolvedValue('/tmp/mock-secure-mcp.json'),
  cleanupTempConfig: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any),
  buildCodexMCPOverride: jest.fn<() => string>().mockReturnValue('{playwright={command="npx",args=["playwright"]}}'),
  ensureGeminiMCPServers: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any),
  ensurePlaywrightBrowsers: jest.fn<() => Promise<void>>().mockResolvedValue(undefined as any),
}));

// Mock child process for spawn calls
class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: jest.fn(),
    end: jest.fn(),
  };
  pid = 99999;
  kill = jest.fn();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function createOrchestrator(): CLIAgentOrchestrator {
  const orch = new CLIAgentOrchestrator();
  // Pre-set CLI context so it does not try to spawn version checks
  (orch as any).cliContext = { availableCLIs: ['claude', 'codex', 'gemini'] };
  (orch as any).cliContextCached = true;
  return orch;
}

// ---------------------------------------------------------------------------
// 1. Per-Provider Command Construction
// ---------------------------------------------------------------------------
describe('CLI Provider Command Construction', () => {
  let orchestrator: CLIAgentOrchestrator;
  let mockSpawn: jest.MockedFunction<typeof spawn>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
    // Default mock that fails fast (prevents hanging)
    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      setTimeout(() => child.emit('error', new Error('mock')), 1);
      return child as any;
    });
    orchestrator = createOrchestrator();
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  // Expose the private buildCLICommand for direct characterization
  async function buildCommand(
    cli: 'claude' | 'codex' | 'gemini',
    opts: CLIAgentOptions = {}
  ) {
    return (orchestrator as any).buildCLICommand(
      cli,
      'Analyze this code',
      'Be brutal',
      opts
    );
  }

  // ---- Claude ----------------------------------------------------------
  describe('Claude CLI', () => {
    it('should use "claude" command with --input-format stream-json as default args', async () => {
      const result = await buildCommand('claude');
      expect(result.command).toBe('claude');
      expect(result.args).toContain('--input-format');
      // `--input-format` is followed by its value `stream-json`. The two
      // appear as adjacent argv elements after the migration off `-p`/
      // `--print` to the NDJSON stream-json protocol.
      const idx = result.args.indexOf('--input-format');
      expect(result.args[idx + 1]).toBe('stream-json');
      expect(result.args).not.toContain('--print');
    });

    it('should include streaming args (--output-format stream-json --verbose)', async () => {
      const result = await buildCommand('claude');
      expect(result.args).toContain('--output-format');
      expect(result.args).toContain('stream-json');
      expect(result.args).toContain('--verbose');
    });

    it('should include --model when a model is specified', async () => {
      const result = await buildCommand('claude', { models: { claude: 'opus' } });
      expect(result.args).toContain('--model');
      const modelIdx = result.args.indexOf('--model');
      expect(result.args[modelIdx + 1]).toBe('opus');
    });

    it('should deliver prompt via stdin (input field)', async () => {
      const result = await buildCommand('claude');
      expect(typeof result.input).toBe('string');
      expect(result.input.length).toBeGreaterThan(0);
      expect(result.input).toContain('Analyze this code');
    });

    it('should always include --disallowedTools and --permission-mode bypassPermissions (write protection + tool access in --print mode)', async () => {
      const result = await buildCommand('claude');
      expect(result.args).toContain('--disallowedTools');
      expect(result.args).toContain('Bash,Edit,Write,NotebookEdit');
      expect(result.args).toContain('--permission-mode');
      expect(result.args).toContain('bypassPermissions');
    });

    it('should include MCP flags when mcpServers is provided', async () => {
      const result = await buildCommand('claude', { mcpServers: ['playwright'] });
      expect(result.args).toContain('--mcp-config');
      expect(result.args).toContain('--strict-mcp-config');
      expect(result.args).toContain('--disallowedTools');
      expect(result.args).toContain('Bash,Edit,Write,NotebookEdit');
      expect(result.args).toContain('--permission-mode');
      expect(result.args).toContain('bypassPermissions');
    });

    it('should NOT include --mcp-config when mcpServers is NOT provided', async () => {
      const result = await buildCommand('claude');
      expect(result.args).not.toContain('--mcp-config');
      expect(result.args).not.toContain('--strict-mcp-config');
    });

    it('should pass --mcp-config as a temp-file path with tempMcpConfigPath set', async () => {
      const result = await buildCommand('claude', { mcpServers: ['playwright'] });
      const idx = result.args.indexOf('--mcp-config');
      expect(idx).toBeGreaterThanOrEqual(0);
      const value = result.args[idx + 1];
      // All MCP configs route through the secure-file path so that
      // caller-controlled fields (env, args, command) never land on
      // argv where `ps`/`/proc/<pid>/cmdline` would expose them.
      expect(value).toBe(result.tempMcpConfigPath);
      expect(typeof result.tempMcpConfigPath).toBe('string');
    });

    it('should set BRUTALIST_SUBPROCESS=1 in env', async () => {
      const result = await buildCommand('claude');
      expect(result.env.BRUTALIST_SUBPROCESS).toBe('1');
    });

    it('should clean up MPC env vars when MCP is NOT enabled', async () => {
      // Set env vars that should be cleaned
      process.env.CLAUDE_MCP_CONFIG = 'test';
      process.env.MCP_ENABLED = 'true';
      const result = await buildCommand('claude');
      expect(result.env.CLAUDE_MCP_CONFIG).toBeUndefined();
      expect(result.env.MCP_ENABLED).toBeUndefined();
      delete process.env.CLAUDE_MCP_CONFIG;
      delete process.env.MCP_ENABLED;
    });
  });

  // ---- Codex -----------------------------------------------------------
  describe('Codex CLI', () => {
    it('should use "codex" command with exec, sandbox, and skip-git-repo-check', async () => {
      const result = await buildCommand('codex');
      expect(result.command).toBe('codex');
      expect(result.args).toContain('exec');
      expect(result.args).toContain('--sandbox');
      expect(result.args).toContain('read-only');
      expect(result.args).toContain('--skip-git-repo-check');
    });

    it('should include --json flag by default', async () => {
      const result = await buildCommand('codex');
      expect(result.args).toContain('--json');
    });

    it('should skip --json flag when CODEX_USE_JSON=false', async () => {
      const origVal = process.env.CODEX_USE_JSON;
      process.env.CODEX_USE_JSON = 'false';
      const result = await buildCommand('codex');
      expect(result.args).not.toContain('--json');
      if (origVal === undefined) {
        delete process.env.CODEX_USE_JSON;
      } else {
        process.env.CODEX_USE_JSON = origVal;
      }
    });

    it('should ignore codex model override by default and use CLI config/default', async () => {
      const result = await buildCommand('codex', { models: { codex: 'gpt-5.5' } });
      expect(result.args).not.toContain('--model');
    });

    it('should include --model only when BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE=true', async () => {
      const origVal = process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE;
      try {
        process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE = 'true';
        const result = await buildCommand('codex', { models: { codex: 'gpt-5.5' } });
        expect(result.args).toContain('--model');
        const modelIdx = result.args.indexOf('--model');
        expect(result.args[modelIdx + 1]).toBe('gpt-5.5');
      } finally {
        if (origVal === undefined) {
          delete process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE;
        } else {
          process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE = origVal;
        }
      }
    });

    it('should wrap prompt with Codex-specific exploration instructions (non-debate mode)', async () => {
      const result = await buildCommand('codex');
      expect(result.input).toContain('Use your shell tools to read files');
      expect(result.input).toContain('cat, ls, find, grep');
    });

    it('should NOT wrap prompt in debate mode', async () => {
      const result = await buildCommand('codex', { debateMode: true });
      expect(result.input).not.toContain('Use your shell tools to read files');
    });

    it('should include MCP config override when mcpServers is provided', async () => {
      const result = await buildCommand('codex', { mcpServers: ['playwright'] });
      expect(result.args).toContain('-c');
      // Should include the mcp_servers= override
      const cIdx = result.args.indexOf('-c');
      expect(result.args[cIdx + 1]).toContain('mcp_servers=');
    });

    it('should deliver prompt via stdin', async () => {
      const result = await buildCommand('codex');
      expect(typeof result.input).toBe('string');
      expect(result.input.length).toBeGreaterThan(0);
    });
  });

  // ---- Gemini ----------------------------------------------------------
  describe('Gemini CLI', () => {
    it('should use "gemini" command with --output-format json', async () => {
      const result = await buildCommand('gemini');
      expect(result.command).toBe('gemini');
      expect(result.args).toContain('--output-format');
      expect(result.args).toContain('json');
    });

    it('should include --model when a model is specified', async () => {
      const result = await buildCommand('gemini', { models: { gemini: 'gemini-2.5-pro' } });
      expect(result.args).toContain('--model');
      const modelIdx = result.args.indexOf('--model');
      expect(result.args[modelIdx + 1]).toBe('gemini-2.5-pro');
    });

    it('should pin frontier model (gemini-3.1-pro-preview) when no model is specified', async () => {
      // Default prevents Gemini CLI's Auto router from downselecting to
      // flash-lite under verification-heavy prompts. Overridable via
      // BRUTALIST_GEMINI_MODEL env var (tested separately in integration).
      const result = await buildCommand('gemini');
      expect(result.args).toContain('--model');
      const modelIdx = result.args.indexOf('--model');
      expect(result.args[modelIdx + 1]).toBe('gemini-3.1-pro-preview');
    });

    it('should set TERM=dumb, NO_COLOR=1, CI=true in env', async () => {
      const result = await buildCommand('gemini');
      expect(result.env.TERM).toBe('dumb');
      expect(result.env.NO_COLOR).toBe('1');
      expect(result.env.CI).toBe('true');
    });

    it('should include MCP whitelist flags when mcpServers is provided', async () => {
      const result = await buildCommand('gemini', { mcpServers: ['playwright'] });
      expect(result.args).toContain('--allowed-mcp-server-names');
      expect(result.args).toContain('--approval-mode');
      expect(result.args).toContain('plan');
    });

    it('should deliver prompt via stdin', async () => {
      const result = await buildCommand('gemini');
      expect(typeof result.input).toBe('string');
      expect(result.input.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Output Decoders
// ---------------------------------------------------------------------------
describe('CLI Provider Output Decoders', () => {
  let orchestrator: CLIAgentOrchestrator;

  beforeEach(async () => {
    jest.clearAllMocks();
    const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      setTimeout(() => child.emit('error', new Error('mock')), 1);
      return child as any;
    });
    orchestrator = createOrchestrator();
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  // ---- parseNDJSON -----------------------------------------------------
  describe('parseNDJSON', () => {
    function parseNDJSON(input: string): object[] {
      return (orchestrator as any).parseNDJSON(input);
    }

    it('should return empty array for empty input', () => {
      expect(parseNDJSON('')).toEqual([]);
      expect(parseNDJSON('   ')).toEqual([]);
    });

    it('should parse a single JSON object', () => {
      const result = parseNDJSON('{"type":"assistant","message":"hello"}');
      expect(result).toHaveLength(1);
      expect((result[0] as any).type).toBe('assistant');
    });

    it('should parse multiple newline-delimited JSON objects', () => {
      const input = '{"a":1}\n{"b":2}\n{"c":3}';
      const result = parseNDJSON(input);
      expect(result).toHaveLength(3);
      expect((result[0] as any).a).toBe(1);
      expect((result[1] as any).b).toBe(2);
      expect((result[2] as any).c).toBe(3);
    });

    it('should handle JSON objects with embedded newlines in strings', () => {
      const input = '{"text":"line1\\nline2"}';
      const result = parseNDJSON(input);
      expect(result).toHaveLength(1);
      expect((result[0] as any).text).toBe('line1\nline2');
    });

    it('should handle nested objects with proper brace tracking', () => {
      const input = '{"outer":{"inner":{"deep":true}}}';
      const result = parseNDJSON(input);
      expect(result).toHaveLength(1);
      expect((result[0] as any).outer.inner.deep).toBe(true);
    });

    it('should handle escaped quotes inside strings', () => {
      const input = '{"key":"value with \\"quotes\\""}';
      const result = parseNDJSON(input);
      expect(result).toHaveLength(1);
      expect((result[0] as any).key).toBe('value with "quotes"');
    });

    it('should handle arrays as top-level JSON', () => {
      const input = '[1,2,3]';
      const result = parseNDJSON(input);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual([1, 2, 3]);
    });

    it('should parse first valid object but lose second when separated by non-JSON text', () => {
      // Characterization: the parser tracks brace depth character by character.
      // "NOT_JSON" has no braces so `start` stays after the first object. When
      // the second object's closing brace brings depth back to 0, the slice
      // from start includes the garbage prefix, causing JSON.parse to fail.
      // This is the actual current behavior.
      const input = '{"valid":true}\nNOT_JSON\n{"also_valid":true}';
      const result = parseNDJSON(input);
      expect(result).toHaveLength(1);
      expect((result[0] as any).valid).toBe(true);
    });

    it('should parse consecutive valid JSON objects without separators', () => {
      const input = '{"a":1}{"b":2}';
      const result = parseNDJSON(input);
      expect(result).toHaveLength(2);
      expect((result[0] as any).a).toBe(1);
      expect((result[1] as any).b).toBe(2);
    });
  });

  // ---- decodeClaudeStreamJson ------------------------------------------
  describe('decodeClaudeStreamJson', () => {
    function decode(input: string): string {
      return (orchestrator as any).decodeClaudeStreamJson(input);
    }

    it('should return empty string for empty input', () => {
      expect(decode('')).toBe('');
      expect(decode('  ')).toBe('');
    });

    it('should extract text from assistant events', () => {
      const input = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'This code has critical issues.' }
          ]
        }
      });
      expect(decode(input)).toBe('This code has critical issues.');
    });

    it('should concatenate text from multiple assistant events with double newline', () => {
      const event1 = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'First point.' }]
        }
      });
      const event2 = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Second point.' }]
        }
      });
      const result = decode(`${event1}\n${event2}`);
      expect(result).toBe('First point.\n\nSecond point.');
    });

    it('should skip tool_use content blocks within assistant events', () => {
      const input = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} },
            { type: 'text', text: 'The analysis shows problems.' }
          ]
        }
      });
      const result = decode(input);
      expect(result).toBe('The analysis shows problems.');
      expect(result).not.toContain('read_file');
    });

    it('should fall back to result event if no assistant text found', () => {
      const input = JSON.stringify({
        type: 'result',
        result: 'Fallback result text here.'
      });
      expect(decode(input)).toBe('Fallback result text here.');
    });

    it('should prefer assistant text over result event', () => {
      const event1 = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Primary text.' }] }
      });
      const event2 = JSON.stringify({
        type: 'result',
        result: 'Fallback text.'
      });
      const result = decode(`${event1}\n${event2}`);
      expect(result).toBe('Primary text.');
    });

    it('should handle error result events', () => {
      const input = JSON.stringify({
        type: 'result',
        subtype: 'error',
        error: 'Something went wrong.'
      });
      const result = decode(input);
      expect(result).toContain('[Claude Error]');
      // Cycle 4 T17 (F8 — security): the raw `error` field from the
      // Claude result-error event is no longer embedded in the
      // decoded output. The decoder returns a content-free
      // "[Claude Error] <redacted>" marker so that provider-side
      // stdout/stderr fragments, prompt echoes, or MCP override
      // content cannot leak through CLIAgentResponse.output.
      expect(result).toContain('<redacted>');
      expect(result).not.toContain('Something went wrong.');
    });

    it('should handle is_error flag in result events', () => {
      const input = JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Error via is_error flag.'
      });
      const result = decode(input);
      expect(result).toContain('[Claude Error]');
      // Cycle 4 T17 (F8 — security): same redaction as above — the
      // raw `result` field on an is_error event no longer appears
      // in the decoded output.
      expect(result).toContain('<redacted>');
      expect(result).not.toContain('Error via is_error flag.');
    });

    it('should skip system and user events', () => {
      const events = [
        JSON.stringify({ type: 'system', message: 'System init' }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Actual response.' }] }
        })
      ];
      const result = decode(events.join('\n'));
      expect(result).toBe('Actual response.');
    });

    it('should return empty string when no text content found in valid events', () => {
      const input = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'x', name: 'fn', input: {} }] }
      });
      expect(decode(input)).toBe('');
    });
  });

  // ---- extractCodexAgentMessage ----------------------------------------
  describe('extractCodexAgentMessage', () => {
    function extract(input: string): string {
      return (orchestrator as any).extractCodexAgentMessage(input);
    }

    it('should return empty string for empty input', () => {
      expect(extract('')).toBe('');
      expect(extract('  ')).toBe('');
    });

    it('should extract agent_message from item.completed events', () => {
      const input = JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'The code has vulnerabilities in the auth module.'
        }
      });
      expect(extract(input)).toBe('The code has vulnerabilities in the auth module.');
    });

    it('should concatenate multiple agent_messages with double newline', () => {
      const event1 = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'First message.' }
      });
      const event2 = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Second message.' }
      });
      const result = extract(`${event1}\n${event2}`);
      expect(result).toBe('First message.\n\nSecond message.');
    });

    it('should skip reasoning events', () => {
      const events = [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'reasoning', text: 'Thinking about the problem...' }
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Final answer.' }
        })
      ];
      const result = extract(events.join('\n'));
      expect(result).toBe('Final answer.');
      expect(result).not.toContain('Thinking');
    });

    it('should skip command_execution events', () => {
      const events = [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'cat src/index.ts', output: 'file contents' }
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Here is my analysis.' }
        })
      ];
      const result = extract(events.join('\n'));
      expect(result).toBe('Here is my analysis.');
    });

    it('should handle events that are not item.completed', () => {
      const input = JSON.stringify({
        type: 'item.started',
        item: { type: 'agent_message', text: 'This should be ignored.' }
      });
      expect(extract(input)).toBe('');
    });

    it('should return empty for item.completed without text field', () => {
      const input = JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message' }
      });
      expect(extract(input)).toBe('');
    });
  });

  // ---- extractGeminiResponse -------------------------------------------
  describe('extractGeminiResponse', () => {
    function extract(input: string): string {
      return (orchestrator as any).extractGeminiResponse(input);
    }

    it('should return empty string for empty input', () => {
      expect(extract('')).toBe('');
      expect(extract('  ')).toBe('');
    });

    it('should extract the response field from JSON', () => {
      const input = JSON.stringify({
        response: 'The architecture has fundamental scaling issues.'
      });
      expect(extract(input)).toBe('The architecture has fundamental scaling issues.');
    });

    it('should return empty string when response field is missing', () => {
      const input = JSON.stringify({ data: 'something', status: 'ok' });
      expect(extract(input)).toBe('');
    });

    it('should return empty string for non-string response field', () => {
      const input = JSON.stringify({ response: 42 });
      expect(extract(input)).toBe('');
    });

    it('should return empty string for invalid JSON', () => {
      expect(extract('not valid json at all')).toBe('');
    });

    it('should handle response with special characters', () => {
      const input = JSON.stringify({
        response: 'Issues:\n1. SQL injection in `query()`\n2. XSS in <input>'
      });
      const result = extract(input);
      expect(result).toContain('SQL injection');
      expect(result).toContain('XSS');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Rate Limit / Quota Error Detection
// ---------------------------------------------------------------------------
describe('CLI Provider Error Detection', () => {
  let orchestrator: CLIAgentOrchestrator;
  let mockSpawn: jest.MockedFunction<typeof spawn>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      setTimeout(() => child.emit('error', new Error('mock')), 1);
      return child as any;
    });
    orchestrator = createOrchestrator();
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  // Phase 2 quota detection: each adapter classifies refusal from its
  // own protocol-level signal — Claude via stream-json `result.subtype`
  // / `is_error`, Codex via anchored stderr markers, Gemini likewise.
  // The orchestrator never inspects assistant prose; loose substring
  // patterns are gone. Tests assert per-adapter behavior against the
  // real signal channel.
  describe('Quota / rate-limit detection on exit code 0', () => {
    function simulate(
      cli: 'claude' | 'codex' | 'gemini',
      stdout: string,
      stderr: string = ''
    ): Promise<any> {
      mockSpawn.mockImplementation(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          if (stdout) child.stdout.emit('data', stdout);
          if (stderr) child.stderr.emit('data', stderr);
          child.emit('close', 0);
        }, 5);
        return child as any;
      });

      return orchestrator.executeSingleCLI(
        cli,
        'Analyze this',
        'System prompt',
        { workingDirectory: process.cwd() }
      );
    }

    // Claude: refusal signal is the NDJSON `result` event with
    // `subtype: 'error_*'` or `is_error: true` — never stderr text.
    it('claude: detects structured refusal via result.subtype with anchored quota envelope', async () => {
      const ndjson = JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'Claude AI usage limit reached. 5-hour limit resets at 14:00 UTC.',
      });
      const result = await simulate('claude', ndjson);
      expect(result.success).toBe(false);
      expect(result.error).toContain('quota refused');
      expect(result.exitCode).toBe(0);
    });

    it('claude: structured error without quota markers surfaces as error, not refusal', async () => {
      // is_error true but the envelope doesn't match any anchored quota
      // marker — should NOT be classified as quota refusal. Falls
      // through to the legacy raw-stdout pass-through path.
      const ndjson = JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Some internal binary failure unrelated to quota.',
      });
      const result = await simulate('claude', ndjson);
      // Not a refusal — error envelope does not match quota markers
      expect(result.error ?? '').not.toContain('quota refused');
    });

    // Codex: stderr is the only refusal channel. Anchored markers only —
    // no loose patterns like "rate limit", "usage limit", "billing".
    it('codex: detects anchored quota marker in stderr (rate_limit_exceeded)', async () => {
      const result = await simulate('codex', '', 'Error: rate_limit_exceeded — try again later');
      expect(result.success).toBe(false);
      expect(result.error).toContain('quota refused');
    });

    it('codex: detects HTTP 429 in stderr', async () => {
      const result = await simulate('codex', '', 'HTTP 429 Too Many Requests');
      expect(result.success).toBe(false);
      expect(result.error).toContain('quota refused');
    });

    it('codex: ChatGPT plan-cap pair (Plus + limit) in stderr triggers refusal', async () => {
      const result = await simulate('codex', '', 'Your ChatGPT Plus plan has hit its weekly limit.');
      expect(result.success).toBe(false);
      expect(result.error).toContain('quota refused');
    });

    it('codex: unanchored "rate limit" prose alone in stderr does NOT trigger refusal', async () => {
      // Per Phase 2 stance: anchored markers only. The word "rate limit"
      // on its own (not the API error code `rate_limit_exceeded`) is
      // not a vendor signal — could be operator-injected text.
      const result = await simulate('codex', '', 'note: app has a rate limit configured');
      expect(result.error ?? '').not.toContain('quota refused');
    });

    // Gemini: stderr-only, anchored to Google API canonical strings.
    it('gemini: detects RESOURCE_EXHAUSTED in stderr', async () => {
      const result = await simulate('gemini', '', 'Error: 8 RESOURCE_EXHAUSTED: Quota exceeded for quota metric.');
      expect(result.success).toBe(false);
      expect(result.error).toContain('quota refused');
    });

    it('gemini: detects userRateLimitExceeded in stderr', async () => {
      const result = await simulate('gemini', '', '{"error": {"reason": "userRateLimitExceeded"}}');
      expect(result.success).toBe(false);
      expect(result.error).toContain('quota refused');
    });

    it('gemini: response field is returned even if it contains quota words', async () => {
      // Documented Phase 2 residual — gemini bakes refusals into the
      // response field with no envelope-level signal, so we surface
      // whatever it returns. We refuse to grep prose to second-guess.
      const json = JSON.stringify({ response: 'I cannot help; your usage limit has been reached.' });
      const result = await simulate('gemini', json);
      expect(result.success).toBe(true);
      expect(result.output).toContain('usage limit');
    });

    // Regression — the 2026-05-21 19:22 false-positive class. Assistant
    // prose containing quota-adjacent words must NOT be reclassified
    // as refusal. This is the bug that triggered the Phase 1/2 work.
    it('claude: assistant prose mentioning rate limit / usage limit / 429 does NOT refuse', async () => {
      const ndjson = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'text',
            text:
              'The codebase has a rate limit at src/lib/rate-limiter.ts. ' +
              'Their usage limit logic also has a token limit exceeded check. ' +
              'The billing plan limit is enforced server-side. HTTP 429 handling is fine.',
          }],
        },
      });
      const result = await simulate('claude', ndjson);
      expect(result.success).toBe(true);
      expect(result.output).toContain('rate limit');
      expect(result.error ?? '').not.toContain('quota refused');
    });

    it('claude: clean assistant text returns as success', async () => {
      const ndjson = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'This code has critical security vulnerabilities.' }],
        },
      });
      const result = await simulate('claude', ndjson);
      expect(result.success).toBe(true);
      expect(result.output).toContain('critical security vulnerabilities');
    });
  });

  // Test rate-limit detection in the catch path (non-zero exit code)
  describe('Rate-limit detection on non-zero exit code', () => {
    function simulateFailedExecution(errorMessage: string): Promise<any> {
      mockSpawn.mockImplementation(() => {
        const child = new MockChildProcess();
        setTimeout(() => {
          const err = new Error(errorMessage) as any;
          err.code = 1;
          err.stderr = errorMessage;
          child.emit('error', err);
        }, 5);
        return child as any;
      });

      return orchestrator.executeSingleCLI(
        'codex',
        'Analyze this',
        'System prompt',
        { workingDirectory: process.cwd() }
      );
    }

    it('should detect rate limit errors in error output', async () => {
      const result = await simulateFailedExecution(
        'Error: 429 Too Many Requests - rate_limit exceeded'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('rate/usage limit');
    });

    it('should detect quota exhaustion in error output', async () => {
      const result = await simulateFailedExecution(
        'Error: quota exhausted, billing limit reached'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('rate/usage limit');
    });

    it('should report generic error for non-rate-limit failures', async () => {
      const result = await simulateFailedExecution(
        'Error: ENOENT command not found'
      );
      expect(result.success).toBe(false);
      expect(result.error).not.toContain('rate/usage limit');
    });

    it('should retry Codex with the CLI default when the requested model is unsupported for ChatGPT accounts', async () => {
      const origVal = process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE;
      process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE = 'true';
      const spawnArgs: string[][] = [];
      let callIndex = 0;

      mockSpawn.mockImplementation((_command, args) => {
        spawnArgs.push(Array.isArray(args) ? [...args] : []);
        const child = new MockChildProcess();
        const currentCall = callIndex++;

        setTimeout(() => {
          if (currentCall === 0) {
            child.stdout.emit('data', JSON.stringify({
              type: 'error',
              message: JSON.stringify({
                type: 'error',
                status: 400,
                error: {
                  type: 'invalid_request_error',
                  message: "The 'gpt-5' model is not supported when using Codex with a ChatGPT account."
                }
              })
            }));
            child.emit('close', 1);
            return;
          }

          child.stdout.emit('data', JSON.stringify({
            type: 'item.completed',
            item: {
              type: 'agent_message',
              text: 'Fallback worked.'
            }
          }));
          child.emit('close', 0);
        }, 5);

        return child as any;
      });

      try {
        const result = await orchestrator.executeSingleCLI(
          'codex',
          'Analyze this',
          'System prompt',
          {
            workingDirectory: process.cwd(),
            models: { codex: 'gpt-5' }
          }
        );

        expect(result.success).toBe(true);
        expect(result.output).toContain('retried with the Codex CLI default');
        expect(result.output).toContain('Fallback worked.');
        expect(spawnArgs).toHaveLength(2);
        expect(spawnArgs[0]).toContain('--model');
        expect(spawnArgs[0][spawnArgs[0].indexOf('--model') + 1]).toBe('gpt-5');
        expect(spawnArgs[1]).not.toContain('--model');
      } finally {
        if (origVal === undefined) {
          delete process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE;
        } else {
          process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE = origVal;
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Timeout Handling (SIGTERM + SIGKILL escalation)
// ---------------------------------------------------------------------------
describe('CLI Provider Timeout Handling', () => {
  let orchestrator: CLIAgentOrchestrator;
  let mockSpawn: jest.MockedFunction<typeof spawn>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
    // Default mock so constructor detection doesn't hang
    mockSpawn.mockImplementation(() => {
      const child = new MockChildProcess();
      setTimeout(() => child.emit('error', new Error('mock')), 1);
      return child as any;
    });
    orchestrator = createOrchestrator();
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('should send SIGTERM when timeout expires and report timeout error', async () => {
    // Use a very short timeout (100ms) to test real timeout behavior.
    // The spawned mock process never closes, triggering the timeout.
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const result = await orchestrator.executeSingleCLI(
      'gemini',
      'Analyze this',
      'System prompt',
      { timeout: 100, workingDirectory: process.cwd() }
    );

    // The timeout fires, sending SIGTERM, then rejecting the promise.
    // _executeCLI catches the rejection and returns a failure response.
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  }, 15000);

  it('should escalate to SIGKILL after 5 seconds if process ignores SIGTERM', async () => {
    // Use a short timeout and wait long enough for SIGKILL escalation.
    const child = new MockChildProcess();
    // Override kill to track calls but NOT actually terminate
    const killCalls: string[] = [];
    (child as any).kill = jest.fn().mockImplementation((...args: any[]) => {
      killCalls.push(args[0] || 'SIGTERM');
      return true;
    });
    mockSpawn.mockReturnValue(child as any);

    const result = await orchestrator.executeSingleCLI(
      'claude',
      'Analyze this',
      'System prompt',
      { timeout: 100, workingDirectory: process.cwd() }
    );

    // Wait for the 5-second SIGKILL escalation timer
    await new Promise(resolve => setTimeout(resolve, 5500));

    expect(killCalls).toContain('SIGTERM');
    expect(killCalls).toContain('SIGKILL');
    expect(result.success).toBe(false);
  }, 15000);

  it('should include timeout duration in error message', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as any);

    const result = await orchestrator.executeSingleCLI(
      'codex',
      'Analyze this',
      'System prompt',
      { timeout: 200, workingDirectory: process.cwd() }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    // The error message should include the timeout value
    expect(result.error).toContain('200ms');
  }, 15000);
});
