/**
 * Codex CLI Adapter
 *
 * Encapsulates Codex-specific CLI configuration, command construction,
 * and output decoding (agent_message extraction from NDJSON).
 *
 * Pattern A (integrate-observability): logger is threaded via
 * CLIAgentOptions.log (buildCommand) and the optional `log` parameter on
 * decodeOutput. Falls back to the root logger singleton when absent so
 * legacy test proxies keep working.
 */
import { logger as rootLogger } from '../logger.js';
import type { StructuredLogger } from '../logger.js';
import type { CLIAgentOptions } from '../cli-agents.js';
import type { ModelResolver } from '../model-resolver.js';
import type { CLIProvider, CLIBuilderConfig, CLIName } from './index.js';
import { parseNDJSON } from './shared.js';
import {
  resolveServers,
  listRegisteredServers,
  buildCodexMCPOverride,
} from '../mcp-registry.js';

/**
 * Cycle 4 Task T19 (F10 — security): pre-filter caller-supplied MCP
 * server names against the registry-known set BEFORE handing them to
 * `resolveServers`. Unknown names must not reach
 * `mcp-registry.ts:75` where they would be interpolated raw into the
 * warning message. Emits only bounded metadata (counts) via the
 * adapter's scoped logger — never the unknown-name strings
 * themselves, which crossed the trust boundary from the MCP tool
 * caller.
 *
 * Guarded via `typeof listRegisteredServers === 'function'` so that
 * test harnesses which mock the mcp-registry module with a narrower
 * surface (omitting listRegisteredServers) fall through the filter
 * transparently. In production, `listRegisteredServers` is always a
 * function, and the filter runs as intended.
 */
function sanitizeMcpServerNames(
  requested: string[],
  log: StructuredLogger,
): string[] {
  if (typeof listRegisteredServers !== 'function') {
    return requested;
  }
  const known = new Set(listRegisteredServers());
  const kept: string[] = [];
  let droppedCount = 0;
  for (const name of requested) {
    if (known.has(name)) {
      kept.push(name);
    } else {
      droppedCount++;
    }
  }
  if (droppedCount > 0) {
    log.warn('Unknown MCP servers skipped', {
      unknownCount: droppedCount,
      knownCount: kept.length,
    });
  }
  return kept;
}

const CODEX_CONFIG: CLIBuilderConfig = {
  command: 'codex',
  defaultArgs: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'],
  modelArgName: '--model',
  jsonFlag: '--json',
  mpcEnvCleanup: ['CODEX_MCP_CONFIG', 'MCP_ENABLED'],
  promptWrapper: (sys, user) => `${sys}\n\n${user}\n\nUse your shell tools to read files (cat, ls, find, grep, head, etc.) and analyze the codebase. You ARE allowed to run read-only commands. Explore the directory structure, read relevant source files, and provide a comprehensive brutal analysis based on what you find.`,
  mcpSupport: {
    configMethod: 'config-override',
    configOverrideKey: 'mcp_servers',
    writeProtection: {
      method: 'sandbox',
      flag: '--sandbox',
      value: 'read-only', // already in defaultArgs
    },
  },
};

export class CodexAdapter implements CLIProvider {
  readonly name: CLIName = 'codex';

  getConfig(): CLIBuilderConfig {
    return CODEX_CONFIG;
  }

  async buildCommand(
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
  }> {
    const log = options.log ?? rootLogger;
    const config = CODEX_CONFIG;
    const mcpEnabled = options.mcpServers && options.mcpServers.length > 0;

    // Build args
    const args = [...config.defaultArgs];
    const resolvedModel = modelResolver.resolveModel('codex', options.models?.codex);
    if (resolvedModel) {
      args.push(config.modelArgName, resolvedModel);
    }
    if (config.jsonFlag && process.env.CODEX_USE_JSON !== 'false') {
      args.push(config.jsonFlag);
    }

    // MCP configuration
    let tempMcpConfigPath: string | undefined;

    if (mcpEnabled && config.mcpSupport) {
      // Pre-filter via sanitizeMcpServerNames — unknown names are
      // dropped before they reach `mcp-registry.ts:75`
      // (Cycle 4 Task T19 / F10).
      const sanitizedNames = sanitizeMcpServerNames(options.mcpServers!, log);
      const servers = resolveServers(sanitizedNames);
      const serverNames = Object.keys(servers);

      if (serverNames.length > 0) {
        const mcp = config.mcpSupport;

        // Codex: -c 'mcp_servers={...}' -- replaces all configured servers (excludes brutalist)
        const tomlOverride = buildCodexMCPOverride(servers);
        args.push('-c', `${mcp.configOverrideKey!}=${tomlOverride}`);
        // Write protection already in defaultArgs (--sandbox read-only)

        log.info(`\u{1F50C} MCP enabled for codex: [${serverNames.join(', ')}]`);
      }
    }

    // Build prompt -- skip CLI-specific wrapper in debate mode (prevents Codex
    // from exploring the brutalist repo and reading its own control prompts)
    const combinedPrompt = (config.promptWrapper && !options.debateMode)
      ? config.promptWrapper(systemPrompt, userPrompt)
      : `${systemPrompt}\n\n${userPrompt}`;

    // Add CLI-specific env
    const env = { ...secureEnv };

    // Add required API key
    const apiKeys = ['OPENAI_API_KEY'];
    for (const key of apiKeys) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    // Clean up MPC env vars that could cause deadlock -- SKIP when MCP is enabled
    if (!mcpEnabled && config.mpcEnvCleanup) {
      for (const envVar of config.mpcEnvCleanup) {
        delete env[envVar];
      }
    }

    env.BRUTALIST_SUBPROCESS = '1';

    return { command: config.command, args, input: combinedPrompt, env, tempMcpConfigPath };
  }

  /**
   * Extract only the agent messages from Codex JSON output.
   * Filters for item.type === 'agent_message', skipping reasoning,
   * command_execution, and error events.
   */
  decodeOutput(rawOutput: string, args: string[], log?: StructuredLogger): string {
    // Only decode if Codex was run with --json flag
    if (!args.includes('--json')) {
      return rawOutput;
    }
    return this.extractCodexAgentMessage(rawOutput, log ?? rootLogger);
  }

  private extractCodexAgentMessage(jsonOutput: string, log: StructuredLogger): string {
    if (!jsonOutput || !jsonOutput.trim()) {
      log.debug('extractCodexAgentMessage: empty input');
      return '';
    }

    const agentMessages: string[] = [];
    const events = parseNDJSON(jsonOutput, log);

    log.debug(`extractCodexAgentMessage: processing ${events.length} JSON events`);

    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;

      const typedEvent = event as { type?: string; item?: any };

      log.debug(`extractCodexAgentMessage: parsed event type=${typedEvent.type}, item.type=${typedEvent.item?.type}`);

      // Codex --json outputs events with structure: {"type":"item.completed","item":{...}}
      // Only extract agent_message type - this is the actual response
      if (typedEvent.type === 'item.completed' && typedEvent.item) {
        if (typedEvent.item.type === 'agent_message' && typedEvent.item.text) {
          // Agent's actual response text
          log.info(`\u2705 extractCodexAgentMessage: found agent_message with ${typedEvent.item.text.length} chars`);
          agentMessages.push(typedEvent.item.text);
        }
        // Skip all other types:
        // - reasoning: internal thinking steps
        // - command_execution: file reads, bash commands
        // - error: will be in stderr
      }
    }

    const result = agentMessages.join('\n\n').trim();
    log.info(`extractCodexAgentMessage: extracted ${agentMessages.length} messages, total ${result.length} chars`);
    return result;
  }
}
