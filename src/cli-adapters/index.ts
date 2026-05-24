/**
 * CLI Provider Adapter Interface and Registry
 *
 * Defines the CLIProvider contract that all per-provider adapters implement,
 * and provides a factory for resolving providers by name.
 */
import type { CLIAgentOptions } from '../cli-agents.js';
import type { ModelResolver } from '../model-resolver.js';
import type { StructuredLogger } from '../logger.js';

// Re-export shared utilities
export { parseNDJSON } from './shared.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type CLIName = 'claude' | 'codex' | 'gemini';

export interface MCPSupportConfig {
  /** How this CLI receives MCP server configuration */
  configMethod: 'flag-file' | 'config-override' | 'server-whitelist';

  // Claude: --mcp-config <path> --strict-mcp-config
  configFlag?: string;
  strictFlag?: string;

  // Codex: -c 'mcp_servers={...}'
  configOverrideKey?: string;

  // Gemini: --allowed-mcp-server-names <names>
  whitelistFlag?: string;

  /** Hard write-prevention mechanism native to this CLI */
  writeProtection: {
    method: 'disallowed-tools' | 'sandbox' | 'approval-mode';
    flag: string;
    value: string;
  };
}

export interface CLIBuilderConfig {
  command: string;
  defaultArgs: string[];
  modelArgName: string;
  promptWrapper?: (system: string, user: string) => string;
  envExtras?: Record<string, string>;
  jsonFlag?: string;
  streamingArgs?: (options: CLIAgentOptions) => string[];
  mpcEnvCleanup?: string[];
  mcpSupport?: MCPSupportConfig;
}

// ── DecodeResult ───────────────────────────────────────────────────────────

/**
 * Structured outcome of decoding a CLI's raw output.
 *
 * Replaces the previous `decodeOutput(): string` shape, which collapsed
 * three distinct states (success / refusal / error) into one string and
 * forced the orchestrator to re-grep the assistant prose for refusal
 * markers — a brittle layer that produced the 2026-05-21 false-positive
 * class (see Phase 1 fix in cli-agents.ts).
 *
 * Each provider adapter populates this from its own protocol-level
 * signals (Claude: `result.subtype` / `is_error`; Codex: error events;
 * Gemini: anchored stderr markers). The orchestrator never inspects
 * assistant prose to classify refusals.
 */
export type DecodeRefusalReason = 'quota' | 'auth' | 'policy';
export type DecodeErrorReason = 'malformed' | 'empty' | 'unknown';

export type DecodeResult =
  | { kind: 'ok'; text: string }
  | { kind: 'refused'; reason: DecodeRefusalReason; detail?: string }
  | { kind: 'error'; reason: DecodeErrorReason; detail?: string };

// ── CLIProvider Interface ──────────────────────────────────────────────────

export interface CLIProvider {
  readonly name: CLIName;

  /** Return the static configuration for this provider */
  getConfig(): CLIBuilderConfig;

  /**
   * Build CLI command args, environment, and input for this provider.
   * The orchestrator calls this instead of the old buildCLICommand method.
   */
  buildCommand(
    userPrompt: string,
    systemPrompt: string,
    options: CLIAgentOptions,
    modelResolver: ModelResolver,
    secureEnv: Record<string, string>,
  ): Promise<{
    command: string;
    args: string[];
    input: string;
    env: Record<string, string>;
    // Set when the adapter wrote a temp MCP config file (Claude's
    // secure path uses this to keep credentials off argv). Caller
    // (`_executeCLI`) cleans up via `cleanupTempConfig` in its
    // `finally` block. Undefined when MCP is disabled.
    tempMcpConfigPath?: string;
    // Resolved model name. Surfaced for downstream attribution
    // (per-CLI section headers, orchestrator finding extraction).
    // Undefined when the CLI runs against its own configured default
    // (e.g. Codex without BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE).
    model?: string;
  }>;

  /**
   * Decode raw CLI output into a structured outcome (preferred API).
   *
   * Each adapter inspects ITS OWN protocol-level signals to classify the
   * run — refusal markers must come from the CLI's structured error
   * channel (stream-json `result` events for Claude, error items for
   * Codex, anchored stderr envelopes for Gemini) and never from the
   * assistant text the CLI returned.
   *
   * The orchestrator consumes `DecodeResult.kind` directly; no caller
   * grep the prose for "rate limit"-style strings (Phase 1 hot-fix
   * scoped that pattern set to stderr; Phase 2 removes it entirely).
   *
   * stderr is passed in alongside stdout because two of the three CLIs
   * (Codex error envelopes, Gemini quota errors) surface refusal state
   * on stderr, not in the JSON event stream.
   */
  decode(
    stdout: string,
    stderr: string,
    args: string[],
    log?: StructuredLogger
  ): DecodeResult;

  /**
   * Decode raw CLI output into clean text (legacy API).
   *
   * Delegates to `decode()` and returns the assistant text on success,
   * empty string on refusal/error. Retained for the legacy test proxies
   * at `cli-agents.ts:716-728` and any external consumers; new code
   * should call `decode()` and switch on `kind`.
   *
   * Pattern A: `log` is optional. When provided, adapter warnings/errors
   * during decode emit with the scoped logger. When absent, adapters
   * fall back to the root logger.
   */
  decodeOutput(rawOutput: string, args: string[], log?: StructuredLogger): string;
}

// ── Provider Registry ──────────────────────────────────────────────────────

import { ClaudeAdapter } from './claude-adapter.js';
import { CodexAdapter } from './codex-adapter.js';
import { GeminiAdapter } from './gemini-adapter.js';

const providers: Record<CLIName, CLIProvider> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  gemini: new GeminiAdapter(),
};

/**
 * Get a provider adapter by name.
 * Throws if the provider name is not recognized.
 */
export function getProvider(name: CLIName): CLIProvider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown CLI provider: ${name}`);
  }
  return provider;
}

/**
 * Get all registered provider names.
 */
export function getProviderNames(): CLIName[] {
  return Object.keys(providers) as CLIName[];
}
