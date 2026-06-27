/**
 * Action input parsing and validation. Fails fast with actionable
 * errors when required inputs are missing or invalid.
 */

import * as core from '@actions/core';
import { sanitizeClientId } from './custom-claude.js';

export type SeverityFilter = 'critical' | 'high' | 'medium' | 'low' | 'nit';

const SEVERITY_RANK: Record<SeverityFilter, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  nit: 0,
};

/** One custom Claude-routed critic parsed from the `custom-claude-clients` JSON array. */
export interface ParsedCustomClient {
  id: string;
  baseUrl: string;
  authToken: string;
  model: string;
  smallFastModel?: string;
  contextWindow?: number;
  containment?: 'hardened' | 'standard';
}

/** Max custom Claude-routed critics — matches the roast clients[] schema cap. */
const MAX_CUSTOM_CLAUDE_CLIENTS = 16;

/** Native CLI provider names a custom client may not claim. */
const NATIVE_CLI_IDS = ['claude', 'codex', 'agy'];

/**
 * A custom client id is reserved/unsafe if (after sanitization) it collides
 * with a native CLI name (attribution corruption) or is a path-traversal
 * basename ('.'/'..') that escapes the per-client `claude-clients/<id>` leaf.
 */
function isReservedClientId(rawId: string): boolean {
  const id = sanitizeClientId(rawId);
  return NATIVE_CLI_IDS.includes(id) || id === '.' || id === '..';
}

/**
 * Throw unless `value` is a valid http(s) URL. The scheme MUST be http or
 * https: this becomes ANTHROPIC_BASE_URL — where the critic's prompt + PR diff
 * + bearer token are sent — so non-network schemes (file:, data:, ftp:, …) are
 * an SSRF/exfil footgun and are rejected. https is strongly recommended (http
 * sends the token in cleartext).
 */
function assertUrl(value: string, label: string): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL (got "${value}").`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error(`${label} must use http(s); "${u.protocol}" is not allowed.`);
  }
}

const CUSTOM_CLIENT_FIELDS = new Set([
  'id', 'baseUrl', 'authToken', 'model', 'smallFastModel', 'contextWindow', 'containment',
]);

/**
 * Parse + validate the `custom-claude-clients` input (a JSON array string).
 * Fails fast with an actionable, entry-indexed error; returns [] for empty.
 * Does NOT dedup or merge the singular inputs — readInputs() does that.
 */
function parseCustomClaudeClients(raw: string): ParsedCustomClient[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `custom-claude-clients must be a JSON array, e.g. '[{"id":"glm","baseUrl":"https://glm.gw","authToken":"<secret>","model":"glm-5.1"}]'. Parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('custom-claude-clients must be a JSON array.');
  }
  const out: ParsedCustomClient[] = [];
  parsed.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`custom-claude-clients[${i}] must be an object.`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!CUSTOM_CLIENT_FIELDS.has(key)) {
        throw new Error(
          `custom-claude-clients[${i}] has unknown field "${key}". Allowed: id, baseUrl, authToken, model, smallFastModel, contextWindow, containment.`,
        );
      }
    }
    const reqStr = (field: string): string => {
      const v = e[field];
      if (typeof v !== 'string' || !v.trim()) {
        throw new Error(`custom-claude-clients[${i}] requires a non-empty string "${field}".`);
      }
      return v.trim();
    };
    const baseUrl = reqStr('baseUrl');
    assertUrl(baseUrl, `custom-claude-clients[${i}] "baseUrl"`);
    const authToken = reqStr('authToken');
    core.setSecret(authToken); // mask before any later per-entry validation can throw
    const client: ParsedCustomClient = {
      id: reqStr('id'),
      baseUrl,
      authToken,
      model: reqStr('model'),
    };
    if (e.smallFastModel !== undefined) {
      if (typeof e.smallFastModel !== 'string' || !e.smallFastModel.trim()) {
        throw new Error(`custom-claude-clients[${i}] "smallFastModel" must be a non-empty string when set.`);
      }
      client.smallFastModel = e.smallFastModel.trim();
    }
    if (e.contextWindow !== undefined) {
      const w = e.contextWindow;
      if (typeof w !== 'number' || !Number.isInteger(w) || w < 10_000 || w > 2_000_000) {
        throw new Error(`custom-claude-clients[${i}] "contextWindow" must be an integer in [10000, 2000000].`);
      }
      client.contextWindow = w;
    }
    if (e.containment !== undefined) {
      if (e.containment !== 'hardened' && e.containment !== 'standard') {
        throw new Error(`custom-claude-clients[${i}] "containment" must be "hardened" or "standard".`);
      }
      client.containment = e.containment;
    }
    out.push(client);
  });
  return out;
}

export interface ActionInputs {
  anthropicOauthToken: string;
  githubToken: string;
  openaiApiKey?: string;
  /** Contents of ~/.codex/auth.json for OAuth-based Codex auth. */
  codexAuth?: string;
  /**
   * Raw JSON contents of the macOS keychain "gemini/antigravity" entry
   * (after stripping the `go-keyring-base64:` prefix and base64-decoding).
   * Capture once locally: `agy "hi"` interactive flow, then
   * `security find-generic-password -s gemini -a antigravity -w
   * | sed 's/^go-keyring-base64://' | base64 -d`. Store the resulting
   * ~500-byte JSON as the AGY_OAUTH_TOKEN secret.
   *
   * The Action writes this to
   * ~/.gemini/antigravity-cli/antigravity-oauth-token (mode 0600) before
   * invoking the orchestrator. agy auto-detects the container environment
   * and reads tokens from that file.
   */
  agyOauthToken?: string;
  workingDirectory: string;
  minimumSeverity: SeverityFilter;
  /** Total safety cap on diff size; the diff is truncated beyond this. */
  maxDiffChars: number;
  /** Model for the orchestrator brain (and the claude critic via settings.json). */
  model: string;
  /** Optional model for the native Claude critic. Defaults to model. */
  claudeCriticModel: string;
  customClaudeBaseUrl?: string;
  customClaudeAuthToken?: string;
  customClaudeModel?: string;
  customClaudeSmallFastModel?: string;
  customClaudeClientId: string;
  /** Context window (tokens) of the custom Claude-routed critic, if smaller than contextWindowTokens. */
  customClaudeContextWindow?: number;
  /** All custom Claude-routed critics — the plural `custom-claude-clients` array merged with the singular shorthand. */
  customClaudeClients: ParsedCustomClient[];
  /** Governing (smallest participant) context window, in tokens. */
  contextWindowTokens: number;
  /** Working headroom reserved for the agent, as a percentage (0–90). */
  contextHeadroomPct: number;
  /**
   * Max chars per diff chunk — derived from contextWindowTokens, the
   * headroom, and a conservative chars-per-token ratio. Each chunk is
   * reviewed by an independent orchestrator run so a diff larger than the
   * context window can still be reviewed in full.
   */
  maxChunkChars: number;
  /** Max concurrent chunk reviews (bounded parallelism). */
  chunkConcurrency: number;
}

/**
 * Conservative chars-per-token estimate used to convert the usable token
 * budget into a character budget for splitting. Deliberately LOW: code
 * diffs run ~3–4 chars/token, so assuming 3 keeps each chunk's real token
 * count at or under budget even for token-dense content.
 */
const CHARS_PER_TOKEN = 3;

function parseIntInput(name: string, fallback: string, min: number, max: number): number {
  const raw = core.getInput(name) || fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid ${name} "${raw}" — must be an integer between ${min} and ${max}.`);
  }
  return n;
}

export function readInputs(): ActionInputs {
  const anthropicOauthToken = core.getInput('anthropic-oauth-token', { required: true });
  if (!anthropicOauthToken.trim()) {
    throw new Error(
      'Missing anthropic-oauth-token input. Run `claude setup-token` locally to generate an OAuth session token, then add it to your repo secrets and pass it via the action input.',
    );
  }

  // GitHub Actions populates GITHUB_TOKEN automatically; the workflow
  // can still override via `github-token:` input if it wants a finer-
  // grained PAT. We can't put `default: ${{ github.token }}` in action.yml
  // because action.yml's parser evaluates `${{ }}` and rejects context
  // refs there — so the fallback is here in code.
  const githubToken = core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
  if (!githubToken.trim()) {
    throw new Error(
      'Missing github-token. Either pass `github-token: ${{ github.token }}` as an action input, or let the runner-provided GITHUB_TOKEN environment variable do it. Ensure your workflow has `permissions: { pull-requests: write }`.',
    );
  }

  const minimumSeverityRaw = (core.getInput('minimum-severity') || 'low').toLowerCase();
  if (!(minimumSeverityRaw in SEVERITY_RANK)) {
    throw new Error(
      `Invalid minimum-severity "${minimumSeverityRaw}". Valid: ${Object.keys(SEVERITY_RANK).join(', ')}.`,
    );
  }

  const maxDiffChars = parseIntInput('max-diff-chars', '2000000', 1000, 50_000_000);

  // Best model by default. Brain uses this directly; the claude critic picks
  // it up from ~/.claude/settings.json (written by the action before invoke).
  const model = (core.getInput('model') || 'claude-opus-4-8').trim();
  const claudeCriticModel = (core.getInput('claude-critic-model') || model).trim();
  const customClaudeBaseUrl = (core.getInput('custom-claude-base-url') || '').trim() || undefined;
  const customClaudeAuthToken = (core.getInput('custom-claude-auth-token') || '').trim() || undefined;
  const customClaudeModel = (core.getInput('custom-claude-model') || '').trim() || undefined;
  const customClaudeSmallFastModel = (core.getInput('custom-claude-small-fast-model') || '').trim() || undefined;
  const customClaudeClientId = (core.getInput('custom-claude-client-id') || 'custom-claude').trim();
  if ((customClaudeBaseUrl || customClaudeAuthToken || customClaudeModel || customClaudeSmallFastModel) &&
      (!customClaudeBaseUrl || !customClaudeAuthToken || !customClaudeModel)) {
    throw new Error(
      'custom Claude routing requires custom-claude-base-url, custom-claude-auth-token, and custom-claude-model.',
    );
  }
  if (customClaudeBaseUrl) assertUrl(customClaudeBaseUrl, 'custom-claude-base-url');

  const customClaudeContextWindow = core.getInput('custom-claude-context-window')
    ? parseIntInput('custom-claude-context-window', '0', 10_000, 2_000_000)
    : undefined;

  // Merge the plural `custom-claude-clients` JSON array with the singular
  // custom-claude-* shorthand (the singular trio, if complete, appends ONE
  // client at the end). Dedup by SANITIZED id (the dir/attribution key), keep-
  // first — so an explicit plural entry wins over the legacy singular on a
  // collision. With no plural input, this is exactly [singular] (or []).
  const pluralClients = parseCustomClaudeClients(core.getInput('custom-claude-clients') || '');
  const singularClients: ParsedCustomClient[] =
    customClaudeBaseUrl && customClaudeAuthToken && customClaudeModel
      ? [{
          id: customClaudeClientId,
          baseUrl: customClaudeBaseUrl,
          authToken: customClaudeAuthToken,
          model: customClaudeModel,
          smallFastModel: customClaudeSmallFastModel,
          contextWindow: customClaudeContextWindow,
        }]
      : [];
  const customClaudeClients: ParsedCustomClient[] = [];
  const seenClientIds = new Set<string>();
  for (const c of [...pluralClients, ...singularClients]) {
    if (isReservedClientId(c.id)) {
      throw new Error(
        `Custom Claude client id "${c.id}" collides with a native CLI name (claude/codex/agy) or is path-unsafe ('.'/'..').`,
      );
    }
    // Mask EVERY parsed token at the earliest point — before dedup — so a
    // token dropped on an id collision (which never reaches provisioning) is
    // still registered with the runner's secret masker.
    core.setSecret(c.authToken);
    const key = sanitizeClientId(c.id);
    if (seenClientIds.has(key)) {
      core.warning(
        `Duplicate custom Claude client id "${c.id}" (sanitizes to "${key}") — keeping the first, dropping this one.`,
      );
      continue;
    }
    seenClientIds.add(key);
    customClaudeClients.push(c);
  }
  if (customClaudeClients.length > MAX_CUSTOM_CLAUDE_CLIENTS) {
    throw new Error(
      `Too many custom Claude clients: ${customClaudeClients.length} (max ${MAX_CUSTOM_CLAUDE_CLIENTS}).`,
    );
  }

  // Context-window-aware chunking. The diff is split so each chunk fits the
  // governing (smallest) participant window minus working headroom, letting
  // every critic — not just the 1M-context ones — review every chunk. Fold
  // EVERY participating custom client's window into the min (only runnable
  // clients are in customClaudeClients, so an unused window can't shrink it).
  const configuredWindow = parseIntInput('context-window-tokens', '200000', 10_000, 2_000_000);
  const participantWindows = [configuredWindow];
  for (const c of customClaudeClients) {
    if (c.contextWindow) participantWindows.push(c.contextWindow);
  }
  // Native critics (claude/codex/agy) ALSO bound each chunk: a chunk larger than
  // a critic's real hard context window overflows it ("Prompt is too long").
  // They have no contextWindow input like the routed clients, so they were
  // invisible to this min — a raised context-window-tokens would silently
  // overflow them. Fold each ACTIVE native critic's conservative hard window in
  // (same rule as the custom clients: only a critic that actually runs constrains
  // the min).
  //   claude: always active (its OAuth token is required). The brain reads every
  //           chunk on `model` and the critic reads it on `claudeCriticModel`, so
  //           1M holds ONLY when BOTH carry the [1m] suffix (opus-4.8 on Max/Team/
  //           Enterprise OAuth); a diverged claude-critic-model without [1m] => 200k.
  //   codex:  gpt-5.x-codex floor ~200k (conservative; some tiers run higher).
  //   agy:    Gemini hard window 1M (its ~135k auto-compaction is a fidelity
  //           limit, not an overflow, so it does not cap the chunk).
  participantWindows.push(/\[1m\]/i.test(model) && /\[1m\]/i.test(claudeCriticModel) ? 1_000_000 : 200_000);
  if (core.getInput('codex-auth') || core.getInput('openai-api-key')) participantWindows.push(200_000);
  if (core.getInput('agy-oauth-token')) participantWindows.push(1_000_000);
  const contextWindowTokens = Math.min(...participantWindows);
  // Default 15: a chunk may fill up to 85% of the governing window. Nominal
  // 15% understates the real free space — CHARS_PER_TOKEN=3 is a deliberate
  // underestimate (real diffs run ~3.5/tok), so a chunk's actual token count
  // lands ~15% under its char-budget, leaving ~25-30% truly free for the
  // critic's prompt + reasoning + output. Bigger chunks => fewer chunks =>
  // fewer concurrency waves. Overshooting trips a per-chunk "Prompt is too
  // long" (caught by runWithConcurrency => degraded coverage, not a hard
  // fail); a repo that hits it can raise context-headroom-pct back up.
  const contextHeadroomPct = parseIntInput('context-headroom-pct', '15', 0, 90);
  // Default 6: large diffs commonly split into a handful of chunks, and at
  // concurrency 2 a 6-chunk review serialized into 3 waves — overrunning tight
  // job timeout-minutes on consumers (bobnetsec/core died at 20 min mid-wave).
  // 6 runs the typical multi-chunk diff in a SINGLE wave so wall-clock is one
  // chunk, not ⌈chunks/2⌉ of them. Bounded at 16. The real ceiling is the
  // shared subscription's concurrent-session rate limit, not the 2-core
  // runner (each chunk is I/O-bound on critic LLM calls, not CPU); a repo that
  // trips 429s can dial this back down via the chunk-concurrency input.
  const chunkConcurrency = parseIntInput('chunk-concurrency', '6', 1, 16);
  const usableTokens = Math.floor(contextWindowTokens * (1 - contextHeadroomPct / 100));
  const maxChunkChars = Math.max(1000, usableTokens * CHARS_PER_TOKEN);

  return {
    // Trim the OAuth token: a trailing newline (common when a secret is
    // captured via `echo`/copy-paste) survives the non-empty check above
    // but makes the SDK's CLAUDE_CODE_OAUTH_TOKEN parser reject it with a
    // cryptic 401. OAuth tokens never contain surrounding whitespace, so
    // trimming is strictly safe and kills that failure vector.
    anthropicOauthToken: anthropicOauthToken.trim(),
    githubToken,
    openaiApiKey: core.getInput('openai-api-key') || undefined,
    codexAuth: core.getInput('codex-auth') || undefined,
    agyOauthToken: core.getInput('agy-oauth-token') || undefined,
    workingDirectory: core.getInput('working-directory') || '.',
    minimumSeverity: minimumSeverityRaw as SeverityFilter,
    maxDiffChars,
    model,
    claudeCriticModel,
    customClaudeBaseUrl,
    customClaudeAuthToken,
    customClaudeModel,
    customClaudeSmallFastModel,
    customClaudeClientId,
    customClaudeContextWindow,
    customClaudeClients,
    contextWindowTokens,
    contextHeadroomPct,
    maxChunkChars,
    chunkConcurrency,
  };
}

/**
 * Returns true when finding's severity is at or above the threshold.
 * Lower-than-threshold findings still get rendered in the review summary,
 * just not as inline comments.
 */
export function meetsSeverityThreshold(severity: SeverityFilter, threshold: SeverityFilter): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}
