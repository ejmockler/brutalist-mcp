/**
 * Orchestrator entry point.
 *
 * Wave-2 tasks #6 (MCP wiring) and #8 (structured output) are both in
 * place. The structured-output mechanism uses the SDK's in-process MCP
 * tool pattern: we register a `submit_findings` tool whose input schema
 * is the OrchestratorResult shape. The agent calls it as its terminal
 * action; the handler captures the Zod-validated args, and the run()
 * function returns the captured payload.
 *
 * This is preferable to a JSON-marker-in-text pattern because:
 *   - Schema validation happens at the SDK tool boundary (not after the
 *     fact via Zod parse on string output).
 *   - Partial/malformed output never reaches the caller — the SDK
 *     rejects the tool call before our handler runs.
 *   - The agent can't "forget" the contract: the system prompt (#9)
 *     instructs it that the run completes only after submit_findings.
 */

import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Options, McpServerConfig, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunOptions, OrchestratorResult } from './schemas.js';
import { OrchestratorResultSchema } from './schemas.js';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './system-prompt.js';

// MCP tool naming convention used by Claude Agent SDK: `mcp__<server>__<tool>`.
const BRUTALIST_MCP_SERVER_NAME = 'brutalist';
const ORCHESTRATOR_MCP_SERVER_NAME = 'orchestrator';
const BRUTALIST_TOOL_PREFIX = `mcp__${BRUTALIST_MCP_SERVER_NAME}__` as const;
const ORCHESTRATOR_TOOL_PREFIX = `mcp__${ORCHESTRATOR_MCP_SERVER_NAME}__` as const;

const SUBMIT_FINDINGS_TOOL_NAME = 'submit_findings';

// Allowlist of brutalist tools the orchestrator may call. The debate
// tool is intentionally excluded — debate is wrong-shaped for breadth
// PR analysis.
export const ALLOWED_BRUTALIST_TOOLS: readonly string[] = Object.freeze([
  `${BRUTALIST_TOOL_PREFIX}roast`,
  `${BRUTALIST_TOOL_PREFIX}brutalist_discover`,
  `${BRUTALIST_TOOL_PREFIX}cli_agent_roster`,
]);

export const DENIED_BRUTALIST_TOOLS: readonly string[] = Object.freeze([
  `${BRUTALIST_TOOL_PREFIX}roast_cli_debate`,
]);

const SUBMIT_FINDINGS_TOOL_FQ = `${ORCHESTRATOR_TOOL_PREFIX}${SUBMIT_FINDINGS_TOOL_NAME}` as const;

/**
 * Thrown by `run()` when the agent finished its turn without ever
 * invoking `submit_findings`. This is the loud failure mode for
 * silent-empty-result drift identified in the brutalist self-review:
 * an empty findings array is an actively misleading signal because it
 * masks auth failures, prompt failures, schema failures, and tool-call
 * failures alike. Adapters MUST surface this as a hard error so the
 * caller knows to investigate, not as "no issues found".
 */
export class OrchestratorIncompleteError extends Error {
  constructor(public readonly messageCount: number) {
    super(
      `Orchestrator finished without calling submit_findings (${messageCount} agent message(s) drained). ` +
        `This indicates a failure earlier in the pipeline — auth, prompt, tool call, or schema — not "no findings". ` +
        `Inspect SDK logs or re-run with verbose telemetry.`,
    );
    this.name = 'OrchestratorIncompleteError';
  }
}

/**
 * Thrown when the wall-clock budget elapses. Distinguished from
 * OrchestratorIncompleteError because the failure mode is different:
 * here the agent was making forward progress, just too slowly. The
 * caller may want to retry or split the workload.
 */
export class OrchestratorTimeoutError extends Error {
  constructor(public readonly timeoutMs: number, public readonly messageCount: number) {
    super(
      `Orchestrator exceeded wall-clock budget of ${timeoutMs}ms after ${messageCount} agent message(s). ` +
        `Most likely a child CLI subprocess (claude/codex/gemini) stalled. ` +
        `Raise timeoutMs, split the diff, or investigate the stalled critic.`,
    );
    this.name = 'OrchestratorTimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export async function run(options: RunOptions): Promise<OrchestratorResult> {
  // Closure-scoped capture for the structured output. The submit_findings
  // tool's handler writes here; run() reads after query() drains.
  let captured: OrchestratorResult | undefined;
  let submitCount = 0;

  const submitFindings = tool(
    SUBMIT_FINDINGS_TOOL_NAME,
    'Submit the final structured findings extracted from per-CLI brutalist output. Call this exactly once as the terminal action of the analysis. Calling more than once is an error.',
    OrchestratorResultSchema.shape,
    async (args) => {
      // Refuse the second-and-beyond *successful* invocation. The guard
      // gates on `captured !== undefined` rather than a counter so that
      // a defensive-parse failure (e.g. shape drift via a corrupt
      // payload) leaves the door open for the agent to retry. The
      // earlier counter-based guard was order-sensitive: if the
      // re-parse threw, the counter advanced but `captured` stayed
      // undefined, locking the agent out of recovery and ending the run
      // as OrchestratorIncompleteError.
      if (captured !== undefined) {
        submitCount++;
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `submit_findings has already been called once successfully. The run is terminal. Do not call it again.`,
            },
          ],
        };
      }
      // The SDK has already validated args against the schema before
      // calling this handler. Re-parse defensively with our own Zod
      // instance so version mismatches surface as a clear error rather
      // than silent shape drift. If parse throws, captured stays
      // undefined and the agent can retry with a corrected payload.
      const parsed = OrchestratorResultSchema.parse(args);

      // Reject empty payloads as terminal action. A run where the agent
      // failed every roast call but still submitted is operationally
      // identical to "no issues" — that's exactly the wrong signal.
      // Force the agent to either populate something or never submit
      // (which triggers OrchestratorIncompleteError downstream).
      if (
        parsed.perCli.length === 0 &&
        parsed.findings.length === 0 &&
        parsed.outOfDiff.length === 0 &&
        parsed.synthesis.trim() === ''
      ) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `submit_findings rejected: payload is entirely empty (no perCli, no findings, no outOfDiff, no synthesis). ` +
                `If the brutalist roast calls failed, do NOT submit — let the run terminate as incomplete so the failure is visible. ` +
                `If they succeeded but found nothing, populate perCli with the CLI execution metadata at minimum.`,
            },
          ],
        };
      }

      captured = parsed;
      submitCount++;
      return {
        content: [
          {
            type: 'text',
            text: `Findings submitted: ${captured.findings.length} inline, ${captured.outOfDiff.length} out-of-diff.`,
          },
        ],
      };
    },
  );

  const orchestratorMcp = createSdkMcpServer({
    name: ORCHESTRATOR_MCP_SERVER_NAME,
    version: '0.0.1',
    tools: [submitFindings],
  });

  // Inherit the parent's full environment so spawned subprocesses keep
  // PATH (to locate `claude`/`codex`/`gemini`/`node`), HOME (for CLI
  // config dirs), and the rest of the toolchain. We then layer
  // brutalist-specific keys on top — this is the only correct
  // composition; partial env objects are not "additive" with most
  // child_process.spawn implementations, they're complete replacements.
  const inheritedEnv = filterUndefined(process.env);
  const brutalistConfig: McpServerConfig = {
    type: 'stdio',
    command: options.brutalistMcpCommand ?? 'brutalist-mcp',
    args: [],
    env: {
      ...inheritedEnv,
      // The OAuth token doubles as auth for brutalist's inner Claude
      // critic — without forwarding it, the brutalist subprocess's
      // claude-adapter falls back to ANTHROPIC_API_KEY which the user
      // hasn't supplied. Forward it explicitly so a single secret
      // covers both the orchestrator brain and the inner critic.
      CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken,
      // Provider keys forwarded explicitly only when present, so we don't
      // overwrite any pre-existing value with `undefined`.
      ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
      ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
      ...(process.env.GEMINI_API_KEY ? { GEMINI_API_KEY: process.env.GEMINI_API_KEY } : {}),
      ...(process.env.GOOGLE_API_KEY ? { GOOGLE_API_KEY: process.env.GOOGLE_API_KEY } : {}),
    },
  };

  // Wall-clock budget: cancel the SDK iterator if a child CLI stalls
  // past the timeout. Without this, maxTurns:20 still allows a single
  // wedged subprocess to hold the loop for the GH Actions job timeout
  // (6h default). The AbortController propagates through the SDK's
  // child-process tree.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  // Mark the handle for garbage collection on early-exit paths.
  if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

  const queryOptions: Options = {
    abortController,
    cwd: options.repoPath,
    mcpServers: {
      [BRUTALIST_MCP_SERVER_NAME]: brutalistConfig,
      [ORCHESTRATOR_MCP_SERVER_NAME]: orchestratorMcp,
    },
    // Built-in tools: Read + Grep are needed by the orchestrator itself
    // to verify verbatim quotes and inspect the repo when prose
    // references files. Edit/Write/Bash are intentionally absent.
    tools: ['Read', 'Grep'],
    allowedTools: [
      ...ALLOWED_BRUTALIST_TOOLS,
      SUBMIT_FINDINGS_TOOL_FQ,
      'Read',
      'Grep',
    ],
    disallowedTools: [...DENIED_BRUTALIST_TOOLS],
    systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
    // Hard cap on agent turns. Without this, a confused agent can loop
    // until the GitHub Actions job timeout (6h default) before failing.
    // 20 turns covers: optional brutalist_discover, up to 3 roast calls,
    // pagination follow-ups (each roast may need 2–3 page reads),
    // grep-based quote verification, and the terminal submit_findings.
    // The system prompt's "at most 3 roast calls" remains the primary
    // budget; this is the seatbelt.
    maxTurns: 20,
    env: {
      // Inherit parent env (PATH, HOME, runner-injected vars). Without
      // this the spawned `claude` binary used by the Agent SDK can't be
      // located. The OAuth token is layered on top.
      ...inheritedEnv,
      // The Agent SDK reads CLAUDE_CODE_OAUTH_TOKEN for OAuth-mode auth
      // (Claude.ai session token from `claude setup-function`).
      CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken,
    },
    // Pin the claude executable to the path the action's preflight
    // resolved. Without this, the SDK falls back to bundle-internal
    // native package lookup, which is not present in our ncc-bundled
    // action artifact. PATH-resolved binary is the safe default.
    ...(options.claudeCodeExecutablePath
      ? { pathToClaudeCodeExecutable: options.claudeCodeExecutablePath }
      : {}),
  };

  const userPrompt = buildUserPrompt(options);

  // Drain the message stream. We only consult `captured` afterwards;
  // intermediate messages are not retained (memory + downstream parsing
  // happen via the SDK tool handler boundary).
  let messageCount = 0;
  try {
    for await (const _message of query({ prompt: userPrompt, options: queryOptions })) {
      messageCount++;
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new OrchestratorTimeoutError(timeoutMs, messageCount);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!captured) {
    // Fail loud rather than returning an empty-but-valid result. An
    // empty result is operationally indistinguishable from "everything
    // is fine" — that's exactly the wrong signal when the actual
    // failure was upstream (auth, prompt rejection, tool-call refusal,
    // SDK crash). The adapter handles this as a hard action failure.
    throw new OrchestratorIncompleteError(messageCount);
  }
  return captured;
}

/**
 * Strip undefined-valued entries from an env-shaped object so the
 * resulting record satisfies `Record<string, string>` (which is what
 * downstream MCP server configs declare). `process.env` is typed as
 * `Record<string, string | undefined>` even though in practice every
 * exported key has a string value.
 */
function filterUndefined(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function buildUserPrompt(options: RunOptions): string {
  // The system prompt (ORCHESTRATOR_SYSTEM_PROMPT) carries the workflow
  // contract. The user prompt only supplies the per-run inputs.
  const parts: string[] = [];
  parts.push(`Repository: ${options.repoPath}`);
  if (options.focus) {
    parts.push(`\nFocus:\n${options.focus}`);
  }
  if (options.contextHints && options.contextHints.length > 0) {
    parts.push(`\nContext hints:\n${options.contextHints.map((h) => `- ${h}`).join('\n')}`);
  }
  parts.push(
    '\nProceed per the workflow. Run roast across codebase/architecture/security, parse per-CLI sections, verify every verbatimQuote with Grep, then call submit_findings.',
  );
  return parts.join('\n');
}
