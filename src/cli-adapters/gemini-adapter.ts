/**
 * Gemini CLI Adapter
 *
 * Encapsulates Gemini-specific CLI configuration, command construction,
 * and output decoding (JSON response field extraction).
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
import {
  resolveServers,
  listRegisteredServers,
  ensureGeminiMCPServers,
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

const GEMINI_CONFIG: CLIBuilderConfig = {
  command: 'gemini',
  defaultArgs: ['--output-format', 'json'],
  modelArgName: '--model',
  envExtras: { TERM: 'dumb', NO_COLOR: '1', CI: 'true' },
  mpcEnvCleanup: ['GEMINI_MCP_CONFIG', 'MCP_ENABLED'],
  mcpSupport: {
    configMethod: 'server-whitelist',
    whitelistFlag: '--allowed-mcp-server-names',
    writeProtection: {
      method: 'approval-mode',
      flag: '--approval-mode',
      value: 'plan',
    },
  },
};

/**
 * Frontier Gemini model chain.
 *
 * Ordered by preference: newest pro preview → previous pro preview →
 * 3-series flash preview. The orchestrator rotates through this chain
 * on saturation/access failures (429 / "No capacity available" / 403),
 * trading "freshest capability" for "delivered response" as the
 * preview tiers exhaust.
 *
 * Rationale: Gemini CLI's default Auto routing resolves to
 * `gemini-2.5-flash-lite` for prompts the router classifies as "simple" —
 * a classification our full adversarial verification protocol apparently
 * does not escape. flash-lite lacks the capacity to maintain URL/quote
 * source-provenance across 5+ citation verification loads, so it
 * fabricates. Pinning specific frontier models trades the Auto router's
 * variable downselect for predictable capacity; rotation handles the
 * preview tier's availability.
 *
 * Why `gemini-3-flash-preview` as the floor (not `gemini-2.5-pro`):
 * Gemini 3 Flash ships with "Pro-grade reasoning at Flash-level speed
 * and lower cost" per Google's docs, and unlike 2.5-flash-lite it has
 * the capacity for our verification protocol. It's also priced an
 * order of magnitude below the pro tiers, so when both pro previews
 * are unavailable, 3-flash is a substantively better fallback than
 * dropping a generation back to 2.5-pro.
 *
 * Probe-tested in Gemini CLI: the strings below are the canonical
 * preview identifiers. `gemini-3-pro`, `gemini-3.1-pro`,
 * `gemini-3.0-pro`, `gemini-3-flash` (no `-preview`),
 * `gemini-3-pro-exp`, `gemini-3-pro-002`, and `gemini-pro-3` all
 * return ModelNotFoundError. The `-preview` suffix is required for
 * the 3.x tier.
 *
 * Override the whole chain with a single model via
 * `BRUTALIST_GEMINI_MODEL=...` (disables rotation — operator takes
 * responsibility for availability; this is the path for users who
 * still want `gemini-2.5-pro` as their pin). Passing `models.gemini`
 * on a tool call similarly disables rotation.
 */
export const GEMINI_FRONTIER_CHAIN: readonly string[] = Object.freeze([
  'gemini-3.1-pro-preview',  // newest pro frontier, preview (capacity-limited)
  'gemini-3-pro-preview',    // previous pro frontier, preview
  'gemini-3-flash-preview',  // 3-series flash, pro-grade reasoning at flash cost
]);

const GEMINI_FRONTIER_MODEL = process.env.BRUTALIST_GEMINI_MODEL || GEMINI_FRONTIER_CHAIN[0];

export class GeminiAdapter implements CLIProvider {
  readonly name: CLIName = 'gemini';

  getConfig(): CLIBuilderConfig {
    return GEMINI_CONFIG;
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
    model?: string;
  }> {
    const log = options.log ?? rootLogger;
    const config = GEMINI_CONFIG;
    const mcpEnabled = options.mcpServers && options.mcpServers.length > 0;

    // Build args
    const args = [...config.defaultArgs];
    // Priority: caller-specified > env override > frontier default.
    // We always pass --model to prevent Gemini CLI's Auto router from
    // silently downselecting to flash-lite under verification load.
    const resolvedModel = modelResolver.resolveModel('gemini', options.models?.gemini) || GEMINI_FRONTIER_MODEL;
    args.push(config.modelArgName, resolvedModel);

    // MCP configuration
    if (mcpEnabled && config.mcpSupport) {
      // Pre-filter via sanitizeMcpServerNames — unknown names are
      // dropped before they reach `mcp-registry.ts:75`
      // (Cycle 4 Task T19 / F10).
      const sanitizedNames = sanitizeMcpServerNames(options.mcpServers!, log);
      const servers = resolveServers(sanitizedNames);
      const serverNames = Object.keys(servers);

      if (serverNames.length > 0) {
        const mcp = config.mcpSupport;

        // Gemini: --allowed-mcp-server-names <names> --approval-mode plan
        await ensureGeminiMCPServers(servers);
        args.push(mcp.whitelistFlag!, ...serverNames);
        args.push(mcp.writeProtection.flag, mcp.writeProtection.value);

        log.info(`\u{1F50C} MCP enabled for gemini: [${serverNames.join(', ')}]`);
      }
    }

    // Build prompt -- no promptWrapper for Gemini
    const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;

    // Add CLI-specific env extras
    const env = { ...secureEnv };
    if (config.envExtras) {
      Object.assign(env, config.envExtras);
    }

    // Add required API keys
    const apiKeys = ['GOOGLE_API_KEY', 'GEMINI_API_KEY'];
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

    return { command: config.command, args, input: combinedPrompt, env, model: resolvedModel };
  }

  /**
   * Extract response text from Gemini --output-format json output.
   * Parses a single JSON object and returns the `response` field.
   */
  decodeOutput(rawOutput: string, args: string[], log?: StructuredLogger): string {
    // Only decode if Gemini was run with --output-format json
    if (!(args.includes('--output-format') && args.includes('json'))) {
      return rawOutput;
    }
    return this.extractGeminiResponse(rawOutput, log ?? rootLogger);
  }

  private extractGeminiResponse(jsonOutput: string, log: StructuredLogger): string {
    if (!jsonOutput || !jsonOutput.trim()) {
      log.debug('extractGeminiResponse: empty input');
      return '';
    }

    try {
      const parsed = JSON.parse(jsonOutput);
      if (parsed.response && typeof parsed.response === 'string') {
        log.info(`\u2705 extractGeminiResponse: extracted response with ${parsed.response.length} chars`);
        return parsed.response;
      }
      log.warn('extractGeminiResponse: no response field in JSON output', {
        keys: Object.keys(parsed)
      });
      return '';
    } catch (e) {
      // Redacted: raw jsonOutput is never emitted — only its length plus
      // the parse error reason. Prevents prompt / response leakage
      // through log aggregators.
      log.warn('extractGeminiResponse: failed to parse JSON, returning raw output', {
        error: e instanceof Error ? e.message : String(e),
        length: jsonOutput.length
      });
      return '';
    }
  }
}
