/**
 * OAuth credential provisioning for the Codex and Gemini CLIs.
 *
 * Both CLIs persist their OAuth state as JSON files in $HOME, not as env
 * vars. To run them under OAuth in CI we capture each file once locally
 * (via `codex login` / first `gemini` run), store the contents as
 * GitHub secrets, and write the secrets back to the runner's $HOME on
 * each spinup before invoking the CLIs.
 *
 * Lifecycle caveat (real but bounded): both CLIs rotate access tokens
 * during use and rewrite the file. In ephemeral CI runners those writes
 * vanish with the VM. Each subsequent run starts from the secret's
 * original refresh_token. This works fine as long as the provider
 * treats refresh_tokens as long-lived (typical for installed-app OAuth).
 * If the provider does hard refresh-token rotation, the stored secret
 * goes stale after one CI run and needs regeneration. detectRefreshRotation
 * surfaces this as a warning so operators learn empirically.
 */

import { createHash } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '@actions/core';

export interface ProvisionedCredentials {
  /** True if codex's auth.json was written and parses as JSON. */
  codexOauth: boolean;
  /** True if BOTH gemini files were written (the CLI needs both together). */
  geminiOauth: boolean;
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
  geminiOauthCreds?: string;
  geminiGoogleAccounts?: string;
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

  const geminiCredsWritten = await writeSlot(
    {
      label: 'GEMINI_OAUTH_CREDS',
      contents: opts.geminiOauthCreds,
      relPath: path.join('.gemini', 'oauth_creds.json'),
      refreshTokenAccessor: (j) => (j as any)?.refresh_token,
    },
    home,
    fingerprints,
  );

  const geminiAccountsWritten = await writeSlot(
    {
      label: 'GEMINI_GOOGLE_ACCOUNTS',
      contents: opts.geminiGoogleAccounts,
      relPath: path.join('.gemini', 'google_accounts.json'),
      // No refresh_token in this file — just the account binding.
    },
    home,
    fingerprints,
  );

  // Gemini needs BOTH files. If only one was supplied, the CLI may
  // prompt or fail unpredictably — warn and treat as un-provisioned so
  // the env-var fallback path can take over (if a Google API key was
  // also supplied).
  let geminiOauth = false;
  if (geminiCredsWritten && geminiAccountsWritten) {
    geminiOauth = true;
  } else if (geminiCredsWritten || geminiAccountsWritten) {
    core.warning(
      'Gemini OAuth requires BOTH gemini-oauth-creds AND gemini-google-accounts. ' +
        'Only one was supplied; falling back to GEMINI_API_KEY env if present.',
    );
  }

  return { codexOauth: codexWritten, geminiOauth, initialFingerprints: fingerprints };
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
  const slots: Array<[string, string, (j: unknown) => string | undefined]> = [
    ['CODEX_AUTH', path.join(homeDir, '.codex', 'auth.json'), (j) => (j as any)?.tokens?.refresh_token],
    ['GEMINI_OAUTH_CREDS', path.join(homeDir, '.gemini', 'oauth_creds.json'), (j) => (j as any)?.refresh_token],
  ];

  for (const [label, file, accessor] of slots) {
    const before = initialFingerprints.get(label);
    if (!before) continue;
    try {
      const after = fingerprintRefreshToken(await fs.readFile(file, 'utf8'), accessor);
      if (after && after !== before) {
        core.warning(
          `${label}: refresh_token rotated during this run (${before} → ${after}). ` +
            `The stored secret is now stale. Regenerate locally (codex login / gemini "hi") ` +
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

// Re-export fs constants used by tests for permission assertions.
export const FILE_PERMS_OWNER_RW = fsConstants.S_IRUSR | fsConstants.S_IWUSR;
