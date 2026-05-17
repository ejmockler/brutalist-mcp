/**
 * MCP Server Registry — manages which MCP servers are available to spawned CLI agents.
 *
 * Brutalist generates per-CLI MCP configurations from this registry so that
 * adversarial agents can use tools (e.g. Playwright) for evidence-backed
 * analysis while remaining unable to modify the codebase.
 */

import { promises as fs, constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';
import { randomBytes } from 'crypto';
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

// ── Playwright: auto-install browsers ───────────────────────────────────────

/**
 * Ensure Playwright browsers are installed. Runs `npx playwright install chromium`
 * once per process — subsequent calls return the same promise. The command is
 * idempotent: if browsers are already present it completes in ~1s with no download.
 * Without browsers, the Playwright MCP server launches but immediately fails.
 */
let playwrightInstallPromise: Promise<void> | null = null;

export function ensurePlaywrightBrowsers(): Promise<void> {
  if (playwrightInstallPromise) return playwrightInstallPromise;

  playwrightInstallPromise = (async () => {
    logger.info('🎭 Ensuring Playwright chromium browser is installed...');
    try {
      await execAsync('npx playwright install chromium', { timeout: 120_000 });
      logger.info('✅ Playwright chromium browser ready');
    } catch (e) {
      logger.warn('⚠️  Failed to install Playwright chromium browser:', e);
      // Don't block the critique — Playwright MCP will fail gracefully
      // and critics will fall back to source-only analysis
    }
  })();

  return playwrightInstallPromise;
}

// ── Claude: secure-file MCP config ─────────────────────────────────────────

/**
 * Build the Claude `--mcp-config` JSON payload. `claude --help`:
 * `--mcp-config <configs...>  Load MCP servers from JSON files or strings`.
 *
 * Exported for unit-level construction tests. Production callers go
 * through `writeClaudeMcpConfigSecure` so the JSON lands on disk with
 * restrictive perms instead of on argv — `command`, `args`, and `env`
 * are all caller-controlled and any of them may carry credentials.
 */
export function buildClaudeMcpConfigJson(
  servers: Record<string, MCPServerSpec>,
): string {
  const config: ClaudeMCPConfigJSON = { mcpServers: {} };
  for (const [name, spec] of Object.entries(servers)) {
    config.mcpServers[name] = {
      command: spec.command,
      args: spec.args,
      ...(spec.env && { env: spec.env }),
    };
  }
  return JSON.stringify(config);
}

/**
 * Write the Claude MCP config to a freshly-created temp file with
 * mode 0600, returning the path for `--mcp-config <path>`. Caller
 * must clean up via `cleanupTempConfig`.
 *
 * Filename uses 128 bits of `crypto.randomBytes` rather than
 * `pid + Date.now()` — predictable names enabled both a symlink
 * TOCTOU on shared `/tmp` and same-millisecond collisions between
 * parallel critic spawns.
 *
 * Flags:
 *   - `O_EXCL`: fail if the path already exists. A planted symlink
 *     or pre-staged file aborts the open rather than redirecting it.
 *   - `O_NOFOLLOW`: refuse to traverse a symlink at the final path
 *     component. Note this is undefined on Windows (Node falls back
 *     to `0`, which means no symlink protection — accept the
 *     degradation on Windows since `/tmp` semantics differ there).
 *     The flag does NOT guard intermediate path components; a
 *     hostile `TMPDIR` env pointed at a symlink remains a residual
 *     risk in shared-tenant CI runners.
 *
 * Mode `0o600` on `O_CREAT` is what the inode gets — umask can only
 * strip bits, not add them, and `O_EXCL` guarantees the inode is
 * fresh. No explicit chmod is needed.
 *
 * On any post-open failure (e.g. ENOSPC, EDQUOT during writeFile)
 * we unlink the just-created file so partial credentials never leak
 * to /tmp. The close() in finally is best-effort and ignores its
 * own errors so the original cause is preserved.
 *
 * Same-user processes can still read 0600 files; true
 * secret-safety needs OS keychain or short-lived tokens, which is
 * out of scope here.
 */
export async function writeClaudeMcpConfigSecure(
  servers: Record<string, MCPServerSpec>,
): Promise<string> {
  const json = buildClaudeMcpConfigJson(servers);
  const tmpDir = os.tmpdir();
  const suffix = randomBytes(16).toString('hex');
  const filename = `brutalist-mcp-${suffix}.json`;
  const filepath = path.join(tmpDir, filename);
  // `fs.constants.O_NOFOLLOW` is undefined on Windows; coerce to 0
  // so the bitwise expression doesn't silently flag this as the
  // platform supporting symlink protection when it doesn't.
  const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | O_NOFOLLOW;
  const handle = await fs.open(filepath, flags, 0o600);
  try {
    await handle.writeFile(json, { encoding: 'utf-8' });
  } catch (e) {
    // Best-effort unlink: the file was created by O_CREAT but we
    // never finished writing it. Unlink failure is swallowed so the
    // original write error reaches the caller.
    await fs.unlink(filepath).catch(() => { /* best-effort */ });
    throw e;
  } finally {
    // Ignore close errors: if the body of try succeeded the file is
    // safe; if it threw, the catch already unlinked. Either way the
    // close error is not the diagnostic we want to surface.
    await handle.close().catch(() => { /* best-effort */ });
  }
  // Log without the path: the path is already on the spawned child's
  // argv per `--mcp-config <path>`, so this log line would only widen
  // disclosure to aggregators. Bounded metadata only.
  logger.info('Wrote secure Claude MCP config', { sizeBytes: json.length });
  return filepath;
}

/**
 * Remove a temp config file. ENOENT (already gone) is silent; any
 * other errno is logged at `warn` so silent credential leaks surface
 * in operator telemetry instead of vanishing.
 */
export async function cleanupTempConfig(filepath: string): Promise<void> {
  try {
    await fs.unlink(filepath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.warn('Failed to clean up secure MCP config', {
        code: err?.code ?? 'unknown',
      });
    }
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
