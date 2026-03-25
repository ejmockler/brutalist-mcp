/**
 * MCP Server Registry — manages which MCP servers are available to spawned CLI agents.
 *
 * Brutalist generates per-CLI MCP configurations from this registry so that
 * adversarial agents can use tools (e.g. Playwright) for evidence-backed
 * analysis while remaining unable to modify the codebase.
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger.js';

const execAsync = promisify(exec);

// ── Types ──────────────────────────────────────────────────────────────────

export interface MCPServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Claude --mcp-config JSON format */
interface ClaudeMCPConfigJSON {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

// ── Registry ───────────────────────────────────────────────────────────────

/** Built-in known MCP servers. Extend this as new integrations are added. */
const BUILTIN_SERVERS: Record<string, MCPServerSpec> = {
  playwright: {
    command: 'npx',
    args: ['@playwright/mcp@latest'],
  },
};

/**
 * Merge built-in servers with user-defined servers from the
 * `BRUTALIST_MCP_SERVERS` env var (JSON object keyed by server name).
 */
function loadRegistry(): Record<string, MCPServerSpec> {
  const registry = { ...BUILTIN_SERVERS };

  const envServers = process.env.BRUTALIST_MCP_SERVERS;
  if (envServers) {
    try {
      const parsed = JSON.parse(envServers) as Record<string, MCPServerSpec>;
      for (const [name, spec] of Object.entries(parsed)) {
        if (spec?.command) {
          registry[name] = spec;
        }
      }
    } catch (e) {
      logger.warn('Failed to parse BRUTALIST_MCP_SERVERS env var:', e);
    }
  }

  return registry;
}

/** Resolve server specs by name from the registry. Unknown names are skipped with a warning. */
export function resolveServers(names: string[]): Record<string, MCPServerSpec> {
  const registry = loadRegistry();
  const resolved: Record<string, MCPServerSpec> = {};

  for (const name of names) {
    const spec = registry[name];
    if (spec) {
      resolved[name] = spec;
    } else {
      logger.warn(`MCP server "${name}" not found in registry — skipping`);
    }
  }

  return resolved;
}

/** Return all registered server names (for discovery / cli_agent_roster). */
export function listRegisteredServers(): string[] {
  return Object.keys(loadRegistry());
}

// ── Claude: temp JSON config file ──────────────────────────────────────────

/**
 * Write a temporary Claude MCP config file and return its path.
 * Caller is responsible for cleanup via `cleanupTempConfig`.
 */
export async function writeClaudeMCPConfig(
  servers: Record<string, MCPServerSpec>,
  sessionId: string,
): Promise<string> {
  const config: ClaudeMCPConfigJSON = { mcpServers: {} };
  for (const [name, spec] of Object.entries(servers)) {
    config.mcpServers[name] = {
      command: spec.command,
      args: spec.args,
      ...(spec.env && { env: spec.env }),
    };
  }

  const tmpDir = os.tmpdir();
  const filename = `brutalist-mcp-${sessionId}-${Date.now()}.json`;
  const filepath = path.join(tmpDir, filename);

  await fs.writeFile(filepath, JSON.stringify(config, null, 2), 'utf-8');
  logger.info(`Wrote Claude MCP config: ${filepath}`);
  return filepath;
}

/** Remove a temp config file. Swallows errors (file may already be gone). */
export async function cleanupTempConfig(filepath: string): Promise<void> {
  try {
    await fs.unlink(filepath);
    logger.info(`Cleaned up MCP config: ${filepath}`);
  } catch {
    // Already removed or never created — fine
  }
}

// ── Codex: -c config override string ───────────────────────────────────────

/**
 * Build a TOML-compatible value string for Codex's `-c mcp_servers=...` flag.
 * This **replaces** Codex's configured servers entirely (excluding brutalist).
 *
 * Codex parses the value as TOML, so we produce an inline-table representation:
 *   {playwright={command="npx", args=["@playwright/mcp@latest"]}}
 */
export function buildCodexMCPOverride(servers: Record<string, MCPServerSpec>): string {
  const entries = Object.entries(servers).map(([name, spec]) => {
    const args = spec.args.map(a => `"${a}"`).join(', ');
    return `${name}={command="${spec.command}", args=[${args}]}`;
  });
  return `{${entries.join(', ')}}`;
}

// ── Gemini: ensure servers are pre-configured ──────────────────────────────

/**
 * Ensure the requested MCP servers are configured in Gemini CLI.
 * Runs `gemini mcp list` to check, then `gemini mcp add` for missing ones.
 * Idempotent — safe to call on every invocation.
 */
export async function ensureGeminiMCPServers(
  servers: Record<string, MCPServerSpec>,
): Promise<void> {
  let existingNames: Set<string>;

  try {
    const { stdout } = await execAsync('gemini mcp list', { timeout: 10_000 });
    // Parse the table output — server names are in the first column
    existingNames = new Set(
      stdout.split('\n')
        .filter(line => line.trim() && !line.startsWith('Name') && !line.startsWith('Loaded'))
        .map(line => line.split(/\s+/)[0])
        .filter(Boolean),
    );
  } catch {
    logger.warn('Could not list Gemini MCP servers — skipping pre-configuration');
    return;
  }

  for (const [name, spec] of Object.entries(servers)) {
    if (existingNames.has(name)) {
      logger.info(`Gemini MCP server "${name}" already configured`);
      continue;
    }

    try {
      const args = spec.args.map(a => `"${a}"`).join(' ');
      await execAsync(`gemini mcp add ${name} ${spec.command} ${args}`, { timeout: 15_000 });
      logger.info(`Added Gemini MCP server: ${name}`);
    } catch (e) {
      logger.warn(`Failed to add Gemini MCP server "${name}":`, e);
    }
  }
}
