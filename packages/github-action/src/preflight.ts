/**
 * Preflight checks for the runtime dependencies the action assumes are
 * on PATH. We surface missing binaries with actionable error messages
 * before invoking the orchestrator — without this, failures surface
 * mid-stream as cryptic stdio errors from spawned child processes.
 *
 * Hard requirements (action fails fast if missing):
 *   - `brutalist-mcp` — the MCP server the orchestrator spawns over stdio.
 *   - `claude` — the Claude Agent SDK launches the Claude Code CLI as
 *     the orchestrator's brain. Without it the SDK's `query()` cannot
 *     start.
 *
 * Soft requirements (warn but proceed):
 *   - At least one of {`claude`, `codex`, `gemini`} for the brutalist
 *     critic side. `claude` doubles as a critic so the hard requirement
 *     above already covers the minimum, but absence of `codex` and
 *     `gemini` means a single-perspective review.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as core from '@actions/core';

const execAsync = promisify(exec);

export interface PreflightResult {
  brutalistMcp: BinaryStatus;
  claude: BinaryStatus;
  codex: BinaryStatus;
  gemini: BinaryStatus;
}

export interface BinaryStatus {
  binary: string;
  available: boolean;
  resolvedPath?: string;
}

/**
 * Probe each binary via `which` (POSIX) and verify the resolved path
 * exists. We deliberately don't run `--version` because some CLIs
 * launch interactive UIs on a bare invocation; PATH resolution alone
 * is enough to distinguish "installed" from "not installed".
 */
export async function runPreflight(): Promise<PreflightResult> {
  const [brutalistMcp, claude, codex, gemini] = await Promise.all([
    probeBinary('brutalist-mcp'),
    probeBinary('claude'),
    probeBinary('codex'),
    probeBinary('gemini'),
  ]);
  return { brutalistMcp, claude, codex, gemini };
}

/**
 * Validate the preflight result and throw with an actionable error if a
 * hard requirement is missing. Soft requirements are emitted as warnings
 * but do not block execution.
 */
export function assertPreflight(result: PreflightResult): void {
  const missing: string[] = [];
  if (!result.brutalistMcp.available) missing.push('brutalist-mcp');
  if (!result.claude.available) missing.push('claude');

  if (missing.length > 0) {
    throw new Error(
      `Preflight failed — required binaries not on PATH: ${missing.join(', ')}.\n\n` +
        `Add an install step to your workflow before this action, e.g.:\n\n` +
        `  - run: npm install -g @brutalist/mcp claude\n\n` +
        `\`brutalist-mcp\` is the MCP server the orchestrator spawns. ` +
        `\`claude\` is the Claude Code CLI used by the Claude Agent SDK as the orchestrator brain (and as a brutalist critic).`,
    );
  }

  // Soft warnings — having only one critic is functional but loses the
  // multi-perspective value prop.
  const critics = [result.claude, result.codex, result.gemini].filter((b) => b.available);
  if (critics.length === 1) {
    core.warning(
      `Only one CLI critic available (${critics[0].binary}). Multi-perspective review requires installing additional critics: ${
        result.codex.available ? '' : 'codex '
      }${result.gemini.available ? '' : 'gemini'}.`.trim(),
    );
  }

  for (const status of [result.claude, result.codex, result.gemini]) {
    if (status.available && status.resolvedPath) {
      core.info(`✓ ${status.binary}: ${status.resolvedPath}`);
    }
  }
  if (result.brutalistMcp.resolvedPath) {
    core.info(`✓ brutalist-mcp: ${result.brutalistMcp.resolvedPath}`);
  }
}

async function probeBinary(binary: string): Promise<BinaryStatus> {
  const cmd = process.platform === 'win32' ? 'where' : 'command -v';
  try {
    const { stdout } = await execAsync(`${cmd} ${binary}`);
    const resolvedPath = stdout.split('\n')[0].trim();
    return { binary, available: !!resolvedPath, resolvedPath };
  } catch {
    return { binary, available: false };
  }
}
