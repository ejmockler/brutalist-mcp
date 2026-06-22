/**
 * Routing classification + client-id safety, in a leaf module imported by
 * BOTH cli-agents.ts and the claude adapter. Living here (rather than in
 * cli-agents.ts) breaks the cli-agents → cli-adapters → cli-agents value cycle:
 * the only back-reference is a type-only import of CLIClientSpec, which is
 * erased at runtime.
 */
import type { CLIClientSpec } from '../cli-agents.js';

/** Native CLI provider names. A CUSTOM client may not claim one as its id. */
export const NATIVE_CLI_IDS = ['claude', 'codex', 'agy'] as const;

/**
 * Custom-endpoint routing fields that are only meaningful for the claude
 * provider (the claude binary is the only Anthropic-API gateway client).
 * Used to fail-fast (schema) / warn-and-strip (env) for codex/agy clients.
 */
export const ROUTING_FIELDS = [
  'model',
  'smallFastModel',
  'baseUrl',
  'authToken',
  'authTokenEnv',
  'configDir',
  'env',
  'includeProcessAuth',
  'containment',
] as const;

/**
 * Is a SANITIZED id unsafe for a custom client? Two failure modes:
 *  - it collides with a native CLI name (claude/codex/agy) → attribution
 *    corruption: a routed client and the native critic share one identity in
 *    the clientId??cli keying, so one silently suppresses the other.
 *  - it is a path-traversal basename ('.' / '..') → escapes the per-client
 *    `~/.brutalist/claude-clients/<id>` leaf (`..` → the parent dir, `.` → the
 *    shared dir), breaking the isolated-0700-per-client contract.
 * ('/' is not in the sanitize alphabet — it becomes '-' — so '.' and '..' are
 * the only reachable traversal values.)
 */
export function isReservedCustomClientId(sanitizedId: string): boolean {
  return (NATIVE_CLI_IDS as readonly string[]).includes(sanitizedId)
    || sanitizedId === '.'
    || sanitizedId === '..';
}

/**
 * Routing classification for a Claude-provider client. A client is "routed"
 * — pointed at a custom Anthropic-compatible endpoint such as a GLM gateway
 * — when it carries ANY routing signal: a base URL (typed field or via
 * env.ANTHROPIC_BASE_URL), a bearer token, or an explicit opt-out of
 * process-auth inheritance. Routed clients are isolated-by-default (no
 * native credential inheritance) and hardened-by-default (no web egress /
 * MCP). Everything else is "native". One predicate gates BOTH auth
 * isolation and tool containment so a client can never be isolated-for-auth
 * but not-hardened-for-tools (or vice versa).
 */
export function classifyRouting(c?: CLIClientSpec): 'native' | 'routed' {
  if (!c) return 'native';
  if (
    c.baseUrl ||
    c.authToken ||
    c.authTokenEnv ||
    c.env?.ANTHROPIC_BASE_URL ||
    c.env?.ANTHROPIC_AUTH_TOKEN ||
    c.includeProcessAuth === false
  ) {
    return 'routed';
  }
  return 'native';
}

export function isRoutedClient(c?: CLIClientSpec): boolean {
  return classifyRouting(c) === 'routed';
}
