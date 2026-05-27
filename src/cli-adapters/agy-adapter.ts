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
import { logger as rootLogger } from '../logger.js';
import type { StructuredLogger } from '../logger.js';
import type { CLIAgentOptions } from '../cli-agents.js';
import type { ModelResolver } from '../model-resolver.js';
import type { CLIProvider, CLIBuilderConfig, CLIName, DecodeResult } from './index.js';

const AGY_CONFIG: CLIBuilderConfig = {
  // AGY_BIN env hook resolves the macOS PATH-shadowing gotcha: the
  // Antigravity desktop IDE installs a wrapper at
  // ~/.antigravity/antigravity/bin/agy that shadows the CLI agent at
  // ~/.local/bin/agy on PATH. Users with both can set AGY_BIN to the
  // absolute path of the agent binary. Linux/CI installs only the
  // agent, so the default 'agy' on PATH is correct.
  command: process.env.AGY_BIN || 'agy',
  defaultArgs: ['--print'],
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
