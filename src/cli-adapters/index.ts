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
    tempMcpConfigPath?: string;
  }>;

  /**
   * Decode raw CLI output into clean text.
   * Claude decodes stream-json NDJSON, Codex extracts agent_messages,
   * Gemini extracts the response field from JSON.
   *
   * Pattern A: `log` is optional. When provided (passed from the
   * orchestrator via `this.log?.forOperation('<cli>_spawn')`), adapter
   * warnings/errors during decode emit with the scoped logger. When
   * absent, adapters fall back to the root logger so the legacy test
   * proxies (cli-agents.ts decodeClaudeStreamJson / extractCodexAgentMessage
   * / extractGeminiResponse) keep working with no args.
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
