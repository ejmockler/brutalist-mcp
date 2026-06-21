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
import { open, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { randomBytes } from 'node:crypto';
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
        `Most likely a child CLI subprocess (claude/codex/agy) stalled. ` +
        `Raise timeoutMs, split the diff, or investigate the stalled critic.`,
    );
    this.name = 'OrchestratorTimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Hard cap on agent turns — the seatbelt against a confused brain looping
// until the wall-clock timeout. Sized for the worst-case happy path, which is
// dominated by pagination: a 3-critic roast (claude+codex+agy) routinely
// exceeds brutalist's ~25k-token page size, so each of up to 3 roasts can span
// several SAME-domain/target re-calls (one turn each) before it's fully read.
// Budget: optional brutalist_discover (1) + 3 roast issues (3) + pagination
// follow-ups (~3 pages × 3 roasts ≈ 9) + grep-based quote verification (~several)
// + terminal submit_findings (1) already crowds 20, leaving zero headroom for a
// re-read or retry. 50 restores generous slack while staying a non-trivial
// finite cap; the wall-clock budget (timeoutMs) remains the real seatbelt.
const DEFAULT_MAX_TURNS = 50;

/**
 * Upper bound on how large a diff we will still pass INLINE in the
 * `BRUTALIST_PR_DIFF` env var (back-compat with an older brutalist-mcp that
 * only reads the inline form). A single env-var string — like a single argv
 * string — is hard-capped by the OS at MAX_ARG_STRLEN (≈128 KB on Linux);
 * spawning the brutalist-mcp subprocess with a diff larger than that inline
 * throws `spawn E2BIG` and kills the whole review before any critic runs
 * (this is the bobnetsec/core PR #12 failure). Above this threshold the diff
 * travels ONLY via the temp file (`BRUTALIST_PR_DIFF_FILE`). 96 KB leaves
 * comfortable headroom under the 128 KB ceiling.
 */
const SAFE_ENV_DIFF_BYTES = 96 * 1024;

/** True when `focus` is a unified diff (PR-review path). */
function focusIsUnifiedDiff(focus: string | undefined): focus is string {
  return !!focus && (/diff --git /.test(focus) || /(^|\n)@@ .+ @@/.test(focus));
}

export async function run(options: RunOptions): Promise<OrchestratorResult> {
  // Closure-scoped capture for the structured output. The submit_findings
  // tool's handler writes here; run() reads after query() drains.
  let captured: OrchestratorResult | undefined;
  let submitCount = 0;

  // Path to the temp file holding the PR diff, when one is written (see
  // SAFE_ENV_DIFF_BYTES). Cleaned up in the query finally regardless of
  // outcome. Declared here so it is in scope for that cleanup.
  let diffFilePath: string | undefined;

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
  // PATH (to locate `claude`/`codex`/`agy`/`node`), HOME (for CLI
  // config dirs including `~/.gemini/antigravity-cli/` for agy's file
  // token storage), and the rest of the toolchain. We then layer
  // brutalist-specific keys on top — this is the only correct
  // composition; partial env objects are not "additive" with most
  // child_process.spawn implementations, they're complete replacements.
  const inheritedEnv = filterUndefined(process.env);

  // Hand the PR diff to the brutalist-mcp subprocess via a temp FILE rather
  // than inline in the spawn env. `max-diff-chars` defaults to 2,000,000, and
  // a diff that large in an env var trips the OS per-string limit
  // (MAX_ARG_STRLEN ≈ 128 KB on Linux applies to env, not just argv), so the
  // SDK's `spawn('brutalist-mcp', …, { env })` throws `spawn E2BIG` at init —
  // killing the entire review before a single critic runs. Writing the diff
  // to disk and passing only the (tiny) path keeps the spawn env small for
  // any diff size. Failure to write the file is non-fatal: we fall through to
  // the inline path, which the brain can still relay via the roast `context`.
  const diffFocus = focusIsUnifiedDiff(options.focus) ? options.focus : undefined;
  if (diffFocus) {
    try {
      const candidate = joinPath(tmpdir(), `brutalist-pr-diff-${randomBytes(16).toString('hex')}.diff`);
      // Secure create (mirrors brutalist-mcp's writeClaudeMcpConfigSecure):
      // O_EXCL refuses a pre-existing path and O_NOFOLLOW refuses a symlink, so
      // a planted symlink in the shared tmpdir can't redirect the (possibly
      // secret-bearing) diff. 0600 keeps it owner-only.
      const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
      const handle = await open(
        candidate,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(diffFocus, { encoding: 'utf-8' });
      } catch (e) {
        await unlink(candidate).catch(() => { /* best-effort */ });
        throw e;
      } finally {
        await handle.close().catch(() => { /* best-effort */ });
      }
      diffFilePath = candidate;
    } catch {
      diffFilePath = undefined;
    }
  }

  const brutalistConfig: McpServerConfig = {
    type: 'stdio',
    command: options.brutalistMcpCommand ?? 'brutalist-mcp',
    args: [],
    // Force the brutalist tools (roast, etc.) into the turn-1 prompt instead
    // of deferring them behind tool-search (the SDK default when tool search
    // is enabled). Without this the brain has to *discover* `roast` via a
    // tool-search step before it can call it; when it doesn't (observed under
    // rate-limit throttling / a degraded first turn), it never sees `roast`,
    // concludes "the multi-CLI roast was not available", and falls back to a
    // solo Read/Grep review — silently dropping the entire critic panel. roast
    // is THE primary tool; it must always be present. brutalist-mcp connects
    // fast (transport-connect only at boot; CLI detection is lazy), so the 5s
    // connect window alwaysLoad imposes is not a concern.
    alwaysLoad: true,
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
      // Deterministic diff scoping: hand brutalist-mcp the PR diff directly
      // rather than relying on the brain to relay it verbatim in the roast
      // `context` arg. constructUserPrompt folds this in so every critic —
      // especially agy, whose agentic loop otherwise audits the whole repo
      // and hits the per-critic timeout — scopes to the changed files.
      //
      // Primary channel is the temp FILE (path is tiny → never E2BIGs the
      // spawn). The inline env var is ALSO set for back-compat with an older
      // brutalist-mcp that predates BRUTALIST_PR_DIFF_FILE — but ONLY when the
      // diff is small enough to be safe inline. Large diffs travel via the
      // file alone; never inline (that is the crash this fix removes).
      ...(diffFilePath ? { BRUTALIST_PR_DIFF_FILE: diffFilePath } : {}),
      ...(diffFocus && Buffer.byteLength(diffFocus, 'utf-8') <= SAFE_ENV_DIFF_BYTES
        ? { BRUTALIST_PR_DIFF: diffFocus }
        : {}),
    },
  };

  // Wall-clock budget: cancel the SDK iterator if a child CLI stalls
  // past the timeout. Without this, the maxTurns cap still allows a single
  // wedged subprocess to hold the loop for the GH Actions job timeout
  // (6h default) — a turn never completes, so the turn counter never advances.
  // The AbortController propagates through the SDK's child-process tree.
  // Wall-clock budget. Precedence: explicit option > BRUTALIST_ORCHESTRATOR_TIMEOUT_MS
  // env (lets CI lower it for cheap iteration without a code change) > 30-min default.
  const envTimeout = Number(process.env.BRUTALIST_ORCHESTRATOR_TIMEOUT_MS);
  const timeoutMs = options.timeoutMs
    ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
  // Mark the handle for garbage collection on early-exit paths.
  if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

  // Turn cap. Precedence mirrors timeoutMs: explicit option >
  // BRUTALIST_ORCHESTRATOR_MAX_TURNS env (lets CI/operators tune without a code
  // change) > DEFAULT_MAX_TURNS.
  const envMaxTurns = Number(process.env.BRUTALIST_ORCHESTRATOR_MAX_TURNS);
  const maxTurns = options.maxTurns
    ?? (Number.isFinite(envMaxTurns) && envMaxTurns > 0 ? envMaxTurns : DEFAULT_MAX_TURNS);

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
    // Hard cap on agent turns — the seatbelt against a confused agent looping
    // until the GitHub Actions job timeout (6h default) before failing. The
    // system prompt's "at most 3 roast calls" remains the primary budget; this
    // is the backstop. See DEFAULT_MAX_TURNS for the sizing rationale and the
    // BRUTALIST_ORCHESTRATOR_MAX_TURNS env override.
    maxTurns,
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
  // Per-message trace (stderr → CI log), gated by BRUTALIST_ORCHESTRATOR_TRACE=1.
  // One concise line per SDK message — elapsed time, type, tool names, errors —
  // so a stalled brain is diagnosable: which roast call was issued, how long each
  // took (gap between the tool_use and its tool_result), and where the dead time
  // is. The brain is a separate `claude` process NOT bounded by the per-critic
  // BRUTALIST_TIMEOUT, so this is the only window into why it stalls.
  const traceOn = process.env.BRUTALIST_ORCHESTRATOR_TRACE === '1';
  const traceT0 = Date.now();
  let messageCount = 0;
  try {
    for await (const message of query({ prompt: userPrompt, options: queryOptions })) {
      messageCount++;
      if (traceOn) {
        const elapsed = ((Date.now() - traceT0) / 1000).toFixed(1);
        let detail = '';
        try {
          const anyMsg = message as any;
          if (message.type === 'assistant') {
            const blocks = anyMsg.message?.content ?? [];
            const tools = blocks
              .filter((b: any) => b?.type === 'tool_use')
              .map((b: any) => b.name);
            detail = tools.length
              ? ` tool_use=[${tools.join(', ')}]`
              : (blocks.some((b: any) => b?.type === 'text') ? ' text' : '');
            if (anyMsg.error) detail += ` ERROR=${anyMsg.error}`;
          } else if (message.type === 'user') {
            const n = (anyMsg.message?.content ?? []).filter(
              (b: any) => b?.type === 'tool_result',
            ).length;
            if (n) detail = ` tool_result x${n}`;
          } else if (message.type === 'result') {
            detail = ` subtype=${anyMsg.subtype} duration=${anyMsg.duration_ms}ms turns=${anyMsg.num_turns}`;
          } else if (message.type === 'rate_limit_event') {
            // status is the signal: 'allowed' = informational (NOT throttled);
            // 'rejected' = actually rate-limited. Log it so we stop guessing.
            const rl = anyMsg.rate_limit_info ?? {};
            detail = ` status=${rl.status} util=${rl.utilization} type=${rl.rateLimitType ?? '-'} resetsAt=${rl.resetsAt ?? '-'}`;
          }
        } catch {
          /* trace must never throw */
        }
        // eslint-disable-next-line no-console
        console.error(`[orch +${elapsed}s] #${messageCount} ${message.type}${detail}`);
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new OrchestratorTimeoutError(timeoutMs, messageCount);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    // Best-effort cleanup of the PR-diff temp file. The OS would reap it
    // from tmpdir eventually, but we unlink eagerly so a long-lived runner
    // doesn't accumulate multi-MB diffs (and so the diff content — which can
    // carry secrets — lingers no longer than the run).
    if (diffFilePath) {
      await unlink(diffFilePath).catch(() => { /* best-effort temp cleanup */ });
    }
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
    '\nProceed per the workflow. Run a SINGLE `codebase` roast (it already covers' +
      ' security, performance, and architecture), passing the Focus diff above' +
      ' VERBATIM (keep the `diff --git` and `@@` lines) as the roast `context` —' +
      ' the critics use those markers to scope their review to the changed files.' +
      ' Then parse per-CLI sections, verify every verbatimQuote with Grep, and call submit_findings.',
  );
  return parts.join('\n');
}
