// CLI execution limits
export const DEFAULT_AGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
export const DEFAULT_CLI_TIMEOUT = DEFAULT_AGENT_TIMEOUT_MS;
export const DEFAULT_DEBATE_ROUNDS = 2;
/** @deprecated There is no implicit global ceiling; explicit overrides may exceed the default. */
export const MAX_CLI_TIMEOUT = Number.MAX_SAFE_INTEGER;

export function positiveIntegerOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function optionalPositiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// GitHub
export const GITHUB_REPO_URL = 'https://github.com/ejmockler/brutalist-mcp';
