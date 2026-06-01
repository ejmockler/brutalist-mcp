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
import { parseNDJSON } from './shared.js';
import { resolveServers, listRegisteredServers, buildCodexMCPOverride, } from '../mcp-registry.js';
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
function sanitizeMcpServerNames(requested, log) {
    if (typeof listRegisteredServers !== 'function') {
        return requested;
    }
    const known = new Set(listRegisteredServers());
    const kept = [];
    let droppedCount = 0;
    for (const name of requested) {
        if (known.has(name)) {
            kept.push(name);
        }
        else {
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
const CODEX_CONFIG = {
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
export class CodexAdapter {
    name = 'codex';
    getConfig() {
        return CODEX_CONFIG;
    }
    async buildCommand(userPrompt, systemPrompt, options, modelResolver, secureEnv) {
        const log = options.log ?? rootLogger;
        const config = CODEX_CONFIG;
        const mcpEnabled = options.mcpServers && options.mcpServers.length > 0;
        // Build args
        const args = [...config.defaultArgs];
        const allowModelOverride = process.env.BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE === 'true';
        const requestedModel = options.models?.codex;
        if (requestedModel && !allowModelOverride) {
            log.info('Codex model override ignored; using Codex CLI configured/default model', {
                requestedModelLength: requestedModel.length,
            });
        }
        const resolvedModel = allowModelOverride
            ? modelResolver.resolveModel('codex', requestedModel)
            : undefined;
        if (resolvedModel) {
            args.push(config.modelArgName, resolvedModel);
        }
        if (config.jsonFlag && process.env.CODEX_USE_JSON !== 'false') {
            args.push(config.jsonFlag);
        }
        // MCP configuration
        let tempMcpConfigPath;
        if (mcpEnabled && config.mcpSupport) {
            // Pre-filter via sanitizeMcpServerNames — unknown names are
            // dropped before they reach `mcp-registry.ts:75`
            // (Cycle 4 Task T19 / F10).
            const sanitizedNames = sanitizeMcpServerNames(options.mcpServers, log);
            const servers = resolveServers(sanitizedNames);
            const serverNames = Object.keys(servers);
            if (serverNames.length > 0) {
                const mcp = config.mcpSupport;
                // Codex: -c 'mcp_servers={...}' -- replaces all configured servers (excludes brutalist)
                const tomlOverride = buildCodexMCPOverride(servers);
                args.push('-c', `${mcp.configOverrideKey}=${tomlOverride}`);
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
            if (process.env[key])
                env[key] = process.env[key];
        }
        // Clean up MPC env vars that could cause deadlock -- SKIP when MCP is enabled
        if (!mcpEnabled && config.mpcEnvCleanup) {
            for (const envVar of config.mpcEnvCleanup) {
                delete env[envVar];
            }
        }
        env.BRUTALIST_SUBPROCESS = '1';
        return { command: config.command, args, input: combinedPrompt, env, tempMcpConfigPath, model: resolvedModel };
    }
    /**
     * Extract only the agent messages from Codex JSON output.
     * Filters for item.type === 'agent_message', skipping reasoning,
     * command_execution, and error events.
     */
    decodeOutput(rawOutput, args, log) {
        // Legacy text-only API. Returns assistant text on success, empty
        // string on refusal/error.
        const result = this.decode(rawOutput, '', args, log);
        return result.kind === 'ok' ? result.text : '';
    }
    decode(stdout, stderr, args, log) {
        // Only structured-decode if Codex was run with --json
        if (!args.includes('--json')) {
            return { kind: 'ok', text: stdout };
        }
        return this.decodeStream(stdout, stderr, log ?? rootLogger);
    }
    /**
     * Structured decode of Codex --json output.
     *
     * Codex emits NDJSON `item.completed` events. Agent text comes in
     * `item.type === 'agent_message'`. Codex error/quota state is NOT in
     * the JSON event stream — per the inline comment in extractCodexAgentMessage
     * ("error: will be in stderr"), it lands on stderr. So:
     *   - assistant text present → ok
     *   - no text + stderr matches anchored Codex quota markers → refused
     *   - no text + no markers → error (empty)
     *
     * Anchored markers operate only on stderr (the CLI's own error
     * channel), never on assistant prose. Aligned with the discipline
     * applied to Claude's error envelope.
     */
    decodeStream(jsonOutput, stderr, log) {
        if (!jsonOutput || !jsonOutput.trim()) {
            // No stdout at all — could be a refusal that printed only to
            // stderr. Check anchored markers there before declaring empty.
            const refusalFromStderr = classifyCodexStderrReason(stderr);
            if (refusalFromStderr === 'auth') {
                return { kind: 'refused', reason: 'auth' };
            }
            if (refusalFromStderr === 'quota') {
                return { kind: 'refused', reason: 'quota' };
            }
            log.debug('extractCodexAgentMessage: empty input');
            return { kind: 'error', reason: 'empty' };
        }
        const text = this.extractCodexAgentMessage(jsonOutput, log);
        if (text.length > 0) {
            return { kind: 'ok', text };
        }
        // No agent_message extracted. Examine stderr for anchored Codex
        // refusal markers — the only place codex puts quota/auth state.
        const refusalFromStderr = classifyCodexStderrReason(stderr);
        if (refusalFromStderr === 'auth') {
            return { kind: 'refused', reason: 'auth' };
        }
        if (refusalFromStderr === 'quota') {
            return { kind: 'refused', reason: 'quota' };
        }
        return { kind: 'error', reason: 'empty' };
    }
    extractCodexAgentMessage(jsonOutput, log) {
        if (!jsonOutput || !jsonOutput.trim()) {
            log.debug('extractCodexAgentMessage: empty input');
            return '';
        }
        const agentMessages = [];
        const events = parseNDJSON(jsonOutput, log);
        log.debug(`extractCodexAgentMessage: processing ${events.length} JSON events`);
        for (const event of events) {
            if (typeof event !== 'object' || event === null)
                continue;
            const typedEvent = event;
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
/**
 * Classify Codex stderr against anchored OpenAI/Codex quota markers.
 * Operates only on stderr (the CLI's own error channel), never on
 * assistant prose. Returns 'quota' on a positive match, 'unknown'
 * otherwise.
 *
 * Anchored markers chosen against the literal strings Codex / the
 * OpenAI API surface in error envelopes:
 *   - "rate_limit_exceeded"          — API error code
 *   - "insufficient_quota"           — API error code
 *   - "quota_exceeded"               — alt error code
 *   - "429"                          — HTTP status
 *   - "Too Many Requests"            — HTTP reason phrase
 *   - "usage cap"                    — ChatGPT plan cap phrasing
 *   - "ChatGPT Plus" + "limit"       — paired marker for plan caps
 *
 * Auth markers (added after CI diagnosis 2026-06): codex does HARD OAuth
 * refresh-token rotation. A static captured CODEX_AUTH secret goes stale
 * (its refresh_token is consumed on first use), so CI startups hit
 * `401 ... refresh_token_reused` and exit 1 in ~2s. Without these markers
 * that surfaced as the opaque "CODEX execution failed"; classifying it as
 * an auth refusal lets the summary say "codex auth expired — re-capture
 * CODEX_AUTH (or provision OPENAI_API_KEY)".
 *
 * No loose `quota`/`limit`/`rate limit` patterns — those bit us in
 * Phase 1. Stay anchored to literal vendor error strings.
 */
function classifyCodexStderrReason(stderr) {
    if (!stderr)
        return 'unknown';
    // Auth checked first: a stale-token failure is a distinct, actionable
    // outcome from a quota cap.
    const authMarkers = [
        /refresh_token_reused/i,
        /refresh token was already used/i,
        /Failed to refresh token/i,
    ];
    if (authMarkers.some((p) => p.test(stderr)))
        return 'auth';
    const markers = [
        /rate_limit_exceeded/i,
        /insufficient_quota/i,
        /quota_exceeded/i,
        /\b429\b/,
        /Too Many Requests/i,
        /usage cap/i,
    ];
    if (markers.some((p) => p.test(stderr)))
        return 'quota';
    // Paired marker — "ChatGPT Plus" alongside "limit" indicates the plan
    // cap. Required as a pair so the word "limit" alone never fires.
    if (/ChatGPT (?:Plus|Pro|Team|Enterprise)/i.test(stderr) && /\blimit\b/i.test(stderr)) {
        return 'quota';
    }
    return 'unknown';
}
//# sourceMappingURL=codex-adapter.js.map