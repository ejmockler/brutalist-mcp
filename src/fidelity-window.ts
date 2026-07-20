/**
 * Per-critic fidelity windows for the raw `roast` tool's context sizing (N5).
 *
 * The critics are AGENTIC — they read the target repo themselves — so the raw
 * tool's obligation for a large *supplementary* `context` is only to keep each
 * critic from OVERFLOWING its window, not to make every critic see all of it.
 * So we size the context to EACH critic's own window (claude keeps ~1M with the
 * [1m] suffix / ~200k without, codex ≤272k, agy ≤135k) rather than clamping
 * everyone to the smallest — the same per-participant philosophy the GitHub
 * Action's fidelity streams use, applied at the raw layer.
 *
 * NOTE: the window numbers MIRROR packages/github-action/src/inputs.ts
 * (criticFidelityWindow). Keep the two in sync until they are consolidated into
 * a single shared module (deferred: consolidating would re-open the reviewed
 * v1.18.9 action resolver and add an action→root workspace dep + re-bundle).
 */

export const CHARS_PER_TOKEN = 3;
export const CLAUDE_1M_WINDOW_TOKENS = 1_000_000;
export const CONSERVATIVE_FIDELITY_WINDOW_TOKENS = 200_000;
export const AGY_VERBATIM_FIDELITY_TOKENS = 135_000;
export const CODEX_VERBATIM_INPUT_FIDELITY_TOKENS = 272_000;

/** Root default headroom, matching the action's context-headroom-pct default (v1.18.4). */
export const DEFAULT_CONTEXT_HEADROOM_PCT = 15;

const FIDELITY_WINDOW_ENV: Record<'codex' | 'agy', string> = {
  codex: 'BRUTALIST_CODEX_CONTEXT_WINDOW',
  agy: 'BRUTALIST_AGY_CONTEXT_WINDOW',
};

/** Read + validate a BRUTALIST_*_CONTEXT_WINDOW override; ignore anything invalid (best-effort). */
function parseContextWindowOverride(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 10_000 || n > 2_000_000) return undefined;
  return n;
}

/**
 * Verbatim-fidelity window (tokens) for a critic, honoring the
 * BRUTALIST_{CODEX,AGY}_CONTEXT_WINDOW env overrides.
 *   claude: 1M only when the model carries the [1m] enablement suffix, else ~200k.
 *   codex:  ~272k (gpt-5.x-codex 400k cap = 272k input + 128k output).
 *   agy:    ~135k (auto-compaction threshold, NOT Gemini's 1M hard window).
 *   other (routed/custom claude): declaredContextWindow ?? the conservative floor.
 */
export function providerFidelityWindow(
  provider: string,
  model: string | undefined,
  declaredContextWindow?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (provider === 'claude') {
    return /\[1m\]/i.test(model ?? '') ? CLAUDE_1M_WINDOW_TOKENS : CONSERVATIVE_FIDELITY_WINDOW_TOKENS;
  }
  if (provider === 'codex') {
    return parseContextWindowOverride(FIDELITY_WINDOW_ENV.codex, env) ?? CODEX_VERBATIM_INPUT_FIDELITY_TOKENS;
  }
  if (provider === 'agy') {
    return parseContextWindowOverride(FIDELITY_WINDOW_ENV.agy, env) ?? AGY_VERBATIM_FIDELITY_TOKENS;
  }
  return declaredContextWindow ?? CONSERVATIVE_FIDELITY_WINDOW_TOKENS;
}

/** Token window → per-context char budget (working headroom + conservative chars/token). */
export function charsForWindow(
  windowTokens: number,
  headroomPct: number = DEFAULT_CONTEXT_HEADROOM_PCT,
): number {
  const usableTokens = Math.floor(windowTokens * (1 - headroomPct / 100));
  return Math.max(1000, usableTokens * CHARS_PER_TOKEN);
}

export const CONTEXT_TRUNCATION_MARKER =
  "\n\n[brutalist: supplementary context truncated to fit this critic's window — read the target directly for the remainder]";

/**
 * Fit a supplementary context to a char budget: verbatim if it fits, else the
 * head that fits plus a truncation marker. A non-finite budget (Infinity) is an
 * explicit no-op — the caller already chunked upstream (e.g. the Action's
 * per-participant streams, signalled via BRUTALIST_FORCE_CLIS), so re-fitting
 * would double-trim.
 */
export function fitContextToWindow(context: string, budgetChars: number): string {
  if (!context || !Number.isFinite(budgetChars) || context.length <= budgetChars) return context;
  const headLen = Math.max(0, budgetChars - CONTEXT_TRUNCATION_MARKER.length);
  return context.slice(0, headLen) + CONTEXT_TRUNCATION_MARKER;
}
