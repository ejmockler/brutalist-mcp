/**
 * MCP Server Registry — manages which MCP servers are available to spawned CLI agents.
 *
 * Brutalist generates per-CLI MCP configurations from this registry so that
 * adversarial agents can use tools (e.g. Playwright) for evidence-backed
 * analysis while remaining unable to modify the codebase.
 */
export interface MCPServerSpec {
    command: string;
    args: string[];
    env?: Record<string, string>;
}
/** Resolve server specs by name from the registry. Unknown names are skipped with a warning. */
export declare function resolveServers(names: string[]): Record<string, MCPServerSpec>;
/** Return all registered server names (for discovery / cli_agent_roster). */
export declare function listRegisteredServers(): string[];
export declare function ensurePlaywrightBrowsers(): Promise<void>;
/**
 * Build the Claude `--mcp-config` JSON payload. `claude --help`:
 * `--mcp-config <configs...>  Load MCP servers from JSON files or strings`.
 *
 * Exported for unit-level construction tests. Production callers go
 * through `writeClaudeMcpConfigSecure` so the JSON lands on disk with
 * restrictive perms instead of on argv — `command`, `args`, and `env`
 * are all caller-controlled and any of them may carry credentials.
 */
export declare function buildClaudeMcpConfigJson(servers: Record<string, MCPServerSpec>): string;
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
export declare function writeClaudeMcpConfigSecure(servers: Record<string, MCPServerSpec>): Promise<string>;
/**
 * Remove a temp config file. ENOENT (already gone) is silent; any
 * other errno is logged at `warn` so silent credential leaks surface
 * in operator telemetry instead of vanishing.
 */
export declare function cleanupTempConfig(filepath: string): Promise<void>;
/**
 * Build a TOML-compatible value string for Codex's `-c mcp_servers=...` flag.
 * This **replaces** Codex's configured servers entirely (excluding brutalist).
 *
 * Codex parses the value as TOML, so we produce an inline-table representation:
 *   {playwright={command="npx", args=["@playwright/mcp@latest"]}}
 */
export declare function buildCodexMCPOverride(servers: Record<string, MCPServerSpec>): string;
//# sourceMappingURL=mcp-registry.d.ts.map