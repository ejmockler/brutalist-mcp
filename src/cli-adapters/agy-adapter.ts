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
 *     pinned to whatever is in `~/.gemini/antigravity-cli/settings.json`
 *     under the `model` key — and only the HUMAN-READABLE label form
 *     ("Gemini 3.1 Pro (High)", not "gemini-3-pro-preview"). When the
 *     caller passes `options.models.agy`, the Python wrapper swaps that
 *     value into settings.json under flock(2), runs agy, restores the
 *     original. Race-safe across processes that share $HOME. Default
 *     (no override) leaves settings.json untouched and agy uses whatever
 *     model the user picked via the TUI's /model command, falling back
 *     to "Gemini 3.5 Flash (Medium)" if unset.
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
 * Inline Python wrapper. Handles two concerns:
 *
 *   (a) PTY allocation. agy issue #76 (stdout silently dropped when
 *       stdout is not a TTY) hits macOS and Windows but NOT Linux.
 *       The wrapper creates a pty pair, forks, child sees the slave TTY
 *       (bypassing agy's isatty check), parent reads from the master and
 *       writes to its own stdout (which can be a pipe — that part works
 *       regardless of #76).
 *
 *   (b) Per-invocation model pinning via settings.json. agy has no
 *       --model flag at runtime, but `settings.json.model` accepts the
 *       human-readable label form ("Gemini 3.1 Pro (High)", etc.) and
 *       agy's `model_config_manager.go:157` log confirms it propagates
 *       the label to the backend. The wrapper reads BRUTALIST_AGY_MODEL_PIN
 *       from env; if set, it acquires an fcntl.flock(LOCK_EX) on a
 *       sibling lockfile, reads + backs up the existing settings.json,
 *       writes the merged version with the model override, spawns agy,
 *       and restores the original settings.json on exit (in a finally
 *       block so SIGTERM/exception paths still clean up). Race-safe
 *       across processes that share $HOME.
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
 *     install). And on Linux runners (Ubuntu LTS) by default.
 *   - `pty.spawn` and `fcntl.flock` are stdlib. Zero install cost.
 *
 * Supported `BRUTALIST_AGY_MODEL_PIN` label values (per Antigravity
 * docs + binary strings; per-account entitlement gates Pro/Claude):
 *   - "Gemini 3.5 Flash (High|Medium)"   — always available
 *   - "Gemini 3.1 Pro (High|Low)"        — Pro tier
 *   - "Claude Sonnet 4.6 (Thinking)"     — Antigravity Claude tier
 *   - "Claude Opus 4.6 (Thinking)"       — Antigravity Claude tier
 *   - "GPT-OSS 120B (Medium)"            — Antigravity tier
 * Invalid labels are silently downselected by agy to Flash Medium.
 */
const AGY_PYTHON_WRAPPER = `
import pty, sys, os, json, fcntl
agy_bin, agy_args = sys.argv[1], sys.argv[2:]
model = os.environ.get('BRUTALIST_AGY_MODEL_PIN', '').strip()
home = os.path.expanduser('~')
settings = os.path.join(home, '.gemini', 'antigravity-cli', 'settings.json')
lock_path = settings + '.brutalist-lock'
original = None
lock_fd = None
if model:
    os.makedirs(os.path.dirname(settings), exist_ok=True)
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(lock_fd, fcntl.LOCK_EX)
    try:
        with open(settings, 'r') as f:
            original = f.read()
        cfg = json.loads(original) if original.strip() else {}
    except FileNotFoundError:
        cfg = {}
    cfg['model'] = model
    with open(settings, 'w') as f:
        json.dump(cfg, f)
try:
    status = pty.spawn([agy_bin] + agy_args)
finally:
    if model:
        try:
            if original is None:
                try: os.unlink(settings)
                except FileNotFoundError: pass
            else:
                with open(settings, 'w') as f:
                    f.write(original)
        finally:
            if lock_fd is not None:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)
sys.exit(os.waitstatus_to_exitcode(status))
`.trim();

const PTY_WRAP_NEEDED = process.platform === 'darwin' || process.platform === 'win32';

const AGY_CONFIG: CLIBuilderConfig = {
  // Routing is decided per-invocation in buildCommand() based on
  // (a) platform needing PTY and (b) whether a model pin is requested.
  // This static config slot is just the default for the spawn entrypoint.
  command: AGY_BINARY,
  defaultArgs: ['--print'],
  // No --model flag exists; this slot is unused for agy. Kept for
  // CLIBuilderConfig conformance.
  modelArgName: '',
};

// Default model when nothing's pinned. agy reads settings.json at
// startup; if the user previously chose a model via TUI's /model
// command, that value is what runs. Without any settings.json model
// key, the runtime default is Flash Medium.
const AGY_DEFAULT_MODEL = 'Gemini 3.5 Flash (Medium)';

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

    const agyArgs = [
      '--print',
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

    const modelPin = options.models?.agy?.trim();

    // The Python wrapper handles two distinct concerns: PTY allocation
    // for #76 on macOS/Windows, and settings.json swap+restore under
    // flock(2) when a model pin is requested. We invoke it when EITHER
    // is needed. On Linux without a model pin, agy runs directly.
    const useWrapper = PTY_WRAP_NEEDED || !!modelPin;

    const command = useWrapper ? 'python3' : AGY_BINARY;
    const args = useWrapper
      ? ['-c', AGY_PYTHON_WRAPPER, AGY_BINARY, ...agyArgs]
      : agyArgs;

    const env: Record<string, string> = { ...secureEnv };
    if (modelPin) {
      env.BRUTALIST_AGY_MODEL_PIN = modelPin;
      log.info('Agy model pin requested', { model: modelPin });
    }

    return {
      command,
      args,
      // --print does not consume stdin; prompt is in argv.
      input: '',
      env,
      model: modelPin || AGY_DEFAULT_MODEL,
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
