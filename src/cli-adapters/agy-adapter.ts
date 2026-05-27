/**
 * Agy (Google Antigravity) CLI Adapter
 *
 * Encapsulates Antigravity-specific CLI invocation. agy is the gemini-cli
 * successor for the Pro/Ultra/free Google AI tier. See
 * [[reference-agy-affordances-full]] for the full surface map; the key
 * constraints we engineer around here:
 *
 *   - agy --print does NOT accept stdin; prompt goes via argv (~128KB
 *     ARG_MAX cap). Brutalist's actual prompts are well under that.
 *   - No --model flag exists at runtime ("--model" is a dead string in
 *     the binary, rejected by the Go flag parser). agy --print is hard-
 *     locked to `Gemini 3.5 Flash (Medium)`. We surface that as the
 *     resolved model for downstream attribution.
 *   - No --system flag either. The adversarial prompt is composed into
 *     the user-prompt slot via the promptWrapper-style folding below.
 *   - --print-timeout is internally broken (e.g. `=3s` runs until
 *     external kill). The orchestrator's spawnAsync timeout is the real
 *     wall-clock enforcement; we still pass --print-timeout 15m as an
 *     internal hint so agy's own polling loop doesn't accidentally
 *     short-circuit.
 *   - --sandbox redirects writes to ~/.gemini/antigravity-cli/scratch/
 *     instead of writing into the caller's cwd, so agy's agentic loop
 *     can call tools (creating implementation_plan.md, etc.) without
 *     polluting the user's repo.
 *   - --dangerously-skip-permissions auto-approves tool permission
 *     prompts — there's no human in --print mode to answer them, so
 *     skipping is the only path forward.
 *
 * Auth (not adapter-side): on macOS the user authenticates once with
 * `agy "hi"` interactively (keychain seeded). In CI runners, the
 * GitHub Action provisions ~/.gemini/antigravity-cli/antigravity-oauth-token
 * from a repo secret before brutalist invokes us. Container detection in
 * agy auto-fires (cgroup-based, see affordance map) and switches to the
 * file-token-storage path on its own — no env var needed on our side.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger as rootLogger } from '../logger.js';
import type { StructuredLogger } from '../logger.js';
import type { CLIAgentOptions } from '../cli-agents.js';
import type { ModelResolver } from '../model-resolver.js';
import type { CLIProvider, CLIBuilderConfig, CLIName, DecodeResult } from './index.js';

/**
 * Resolve which binary to invoke as `agy`. Three-step priority:
 *
 *   1. `AGY_BIN` env var (explicit user override). Wins unconditionally.
 *   2. `~/.local/bin/agy` (canonical CLI-agent install path per
 *      `curl ... antigravity.google/cli/install.sh | bash`). Preferred
 *      because on macOS the Antigravity desktop IDE installs a wrapper
 *      at `~/.antigravity/antigravity/bin/agy` that is a SYMLINK into
 *      the .app bundle (an Electron/VS Code fork — NOT the Go CLI
 *      agent). That wrapper resolves first on PATH for many users
 *      because the IDE's installer prepends its bin dir. Bypassing
 *      PATH for the canonical location avoids invoking the IDE binary
 *      with the agent CLI's flags (`--print`, etc.) — which the IDE
 *      politely passes through to Electron with warnings rather than
 *      running as the agent.
 *   3. Bare `'agy'` (PATH lookup). Last-resort for non-standard
 *      installs.
 *
 * Resolved at module load — the user's environment shouldn't change
 * mid-process, and the MCP server is restarted when paths change.
 */
function resolveAgyBin(): string {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  const homeLocal = path.join(homedir(), '.local', 'bin', 'agy');
  if (existsSync(homeLocal)) return homeLocal;
  return 'agy';
}

export const AGY_BINARY = resolveAgyBin();

/**
 * Inline Python pty wrapper. agy issue #76 (stdout silently dropped
 * when stdout is not a TTY) hits macOS and Windows but NOT Linux.
 * Validated empirically: on darwin a plain `child_process.spawn` of
 * `agy --print "..."` returns 0 bytes and hangs until SIGTERM; the
 * same call inside a PTY returns the response cleanly.
 *
 * Why Python and not node-pty:
 *   - node-pty is a native module: prebuilt binaries per platform,
 *     `spawn-helper` chmod gotchas during npm install, install-time
 *     failure modes on unusual setups (Apple Silicon Node 24 had
 *     intermittent issues this session). Adds 140KB of native code
 *     to the dep tree.
 *   - Python 3 is preinstalled on macOS (12+ ships /usr/bin/python3
 *     stub that triggers Xcode CLT install on first run; users
 *     running agy locally already have CLT for `agy` itself to
 *     install).
 *   - `pty.spawn` is stdlib (Lib/pty.py). Zero install cost.
 *
 * The wrapper creates a pty pair, forks, child sees the slave TTY
 * (bypassing agy's isatty check), parent reads from the master and
 * writes to its own stdout (which can be a pipe — that part works
 * regardless of #76).
 */
const PTY_WRAPPER_PY = `
import pty, sys, os
status = pty.spawn(sys.argv[1:])
sys.exit(os.waitstatus_to_exitcode(status))
`.trim();

const PTY_WRAP_NEEDED = process.platform === 'darwin' || process.platform === 'win32';

const AGY_CONFIG: CLIBuilderConfig = {
  // On macOS/Windows we route through python3 -c <wrapper> <agy> ...
  // so agy's stdout doesn't silently drop on non-TTY parent. Linux runs
  // agy directly. The command field surfaces the entrypoint binary
  // (the wrapper on macOS, agy on Linux); buildCommand() constructs
  // the full argv below to match.
  command: PTY_WRAP_NEEDED ? 'python3' : AGY_BINARY,
  defaultArgs: PTY_WRAP_NEEDED ? ['-c', PTY_WRAPPER_PY, AGY_BINARY, '--print'] : ['--print'],
  // No --model flag exists; this slot is unused for agy. Kept for
  // CLIBuilderConfig conformance.
  modelArgName: '',
};

// agy hard-pins to this model in --print mode. We surface it for
// downstream attribution (per-CLI section headers) but the value is not
// caller-controllable. When/if Google ships #35 (--model flag), this
// becomes negotiable.
const AGY_FIXED_MODEL = 'Gemini 3.5 Flash (Medium)';

// Refusal signals. agy bakes auth and quota outcomes into stdout (not
// stderr), exit code 0, with anchored prefixes we can match without
// pulling in prose-as-signal antipatterns. See affordance map § Output
// channels and § Known broken / quirky for the empirical confirmation.
//
//   "Authentication required. Please visit the URL to log in: <url>"
//   "⚠ Individual quota reached. Contact your administrator to enable
//    overages. Resets in <Nh><Nm><Ns>."
const AUTH_REFUSAL_RE = /^Authentication required\./m;
const QUOTA_REFUSAL_RE = /^\s*⚠\s*Individual quota reached/m;

export class AgyAdapter implements CLIProvider {
  readonly name: CLIName = 'agy';

  getConfig(): CLIBuilderConfig {
    return AGY_CONFIG;
  }

  async buildCommand(
    userPrompt: string,
    systemPrompt: string,
    options: CLIAgentOptions,
    _modelResolver: ModelResolver,
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
    const config = AGY_CONFIG;

    // Fold the adversarial system prompt into the user prompt slot.
    // agy has no --system / --append-system-prompt equivalent
    // (verified — rejected by the Go flag parser). Strong-position
    // composition: directives first, then a separator, then the user
    // content. The model treats this as the user's instructions.
    const combinedPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${userPrompt}`
      : userPrompt;

    // Soft-warn at 100KB; hard ARG_MAX is ~128KB on Linux. Brutalist's
    // own prompts (system + code excerpt) typically run 5-30KB.
    if (combinedPrompt.length > 100_000) {
      log.warn('Agy prompt approaching argv ARG_MAX', {
        promptBytes: combinedPrompt.length,
      });
    }

    const args = [
      ...config.defaultArgs,
      combinedPrompt,
      // Internal polling hint; orchestrator's spawnAsync timeout
      // (CLIAgentOptions.timeout) is what actually bounds wall-clock.
      // 15m is comfortably above brutalist's per-CLI default but well
      // below pathological-stall protection.
      '--print-timeout', '15m',
      // Containment: writes go to ~/.gemini/antigravity-cli/scratch/
      // instead of cwd. Reads from cwd still work, so agy can inspect
      // the user's codebase for the critique.
      '--sandbox',
      // No-prompts-allowed mode: auto-approve any permission requests
      // since --print has no human to answer them. Required for
      // autonomous critic execution.
      '--dangerously-skip-permissions',
    ];

    return {
      command: config.command,
      args,
      // --print does not consume stdin; prompt is in argv.
      input: '',
      env: { ...secureEnv },
      model: AGY_FIXED_MODEL,
    };
  }

  /**
   * Decode raw agy stdout into a structured outcome.
   *
   * agy stdout in --print mode is clean text/Markdown with 0 ANSI
   * escape bytes (verified empirically). Refusals are baked into the
   * stdout stream with anchored prefixes — we match those without
   * grepping the full text for loose patterns (which would re-introduce
   * the prose-as-signal antipattern that commit 086a38f explicitly
   * removed for claude/codex).
   */
  decode(
    stdout: string,
    _stderr: string,
    _args: string[],
    log?: StructuredLogger,
  ): DecodeResult {
    const decodeLog = log ?? rootLogger;

    if (!stdout || !stdout.trim()) {
      decodeLog.debug('agy: empty stdout');
      return { kind: 'error', reason: 'empty' };
    }

    if (AUTH_REFUSAL_RE.test(stdout)) {
      decodeLog.warn('agy: auth refusal detected in stdout');
      return { kind: 'refused', reason: 'auth' };
    }

    if (QUOTA_REFUSAL_RE.test(stdout)) {
      decodeLog.warn('agy: quota refusal detected in stdout');
      return { kind: 'refused', reason: 'quota' };
    }

    return { kind: 'ok', text: stdout };
  }

  decodeOutput(
    rawOutput: string,
    args: string[],
    log?: StructuredLogger,
  ): string {
    const result = this.decode(rawOutput, '', args, log);
    return result.kind === 'ok' ? result.text : '';
  }
}
