/**
 * OAuth credential provisioning for the Codex and Antigravity (`agy`) CLIs.
 *
 * Both persist OAuth state as a JSON file in $HOME (agy under
 * `~/.gemini/antigravity-cli/`, Codex under `~/.codex/`), not as env
 * vars. To run them under OAuth in CI we capture the file once locally
 * (via `codex login` / one-time `agy "hi"`), store the contents as a
 * GitHub secret, and write the secret back to the runner's $HOME on
 * each spinup before invoking the CLI.
 *
 * Lifecycle caveat (real but bounded): both CLIs rotate access_tokens
 * during use and rewrite the file. In ephemeral CI runners those writes
 * vanish with the VM. Each subsequent run starts from the secret's
 * original refresh_token. This works fine as long as the provider
 * treats refresh_tokens as long-lived (typical for installed-app OAuth;
 * Google's policy: indefinite under normal use, expires only on user
 * revocation, 6 months idle, >100 live tokens per client, or Testing-
 * stage consent screen 7-day cap).
 *
 * If the provider does hard refresh-token rotation, the stored secret
 * goes stale after one CI run and needs regeneration. detectRefreshRotation
 * surfaces this as a warning so operators learn empirically.
 *
 * Token shape differs per CLI:
 *   - Codex:  { tokens: { access_token, refresh_token, id_token, account_id } }
 *   - Agy:    { token:  { access_token, refresh_token, expiry, token_type }, auth_method: "consumer" }
 */

import { createHash } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '@actions/core';

export interface ProvisionedCredentials {
  /** True if codex's auth.json was written and parses as JSON. */
  codexOauth: boolean;
  /** True if agy's antigravity-oauth-token was written and parses as JSON. */
  agyOauth: boolean;
  /**
   * Map of secret label → SHA-256 prefix of the refresh_token at write
   * time. Used by detectRefreshRotation to spot mid-run rotation.
   * Empty for slots that weren't provisioned this run.
   */
  initialFingerprints: Map<string, string>;
}

interface CredentialSlot {
  /** GitHub-secret-style label, used in logs + fingerprint keys. */
  label: string;
  /** Contents to write (the action input). */
  contents: string | undefined;
  /** Destination on disk, in $HOME. Relative path under $HOME. */
  relPath: string;
  /**
   * Optional accessor to extract the refresh_token from the parsed JSON
   * so we can fingerprint it. Omit for credential files that don't
   * carry one (e.g. google_accounts.json).
   */
  refreshTokenAccessor?: (json: unknown) => string | undefined;
}

/**
 * Write each non-empty credential blob to its $HOME path with 0600
 * permissions. Returns which providers got provisioned and the initial
 * fingerprints for later drift detection.
 */
export async function provisionCredentials(opts: {
  codexAuth?: string;
  agyOauthToken?: string;
  homeDir?: string;
}): Promise<ProvisionedCredentials> {
  const home = opts.homeDir ?? os.homedir();
  const fingerprints = new Map<string, string>();

  const codexWritten = await writeSlot(
    {
      label: 'CODEX_AUTH',
      contents: opts.codexAuth,
      relPath: path.join('.codex', 'auth.json'),
      refreshTokenAccessor: (j) => (j as any)?.tokens?.refresh_token,
    },
    home,
    fingerprints,
  );

  // Agy: the keychain blob format on macOS is `go-keyring-base64:<b64>`;
  // the file-backend on Linux expects the raw decoded JSON. Callers
  // must strip and decode before passing — see the agy-oauth-token
  // capture command in action.yml.
  const agyWritten = await writeSlot(
    {
      label: 'AGY_OAUTH_TOKEN',
      contents: opts.agyOauthToken,
      relPath: path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      refreshTokenAccessor: (j) => (j as any)?.token?.refresh_token,
    },
    home,
    fingerprints,
  );

  return {
    codexOauth: codexWritten,
    agyOauth: agyWritten,
    initialFingerprints: fingerprints,
  };
}

/**
 * After the orchestrator run, compare the on-disk refresh_token against
 * the fingerprint we captured at write time. A drift means the provider
 * rotated mid-run; the new refresh_token is on the runner's disk (which
 * is about to be destroyed) and the GitHub secret is now stale. The
 * operator needs to re-capture and re-store before the OLD refresh_token
 * expires.
 *
 * This is a warning, not a hard failure — the current run succeeded.
 * Future runs may start failing if the provider hard-rotates.
 */
export async function detectRefreshRotation(
  initialFingerprints: Map<string, string>,
  homeDir: string = os.homedir(),
): Promise<void> {
  const slots: Array<[string, string, (j: unknown) => string | undefined, string]> = [
    [
      'CODEX_AUTH',
      path.join(homeDir, '.codex', 'auth.json'),
      (j) => (j as any)?.tokens?.refresh_token,
      'codex login',
    ],
    [
      'AGY_OAUTH_TOKEN',
      path.join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      (j) => (j as any)?.token?.refresh_token,
      'agy "hi" (interactive) and re-capture the macOS keychain entry',
    ],
  ];

  for (const [label, file, accessor, regenerate] of slots) {
    const before = initialFingerprints.get(label);
    if (!before) continue;
    try {
      const after = fingerprintRefreshToken(await fs.readFile(file, 'utf8'), accessor);
      if (after && after !== before) {
        core.warning(
          `${label}: refresh_token rotated during this run (${before} → ${after}). ` +
            `The stored secret is now stale. Regenerate locally (${regenerate}) ` +
            `and update the GitHub secret before the prior refresh_token expires.`,
        );
      }
    } catch {
      // File missing / unparseable post-run: the CLI may have removed
      // it, or the run didn't get far enough to use it. Skip silently
      // rather than false-warning.
    }
  }
}

async function writeSlot(
  slot: CredentialSlot,
  home: string,
  fingerprintsOut: Map<string, string>,
): Promise<boolean> {
  if (!slot.contents || !slot.contents.trim()) return false;

  // Validate JSON before writing — corrupt secrets shouldn't silently
  // land on disk and trip the CLI with an opaque parse error later.
  let parsed: unknown;
  try {
    parsed = JSON.parse(slot.contents);
  } catch (err) {
    core.warning(
      `${slot.label}: input is not valid JSON; skipping write. ` +
        `Re-run the local capture command and copy the file verbatim. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }

  const destPath = path.join(home, slot.relPath);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, slot.contents, { mode: 0o600 });
  // Belt + suspenders: chmod explicitly in case the umask collapsed
  // the create-time mode (some umasks strip group/world bits but not
  // explicit owner bits we want).
  await fs.chmod(destPath, 0o600).catch(() => undefined);
  core.info(`Wrote OAuth credential: ${slot.label} → ${destPath}`);

  if (slot.refreshTokenAccessor) {
    const fp = fingerprintRefreshToken(slot.contents, slot.refreshTokenAccessor);
    if (fp) fingerprintsOut.set(slot.label, fp);
  }
  return true;
}

/**
 * Return a 12-char SHA-256 prefix of the refresh_token field, or
 * undefined if the field is absent. The prefix is enough to detect
 * rotation without exposing the token to logs (full hash would be
 * cryptographically reversible only against the actual token, so even
 * the full hash is safe — but we use 12 chars to keep log noise low).
 */
export function fingerprintRefreshToken(
  jsonContents: string,
  accessor: (json: unknown) => string | undefined,
): string | undefined {
  try {
    const parsed = JSON.parse(jsonContents);
    const token = accessor(parsed);
    if (!token || typeof token !== 'string') return undefined;
    return createHash('sha256').update(token).digest('hex').slice(0, 12);
  } catch {
    return undefined;
  }
}

/**
 * Extract individual token strings from an OAuth credential JSON blob
 * so the global redactor can mask them if a CLI subprocess accidentally
 * echoes one in an error message.
 *
 * Without this, `redactSecrets` only sees the WHOLE JSON blob as a
 * single secret — partial echoes (e.g. a CLI logging
 * `Bearer abc...xyz` from a debug path) wouldn't be substring-matched
 * and would leak into the action log. Extracting and registering each
 * sensitive field individually closes that gap.
 *
 * Conservative on inclusion: only string values from known token field
 * names are returned, and only when ≥16 chars (real OAuth tokens are
 * always much longer; the floor avoids masking trivial substrings like
 * a 4-char `account_id` numeric or any non-token string that happens to
 * sit in a field with a similar name).
 *
 * Tolerates malformed JSON silently — provisionCredentials already
 * validates upstream, so the only way malformed input reaches this
 * function is during the .catch handler when readInputs itself threw.
 */
export function extractOauthSecrets(jsonContents: string | undefined): string[] {
  if (!jsonContents || !jsonContents.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonContents);
  } catch {
    return [];
  }
  const out: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === 'string' && v.length >= 16) out.push(v);
  };
  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') return out;

  // Codex shape: { tokens: { access_token, refresh_token, id_token, account_id } }
  const tokens = (obj as { tokens?: Record<string, unknown> }).tokens;
  if (tokens && typeof tokens === 'object') {
    collect(tokens.access_token);
    collect(tokens.refresh_token);
    collect(tokens.id_token);
  }
  // Agy shape: { token: { access_token, refresh_token, expiry, token_type }, auth_method }
  const token = (obj as { token?: Record<string, unknown> }).token;
  if (token && typeof token === 'object') {
    collect(token.access_token);
    collect(token.refresh_token);
    collect(token.id_token);
  }
  return out;
}

// Re-export fs constants used by tests for permission assertions.
export const FILE_PERMS_OWNER_RW = fsConstants.S_IRUSR | fsConstants.S_IWUSR;
