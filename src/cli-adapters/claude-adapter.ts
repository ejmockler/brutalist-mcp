/**
 * Claude CLI Adapter
 *
 * Encapsulates Claude-specific CLI configuration, command construction,
 * and output decoding (stream-json NDJSON parsing).
 *
 * Pattern A (integrate-observability): logger is threaded via
 * CLIAgentOptions.log (buildCommand) and via the optional `log` parameter
 * on decodeOutput. When absent the adapter falls back to the root logger
 * singleton so legacy test proxies and un-instrumented callers keep
 * working. All emissions flow through a local `log` variable so no
 * `logger.*` direct-import call sites remain in this file.
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
  writeClaudeMCPConfig,
  ensurePlaywrightBrowsers,
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

const CLAUDE_CONFIG: CLIBuilderConfig = {
  command: 'claude',
  defaultArgs: ['--print'],
  modelArgName: '--model',
  mpcEnvCleanup: ['CLAUDE_MCP_CONFIG', 'MCP_ENABLED', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  streamingArgs: () => ['--output-format', 'stream-json', '--verbose'],
  mcpSupport: {
    configMethod: 'flag-file',
    configFlag: '--mcp-config',
    strictFlag: '--strict-mcp-config',
    writeProtection: {
      method: 'disallowed-tools',
      flag: '--disallowedTools',
      value: 'Edit,Write,NotebookEdit',
    },
  },
};

export class ClaudeAdapter implements CLIProvider {
  readonly name: CLIName = 'claude';

  getConfig(): CLIBuilderConfig {
    return CLAUDE_CONFIG;
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
    const config = CLAUDE_CONFIG;
    const mcpEnabled = options.mcpServers && options.mcpServers.length > 0;

    // Build args
    const args = [...config.defaultArgs];
    const resolvedModel = modelResolver.resolveModel('claude', options.models?.claude);
    if (resolvedModel) {
      args.push(config.modelArgName, resolvedModel);
    }
    if (config.streamingArgs) {
      args.push(...config.streamingArgs(options));
    }

    // Always enforce write-tool denial and permission bypass for non-interactive
    // tool use. In --print mode, Claude Code silently skips tool calls that
    // would otherwise require approval; for verification-oriented prompts
    // (legal, research, security), this caused agents to fall back to
    // training-data answers instead of invoking WebSearch/WebFetch. Lifting
    // these two flags out of the MCP conditional ensures native web/search
    // tools are usable in every run while preserving the Edit/Write/
    // NotebookEdit barrier. MCP wiring below remains gated on mcpEnabled.
    if (config.mcpSupport) {
      args.push(config.mcpSupport.writeProtection.flag, config.mcpSupport.writeProtection.value);
      args.push('--permission-mode', 'bypassPermissions');
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

      // Auto-install Playwright browsers if playwright is requested
      if (servers.playwright) {
        await ensurePlaywrightBrowsers();
      }

      if (serverNames.length > 0) {
        const mcp = config.mcpSupport;

        // Claude: write temp JSON config, pass --mcp-config <path> --strict-mcp-config
        const sessionId = options.sessionId || 'default';
        tempMcpConfigPath = await writeClaudeMCPConfig(servers, sessionId);
        args.push(mcp.configFlag!, tempMcpConfigPath);
        args.push(mcp.strictFlag!);

        log.info(`\u{1F50C} MCP enabled for claude: [${serverNames.join(', ')}]`);
      }
    }

    // Build prompt -- no promptWrapper for Claude
    const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;

    // Add CLI-specific env
    const env = { ...secureEnv };

    // Add required API key
    const apiKeys = ['ANTHROPIC_API_KEY'];
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
   * Decode Claude's stream-json NDJSON output into plain text.
   * Extracts text content blocks from all 'assistant' events across all turns.
   * Skips system events, user events (tool results with raw file contents), and
   * tool_use content blocks within assistant events.
   * Falls back to 'result' event if no assistant text was captured.
   */
  decodeOutput(rawOutput: string, args: string[], log?: StructuredLogger): string {
    // Only decode if Claude was run with stream-json format
    if (!(args.includes('--output-format') && args.includes('stream-json'))) {
      return rawOutput;
    }
    return this.decodeClaudeStreamJson(rawOutput, log ?? rootLogger);
  }

  private decodeClaudeStreamJson(ndjsonOutput: string, log: StructuredLogger): string {
    if (!ndjsonOutput || !ndjsonOutput.trim()) {
      log.warn('decodeClaudeStreamJson: empty input');
      return '';
    }

    const events = parseNDJSON(ndjsonOutput, log);

    if (events.length === 0) {
      log.warn('decodeClaudeStreamJson: no valid JSON events found in output');
      return '';
    }

    const textParts: string[] = [];
    let resultText = '';
    // Cycle 4 Task T17 (F8 — security): do NOT retain the raw
    // `typedEvent.error || typedEvent.result` string from a Claude
    // result-error event. The raw value can contain provider-side
    // stdout/stderr fragments, prompt echoes, tool-output snippets,
    // or MCP override content that must not reach the logger (which
    // may flush to an aggregator) or the decoded output (which is
    // returned up to `_executeCLI` and exposed via the
    // `CLIAgentResponse.output` field). Instead, we only track
    // whether an error was present and classify its shape via the
    // event subtype / is_error flag for metadata-only emission.
    let errorPresent = false;
    let errorClass: string | undefined;

    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;

      const typedEvent = event as Record<string, any>;

      if (typedEvent.type === 'assistant' && typedEvent.message?.content) {
        // Extract only text blocks from assistant messages (skip tool_use blocks)
        const content = typedEvent.message.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text' && item.text) {
              textParts.push(item.text);
            }
          }
        }
      } else if (typedEvent.type === 'result') {
        if (typedEvent.subtype === 'error' || typedEvent.is_error) {
          errorPresent = true;
          // errorClass captures only the shape of the error, not its
          // content: the event subtype (static enum) or a fallback
          // tag. Never the underlying `typedEvent.error` /
          // `typedEvent.result` string value.
          errorClass = typeof typedEvent.subtype === 'string' && typedEvent.subtype.length > 0
            ? typedEvent.subtype
            : (typedEvent.is_error ? 'is_error' : 'unknown');
        } else if (typedEvent.result) {
          resultText = typedEvent.result;
        }
      }
      // Skip: system, user (tool_result with raw file contents), hooks
    }

    // Handle error — emit metadata only (F8). The raw error string is
    // intentionally never logged and never returned as decoded output.
    if (errorPresent) {
      log.error('decodeClaudeStreamJson: Claude returned error result', {
        errorPresent: true,
        eventCount: events.length,
        errorClass: errorClass ?? 'unknown',
      });
      // Return a content-free marker. Callers see that decodedText is
      // truthy (non-empty) and propagate it to `finalOutput` — the
      // marker itself carries no sensitive content. A future iteration
      // can surface a structured adapter-error signal via a new
      // return shape; for now the marker keeps the existing string
      // return type intact with zero sensitive bytes.
      return '[Claude Error] <redacted>';
    }

    // Use accumulated assistant text if available, fall back to result event
    if (textParts.length > 0) {
      return textParts.join('\n\n');
    }

    if (resultText) {
      return resultText;
    }

    log.warn('decodeClaudeStreamJson: no text content found in stream-json output', {
      eventCount: events.length,
      eventTypes: events.map(e => (e as any).type).filter(Boolean)
    });
    return '';
  }
}
