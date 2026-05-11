import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  provisionCredentials,
  detectRefreshRotation,
  fingerprintRefreshToken,
} from '../src/oauth-provisioning.js';

let fakeHome: string;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'brutalist-oauth-test-'));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('provisionCredentials', () => {
  it('writes codex auth to ~/.codex/auth.json with 0600 perms', async () => {
    const codexAuth = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { refresh_token: 'rt-abc', access_token: 'at-xyz' },
    });
    const result = await provisionCredentials({ codexAuth, homeDir: fakeHome });

    expect(result.codexOauth).toBe(true);
    const path = join(fakeHome, '.codex', 'auth.json');
    expect(readFileSync(path, 'utf8')).toBe(codexAuth);
    // Owner read+write only. Linux/macOS will surface group/world bits
    // if our chmod didn't take; assert they're absent.
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes both gemini files when both supplied', async () => {
    const oauthCreds = JSON.stringify({ refresh_token: 'rt-g', expiry_date: 0 });
    const googleAccounts = JSON.stringify({ active: 'user@example.com', old: [] });

    const result = await provisionCredentials({
      geminiOauthCreds: oauthCreds,
      geminiGoogleAccounts: googleAccounts,
      homeDir: fakeHome,
    });

    expect(result.geminiOauth).toBe(true);
    expect(readFileSync(join(fakeHome, '.gemini', 'oauth_creds.json'), 'utf8')).toBe(oauthCreds);
    expect(readFileSync(join(fakeHome, '.gemini', 'google_accounts.json'), 'utf8')).toBe(googleAccounts);
  });

  it('rejects gemini OAuth when only one of the two files is supplied', async () => {
    // Without google_accounts.json the CLI can't bind to an account.
    // Better to refuse than half-provision and let it fail opaquely later.
    const result = await provisionCredentials({
      geminiOauthCreds: JSON.stringify({ refresh_token: 'rt-only' }),
      homeDir: fakeHome,
    });
    expect(result.geminiOauth).toBe(false);
  });

  it('does not write empty or whitespace-only inputs', async () => {
    const result = await provisionCredentials({
      codexAuth: '   \n  ',
      geminiOauthCreds: '',
      homeDir: fakeHome,
    });
    expect(result.codexOauth).toBe(false);
    expect(result.geminiOauth).toBe(false);
    expect(() => readFileSync(join(fakeHome, '.codex', 'auth.json'), 'utf8')).toThrow();
  });

  it('refuses malformed JSON instead of silently writing corrupt creds', async () => {
    const result = await provisionCredentials({
      codexAuth: '{ this is not json',
      homeDir: fakeHome,
    });
    expect(result.codexOauth).toBe(false);
    // No file written.
    expect(() => readFileSync(join(fakeHome, '.codex', 'auth.json'), 'utf8')).toThrow();
  });

  it('captures refresh_token fingerprints for later drift detection', async () => {
    const codexAuth = JSON.stringify({ tokens: { refresh_token: 'rt-codex' } });
    const oauthCreds = JSON.stringify({ refresh_token: 'rt-gemini' });
    const googleAccounts = JSON.stringify({ active: 'a@b.com' });

    const result = await provisionCredentials({
      codexAuth,
      geminiOauthCreds: oauthCreds,
      geminiGoogleAccounts: googleAccounts,
      homeDir: fakeHome,
    });

    expect(result.initialFingerprints.get('CODEX_AUTH')).toBeDefined();
    expect(result.initialFingerprints.get('GEMINI_OAUTH_CREDS')).toBeDefined();
    // google_accounts.json has no refresh_token, so no fingerprint.
    expect(result.initialFingerprints.has('GEMINI_GOOGLE_ACCOUNTS')).toBe(false);
    // Different refresh_tokens → different fingerprints.
    expect(result.initialFingerprints.get('CODEX_AUTH')).not.toBe(
      result.initialFingerprints.get('GEMINI_OAUTH_CREDS'),
    );
  });
});

describe('fingerprintRefreshToken', () => {
  it('returns a stable hex prefix for a given token', () => {
    const json = JSON.stringify({ tokens: { refresh_token: 'rt-static' } });
    const fp1 = fingerprintRefreshToken(json, (j: any) => j?.tokens?.refresh_token);
    const fp2 = fingerprintRefreshToken(json, (j: any) => j?.tokens?.refresh_token);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{12}$/);
  });

  it('returns different fingerprints for different tokens', () => {
    const a = fingerprintRefreshToken(
      JSON.stringify({ refresh_token: 'token-A' }),
      (j: any) => j?.refresh_token,
    );
    const b = fingerprintRefreshToken(
      JSON.stringify({ refresh_token: 'token-B' }),
      (j: any) => j?.refresh_token,
    );
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('returns undefined when the field is missing', () => {
    expect(
      fingerprintRefreshToken('{}', (j: any) => j?.tokens?.refresh_token),
    ).toBeUndefined();
  });

  it('returns undefined on malformed JSON without throwing', () => {
    expect(fingerprintRefreshToken('not json', () => 'x')).toBeUndefined();
  });
});

describe('detectRefreshRotation', () => {
  it('emits no warning when on-disk fingerprint matches captured', async () => {
    // Pre-populate the codex file with a known refresh_token; provision
    // with the same content; then check rotation — should be a no-op.
    const codexJson = JSON.stringify({ tokens: { refresh_token: 'rt-stable' } });
    const { initialFingerprints } = await provisionCredentials({
      codexAuth: codexJson,
      homeDir: fakeHome,
    });

    // The file is untouched, so detectRefreshRotation should find no drift.
    await expect(
      detectRefreshRotation(initialFingerprints, fakeHome),
    ).resolves.toBeUndefined();
  });

  it('handles a missing post-run file gracefully (no throw, no false-positive)', async () => {
    // Capture fingerprints from initial provisioning, then nuke the file.
    const codexJson = JSON.stringify({ tokens: { refresh_token: 'rt-gone' } });
    const { initialFingerprints } = await provisionCredentials({
      codexAuth: codexJson,
      homeDir: fakeHome,
    });
    rmSync(join(fakeHome, '.codex', 'auth.json'));

    await expect(
      detectRefreshRotation(initialFingerprints, fakeHome),
    ).resolves.toBeUndefined();
  });
});
