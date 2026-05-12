/**
 * Action input parsing and validation. Fails fast with actionable
 * errors when required inputs are missing or invalid.
 */

import * as core from '@actions/core';

export type SeverityFilter = 'critical' | 'high' | 'medium' | 'low' | 'nit';

const SEVERITY_RANK: Record<SeverityFilter, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  nit: 0,
};

export interface ActionInputs {
  anthropicOauthToken: string;
  githubToken: string;
  openaiApiKey?: string;
  googleApiKey?: string;
  /** Contents of ~/.codex/auth.json for OAuth-based Codex auth. */
  codexAuth?: string;
  /** Contents of ~/.gemini/oauth_creds.json (paired with geminiGoogleAccounts). */
  geminiOauthCreds?: string;
  /** Contents of ~/.gemini/google_accounts.json (paired with geminiOauthCreds). */
  geminiGoogleAccounts?: string;
  workingDirectory: string;
  minimumSeverity: SeverityFilter;
  /** Soft cap on diff size passed to the orchestrator. */
  maxDiffChars: number;
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

  const maxDiffCharsRaw = core.getInput('max-diff-chars') || '80000';
  const maxDiffChars = parseInt(maxDiffCharsRaw, 10);
  if (!Number.isFinite(maxDiffChars) || maxDiffChars < 1000) {
    throw new Error(
      `Invalid max-diff-chars "${maxDiffCharsRaw}" — must be an integer ≥ 1000.`,
    );
  }

  return {
    anthropicOauthToken,
    githubToken,
    openaiApiKey: core.getInput('openai-api-key') || undefined,
    googleApiKey: core.getInput('google-api-key') || undefined,
    codexAuth: core.getInput('codex-auth') || undefined,
    geminiOauthCreds: core.getInput('gemini-oauth-creds') || undefined,
    geminiGoogleAccounts: core.getInput('gemini-google-accounts') || undefined,
    workingDirectory: core.getInput('working-directory') || '.',
    minimumSeverity: minimumSeverityRaw as SeverityFilter,
    maxDiffChars,
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
