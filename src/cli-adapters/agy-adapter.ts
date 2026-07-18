/**
 * Agy (Google Antigravity) CLI Adapter
 *
 * Encapsulates Antigravity-specific CLI invocation. agy is the gemini-cli
 * successor for the Pro/Ultra/free Google AI tier. See
 * [[reference-agy-affordances-full]] for the full surface map; the key
 * constraints we engineer around here:
 *
 *   - agy --print does NOT accept stdin; prompt goes via argv (~128KB
 *     ARG_MAX cap). Oversized prompts and all codebase critiques use a
 *     secure scratch-file pointer instead.
 *   - agy 1.0.10+ accepts a human-readable model label through --model
 *     (for example "Gemini 3.5 Flash (Medium)"). Without an override,
 *     agy uses its configured/default model.
 *   - No --system flag either. The adversarial prompt is composed into
 *     the user-prompt slot via the promptWrapper-style folding below.
 *   - Agy's internal print deadline is set to the same resolved budget as the
 *     orchestrator (two hours by default). The PTY wrapper forwards outer
 *     cancellation to agy's entire process group.
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
import { existsSync, mkdirSync, writeFileSync, openSync, closeSync, unlinkSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { logger as rootLogger } from '../logger.js';
import type { StructuredLogger } from '../logger.js';
import type { CLIAgentOptions } from '../cli-agents.js';
import type { ModelResolver } from '../model-resolver.js';
import type { CLIProvider, CLIBuilderConfig, CLIName, DecodeResult } from './index.js';
import { DEFAULT_AGENT_TIMEOUT_MS, optionalPositiveInteger, positiveIntegerOr } from '../constants.js';

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
 * Inline Python wrapper for PTY allocation and lifecycle supervision. agy
 * issue #76 (stdout silently dropped when stdout is not a TTY) hits EVERY
 * platform whenever agy's stdout is a pipe — exactly how this adapter captures
 * it, Linux CI included. The child sees the slave TTY; the parent relays the
 * master to captured stdout. `pty.fork()` also makes agy a process-group leader,
 * letting the wrapper forward cancellation and clean up tool subprocesses.
 *
 * Model pinning is NO LONGER done here. agy 1.0.10 added a real `--model`
 * flag (it was a dead string in 1.0.2, which is why this used to swap
 * settings.json under flock — the source of a leftover `.brutalist-lock`
 * leak). The adapter now passes `--model <label>` natively, so the wrapper is
 * PTY/process supervision only: no settings race, no lock file, and a model
 * pin no longer forces an additional wrapper path.
 *
 * Why Python (not node-pty): node-pty is a native module (per-platform
 * prebuilds, spawn-helper chmod gotchas, install-time failures); `pty` is
 * stdlib, preinstalled on macOS and Ubuntu runners, zero install cost.
 */
export const AGY_PYTHON_WRAPPER = `
import os, pty, select, signal, sys, time

agy_bin, agy_args = sys.argv[1], sys.argv[2:]

child_pid, master_fd = pty.fork()
if child_pid == 0:
    os.execvp(agy_bin, [agy_bin] + agy_args)

def signal_child_group(signum):
    try:
        os.killpg(child_pid, signum)
    except ProcessLookupError:
        pass
    except OSError:
        try:
            os.kill(child_pid, signum)
        except OSError:
            pass

def child_group_exists():
    try:
        os.killpg(child_pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False

def wait_for_group_exit(timeout, child_status=None):
    deadline = time.monotonic() + timeout
    while True:
        if child_status is None:
            try:
                waited, status = os.waitpid(child_pid, os.WNOHANG)
            except ChildProcessError:
                child_status = 0
            else:
                if waited == child_pid:
                    child_status = status
        if child_status is not None and not child_group_exists():
            return child_status, True
        if time.monotonic() >= deadline:
            return child_status, False
        time.sleep(0.05)

def terminate_child_group(first_signal=signal.SIGTERM, child_status=None):
    signal_child_group(first_signal)
    status, group_gone = wait_for_group_exit(1.5, child_status)
    if not group_gone:
        signal_child_group(signal.SIGKILL)
        status, _ = wait_for_group_exit(1.5, status)
    return status

def relay_parent_signal(signum, _frame):
    terminate_child_group(signum)
    try:
        os.close(master_fd)
    except OSError:
        pass
    os._exit(128 + signum)

for forwarded in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(forwarded, relay_parent_signal)

child_status = None
group_cleaned = False
while True:
    try:
        readable, _, _ = select.select([master_fd], [], [], 0.1)
    except InterruptedError:
        continue
    if master_fd in readable:
        try:
            data = os.read(master_fd, 4096)
        except OSError:
            break
        if not data:
            break

        view = memoryview(data)
        try:
            while view:
                written = os.write(sys.stdout.fileno(), view)
                view = view[written:]
        except OSError:
            terminate_child_group(child_status=child_status)
            os._exit(1)

    if child_status is None:
        try:
            waited, status = os.waitpid(child_pid, os.WNOHANG)
        except ChildProcessError:
            child_status = 0
        else:
            if waited == child_pid:
                child_status = status

    # Agy may exit while a tool subprocess remains in its process group.
    # Reap/terminate that group now, then keep draining buffered PTY output.
    if child_status is not None and not group_cleaned:
        if child_group_exists():
            child_status = terminate_child_group(child_status=child_status)
        group_cleaned = True

try:
    os.close(master_fd)
except OSError:
    pass
if child_status is None:
    try:
        _, child_status = os.waitpid(child_pid, 0)
    except ChildProcessError:
        child_status = 0
if child_group_exists():
    child_status = terminate_child_group(child_status=child_status)
sys.exit(os.waitstatus_to_exitcode(child_status))
`.trim();

// #76 drops agy's stdout whenever it is a pipe (our subprocess capture) — on
// EVERY platform, Linux CI included. Wrap everywhere python3 is available
// (macOS/Linux/Windows CI+dev all ship it) so the captured stdout is non-empty.
const PTY_WRAP_NEEDED =
  process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32';

// Optional operator ceiling. Unset/invalid means Agy inherits the same global,
// client, or per-call timeout as every other critic; there is no hidden shorter
// Agy default. This remains a ceiling, so it can shorten but never lengthen the
// caller's selected budget.
const AGY_MAX_TIMEOUT_MS = optionalPositiveInteger(process.env.BRUTALIST_AGY_TIMEOUT);

const AGY_CONFIG: CLIBuilderConfig = {
  // Routing is decided per-invocation in buildCommand() based on the platform
  // needing a PTY (#76 on macOS/Windows). This static config slot is just the
  // default for the spawn entrypoint.
  command: AGY_BINARY,
  defaultArgs: ['--print'],
  // agy pins the model via its native --model flag, added in buildCommand()
  // (not this generic modelArgName path), so this slot is unused.
  modelArgName: '',
  maxTimeoutMs: AGY_MAX_TIMEOUT_MS,
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
    // Set when the prompt is routed through a task file in agy's scratch dir:
    // always for codebase critiques, and for any oversized prompt. Caller
    // (`_executeCLI`) unlinks it in its `finally`.
    tempPromptPath?: string;
    model?: string;
  }> {
    const log = options.log ?? rootLogger;

    // Fold the adversarial system prompt into the user prompt slot.
    // agy has no --system / --append-system-prompt equivalent
    // (verified — rejected by the Go flag parser). Strong-position
    // composition: directives first, then a separator, then the user
    // content. The model treats this as the user's instructions.
    //
    // Agy-specific orientation (claude/codex do NOT need this — they stay
    // focused on their own). agy is an agentic loop, not a completion API:
    // pointed at a repo with "Analyze the codebase directory at <path>" it
    //   (a) wanders the filesystem hunting for "where the code is" —
    //       worsened by --sandbox redirecting its cwd sense to the scratch
    //       dir, so it lists scratch/$HOME/config dirs before finding the
    //       target; and
    //   (b) takes "the codebase directory" literally and tries to review
    //       the WHOLE repo, never converging inside the orchestrator's
    //       wall-clock budget on a real codebase.
    // The combination stalled out a 30-min PR-review budget on a 30-line
    // diff. When a unified diff is present (the PR-review path) we prepend
    // an orientation that anchors agy to the absolute target, scopes it to
    // the changed files, and frames the task as a defensive pre-merge
    // review (Gemini Flash otherwise intermittently refuses bare
    // "find the vulnerability" prompts). Empirically: 30-min stall →
    // ~15-50s focused, line-cited review. Gated on hasDiff so abstract
    // roasts (idea/research/etc., where the content is inline and there's
    // no filesystem target) are untouched.
    const target = options.workingDirectory && path.isAbsolute(options.workingDirectory)
      ? options.workingDirectory
      : undefined;
    // constructUserPrompt embeds the diff as "Context: diff --git ..." so
    // the `diff --git` marker is mid-line; match it anywhere. The `@@` hunk
    // header is a second, line-anchored signal. A false negative (missing a
    // diff) is worse than a false positive here, so cast wide.
    const hasDiff = /diff --git /.test(userPrompt) || /(^|\n)@@ .+ @@/.test(userPrompt);
    const orientation = hasDiff
      ? `You are performing a defensive pre-merge code review: your job is to help the author find and fix problems in this change before it is merged. Give your complete critique in one response, then stop. ${target ? `The code under review is in the repository at the absolute path: ${target} — read the relevant files there directly for context. ` : ''}Do not search elsewhere on the system (for example /tmp listings, your home directory, or any sandbox/scratch directory) to locate the code. A unified diff is included in the task below; even though the task may say "analyze the codebase directory", scope your review to the file(s) the diff changes rather than surveying the entire repository.`
      : undefined;

    const taskBlock = orientation ? `${orientation}\n\n${userPrompt}` : userPrompt;
    const combinedPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${taskBlock}`
      : taskBlock;

    // Compatibility + ARG_MAX guard. agy --print takes the prompt on argv
    // (it never reads stdin — see file header), and a SINGLE argv string is
    // hard-capped by the kernel at MAX_ARG_STRLEN (≈128 KB on Linux). Large
    // prompts therefore spill into agy's scratch dir. Agy 1.1.4 also returns
    // empty/no-route generations for the inline codebase_critique template
    // while the same binary reliably completes the scratch-pointer route, so
    // codebase critiques always take that path regardless of prompt size.
    const SAFE_ARGV_BYTES = 96 * 1024;
    const promptBytes = Buffer.byteLength(combinedPrompt, 'utf-8');
    // agy's appData dir, resolved identically to how agy resolves it at
    // runtime: the ANTIGRAVITY_EXECUTABLE_DATA_DIR override if set, else the
    // default. We both write the spill file under here AND forward the
    // override into agy's env (below) so the two never diverge.
    const agyAppDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
      || path.join(homedir(), '.gemini', 'antigravity-cli');
    const requiresTaskFile = options.analysisType === 'codebase';
    let tempPromptPath: string | undefined;
    let pendingPromptPath: string | undefined;
    let effectivePrompt = combinedPrompt;
    if (requiresTaskFile || promptBytes > SAFE_ARGV_BYTES) {
      try {
        // Scratch dir = <appDataDir>/scratch (default ~/.gemini/antigravity-cli).
        // --sandbox grants read+write here, so agy can read the spilled file
        // without --add-dir (whose interaction with --sandbox is unverified).
        // IMPORTANT: the env block below forwards ANTIGRAVITY_EXECUTABLE_DATA_DIR
        // into agy's subprocess so agy resolves <scratch> to THIS same dir.
        // Without that, createSecureEnvironment strips the override and agy would
        // read from the DEFAULT scratch while we wrote to the override path —
        // and the critic would die on oversized prompts.
        const scratchDir = path.join(agyAppDataDir, 'scratch');
        mkdirSync(scratchDir, { recursive: true });
        const candidate = path.join(scratchDir, `brutalist-review-${randomBytes(16).toString('hex')}.md`);
        pendingPromptPath = candidate;
        // Secure create (mirrors mcp-registry.writeClaudeMcpConfigSecure): O_EXCL
        // refuses a pre-existing path and O_NOFOLLOW refuses a symlink, so a
        // planted symlink can't redirect the (possibly secret-bearing) diff.
        const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
        const fd = openSync(
          candidate,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(fd, combinedPrompt, { encoding: 'utf-8' });
        } finally {
          closeSync(fd);
        }
        tempPromptPath = candidate;
        effectivePrompt = `Your complete review brief is stored at this absolute path:\n\n${candidate}\n\nRead that ENTIRE file FIRST using your file-reading tool. Inspect only the repository and files named in that brief, then return one complete, evidence-backed critique and stop. Do not look elsewhere for the task.`;
        log.info(
          requiresTaskFile
            ? 'Agy codebase critique routed through compatibility task file'
            : 'Agy prompt exceeded argv limit; spilled to scratch file',
          { promptBytes },
        );
      } catch (e) {
        if (pendingPromptPath) {
          try { unlinkSync(pendingPromptPath); } catch { /* best-effort */ }
        }
        // The 1.1.4 codebase compatibility path must never silently fall back
        // to the known-wedging inline request shape. Other domains retain the
        // legacy oversized-prompt fallback; E2BIG is isolated per critic.
        tempPromptPath = undefined;
        if (requiresTaskFile) {
          log.error('Agy codebase compatibility task file could not be created', {
            code: (e as NodeJS.ErrnoException)?.code ?? 'unknown',
            promptBytes,
          });
          throw new Error('Agy codebase compatibility task file could not be created');
        }
        effectivePrompt = combinedPrompt;
        log.warn('Agy scratch spill failed; falling back to inline prompt (may exceed argv limit)', {
          code: (e as NodeJS.ErrnoException)?.code ?? 'unknown',
          promptBytes,
        });
      }
    }

    // Never omit this flag: agy 1.1.4 otherwise applies its own hidden 5m
    // default. `_executeCLI` threads its resolved timeout here so the Node
    // wrapper and Agy use one policy. Direct adapter callers resolve the same
    // client/per-call/global/default precedence, with an explicit Agy ceiling
    // applied only when BRUTALIST_AGY_TIMEOUT is set.
    const requestedTimeoutMs = options.effectiveTimeoutMs
      ?? options.activeClient?.timeout
      ?? options.timeout
      ?? positiveIntegerOr(process.env.BRUTALIST_TIMEOUT, DEFAULT_AGENT_TIMEOUT_MS);
    const printTimeoutMs = AGY_MAX_TIMEOUT_MS
      ? Math.min(requestedTimeoutMs, AGY_MAX_TIMEOUT_MS)
      : requestedTimeoutMs;
    const agyArgs = [
      '--print',
      effectivePrompt,
      '--print-timeout', `${printTimeoutMs}ms`,
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

    // Model pinning uses agy's native --model flag (live as of 1.0.10; it was
    // a dead string in 1.0.2, which is why the legacy path swapped
    // settings.json under flock). It resolves per-session with no file race
    // and no leftover lock marker; unknown labels are rejected at runtime
    // ("model %s not found"). Supported labels: "Gemini 3.5 Flash (High|Medium)",
    // "Gemini 3.1 Pro (High|Low)", "Claude Sonnet 4.6 (Thinking)",
    // "Claude Opus 4.6 (Thinking)", "GPT-OSS 120B (Medium)" (per entitlement).
    if (modelPin) {
      agyArgs.push('--model', modelPin);
      log.info('Agy model pin requested (native --model flag)', { model: modelPin });
    }

    // The Python wrapper provides PTY allocation for agy #76 on every current
    // platform, and owns descendant-aware process-group cleanup.
    // With the settings.json swap gone, model pinning adds no extra wrapper.
    const useWrapper = PTY_WRAP_NEEDED;

    const command = useWrapper ? 'python3' : AGY_BINARY;
    const args = useWrapper
      ? ['-c', AGY_PYTHON_WRAPPER, AGY_BINARY, ...agyArgs]
      : agyArgs;

    const env: Record<string, string> = { ...secureEnv };
    // Freeze the agy binary for the run: agy self-updates from a us-central1
    // endpoint at startup, and an uncontrolled 1.0.2 -> 1.0.10 self-update is
    // what originally broke this integration. Disabling the runtime updater
    // keeps the installed (known-good) build in place.
    env.AGY_CLI_DISABLE_AUTO_UPDATE = '1';
    // Forward agy's appDataDir override so the SUBPROCESS resolves <scratch>
    // (and its token/config) to the SAME dir we computed for the spill file.
    // createSecureEnvironment() does NOT allowlist this var, so without this
    // forward agy falls back to the DEFAULT scratch while the adapter wrote to
    // the override path — leaving agy unable to read its own task file (it
    // would die on oversized prompts). Gated on the operator having set it;
    // a no-op in the default deployment.
    if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
      env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    }

    return {
      command,
      args,
      // --print does not consume stdin; prompt is in argv.
      input: '',
      env,
      tempPromptPath,
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
