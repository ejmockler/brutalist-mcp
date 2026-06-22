/**
 * Custom Claude-routed critic provisioning.
 *
 * Extracted from index.ts so it is unit-testable WITHOUT importing
 * @brutalist/orchestrator (whose untransformed ESM jest can't parse, and which
 * would otherwise force a heavy mock + top-level-await test seam). index.ts
 * imports the helpers from here; tests import them with plain static imports.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import * as core from '@actions/core';
import type { ActionInputs } from './inputs.js';

/**
 * Sanitize a custom-claude client id into the constrained alphabet used as a
 * directory name and as the attribution key threaded into knownClientIds AND
 * BRUTALIST_CLAUDE_CLIENTS[].id.
 *
 * ATTRIBUTION CONTRACT — the CORE transform (`id.trim().slice(0, 80)` then
 * `.replace(/[^a-zA-Z0-9._:-]/g, '-')`) MUST stay byte-for-byte identical to
 * `sanitizeClientId` in src/cli-agents.ts (the mcp-server side). The action
 * sanitizes the id here; the mcp-server re-sanitizes the same id and emits it;
 * the orchestrator clamps brain-emitted ids against this known set. If the two
 * transforms drift, an id the action provisions can fail to match the id the
 * mcp-server emits, silently breaking per-client attribution. The ONLY allowed
 * divergence is the empty-result fallback (here: 'custom-claude'; there:
 * 'client'). A characterization test in BOTH packages pins this transform so
 * drift breaks a test.
 */
export function sanitizeClientId(id: string): string {
  const bounded = id.trim().slice(0, 80);
  const sanitized = bounded.replace(/[^a-zA-Z0-9._:-]/g, '-');
  return sanitized || 'custom-claude';
}

export interface CustomClaudeProvisionResult {
  /** The sanitized client ids provisioned (empty when no custom clients configured). */
  knownClientIds: string[];
  /** Per-client auth-token env var names set in process.env (parallel to knownClientIds). */
  tokenEnvNames: string[];
}

/**
 * Per-client auth-token env var name. Index-based (NOT id-based) because a
 * sanitized client id may contain '.'/':'/'-' (legal in CLAUDE_CONFIG_DIR
 * paths + attribution keys per cli-agents.ts) which are ILLEGAL in POSIX env
 * var names ([A-Za-z0-9_] only). The emitted BRUTALIST_CLAUDE_CLIENTS entry
 * references this name via authTokenEnv so the raw token is never inlined into
 * the forwarded config JSON.
 */
export function customClaudeTokenEnvName(index: number): string {
  return `BRUTALIST_CUSTOM_CLAUDE_AUTH_TOKEN_${index}`;
}

/**
 * Provision the custom Claude-routed critics (N): for each, set its auth token
 * in a dedicated index-named env var, mask it (core.setSecret), write a
 * per-client 0700 config dir, and publish them all in BRUTALIST_CLAUDE_CLIENTS
 * (token by reference via authTokenEnv — NEVER inlined). Returns the sanitized
 * knownClientIds (threaded into every per-chunk runOrchestrator; they MUST
 * equal the ids the mcp-server re-sanitizes and emits) and the token env names.
 *
 * Consumes the already-parsed + merged + deduped inputs.customClaudeClients
 * (inputs.ts owns parse/validate/merge); empty => touches no env, empty result.
 */
export async function provisionCustomClaudeClient(
  inputs: ActionInputs,
): Promise<CustomClaudeProvisionResult> {
  const clients = inputs.customClaudeClients ?? [];
  if (clients.length === 0) {
    return { knownClientIds: [], tokenEnvNames: [] };
  }

  const knownClientIds: string[] = [];
  const tokenEnvNames: string[] = [];
  const published: Array<Record<string, unknown>> = [];

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const tokenEnv = customClaudeTokenEnvName(i);
    process.env[tokenEnv] = c.authToken;
    core.setSecret(c.authToken); // mask in any success-path log
    const clientId = sanitizeClientId(c.id);
    const configDir = path.join(os.homedir(), '.brutalist', 'claude-clients', clientId);
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

    const entry: Record<string, unknown> = {
      id: clientId,
      provider: 'claude',
      baseUrl: c.baseUrl,
      authTokenEnv: tokenEnv, // token by reference only — never inlined here
      model: c.model,
      configDir,
      includeProcessAuth: false,
    };
    if (c.smallFastModel) entry.smallFastModel = c.smallFastModel;
    if (c.containment) entry.containment = c.containment;

    knownClientIds.push(clientId);
    tokenEnvNames.push(tokenEnv);
    published.push(entry);
    core.info(`Custom Claude Code critic enabled: ${clientId} (${c.model}).`);
  }

  process.env.BRUTALIST_CLAUDE_CLIENTS = JSON.stringify(published);
  core.info(
    `Custom Claude critics provisioned: ${knownClientIds.length}; governing diff-chunk window ${inputs.contextWindowTokens} tok.`,
  );
  return { knownClientIds, tokenEnvNames };
}
