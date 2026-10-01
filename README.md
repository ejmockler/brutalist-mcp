# Brutalist MCP

An MCP server that runs reviews through locally installed Claude Code, Codex, and Antigravity (`agy`) CLIs. A roast runs the selected critics in parallel and returns their responses together. A debate assigns opposing positions to two critics across multiple rounds.

The CLI processes run on your machine; inference uses the services and credentials configured for each CLI. Findings are model output: check the cited files, commands, and sources before acting on them.

## Install

Use Node.js 24 and at least one authenticated CLI. CI also tests Node.js 20.

### 1. Install and sign in to a critic

On macOS or Linux, install whichever CLIs you want to use:

```sh
# Claude Code
curl -fsSL https://claude.ai/install.sh | bash

# Codex
npm install -g @openai/codex

# Antigravity CLI
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Launch `claude`, `codex`, or `agy` and complete sign-in. Brutalist's Agy adapter also requires `python3` on PATH and a POSIX environment; native Windows is unsupported, so use WSL there. For other platforms and installation options, use the official [Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://developers.openai.com/codex/cli/), and [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli#installation) instructions.

Brutalist prefers `~/.local/bin/agy` when it exists, avoiding the Antigravity desktop launcher's PATH collision. Set `AGY_BIN` to the executable's path if your CLI is elsewhere.

### 2. Connect your MCP client

**Claude Code** — user scope makes the server available across projects:

```sh
claude mcp add --scope user brutalist -- npx -y @brutalist/mcp@latest
```

**Codex:**

```sh
codex mcp add brutalist -- npx -y @brutalist/mcp@latest
```

Codex's default MCP tool timeout is 60 seconds. Persist a larger timeout in `~/.codex/config.toml`; `codex mcp add` has no dedicated timeout flag:

```toml
[mcp_servers.brutalist]
command = "npx"
args = ["-y", "@brutalist/mcp@latest"]
tool_timeout_sec = 9000
```

Brutalist waits for the critics to finish. A 9,000-second client timeout covers the default two-hour critic budget plus 30 minutes for startup and response processing. It is a suggested budget, not a minimum for every review. Increase it for debates, which run multiple turns and may retry. See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

**Other MCP clients** — register a local stdio server with command `npx` and arguments `-y`, `@brutalist/mcp@latest`. For clients that use an `mcpServers` object:

```json
{
  "mcpServers": {
    "brutalist": {
      "command": "npx",
      "args": ["-y", "@brutalist/mcp@latest"]
    }
  }
}
```

Place this in your client's MCP configuration, not a shell. The same server can be used from Cursor, VS Code, or Devin Desktop (formerly Windsurf); configuration locations and formats belong to those clients.

`@latest` selects the current npm release when the server is launched; an already running process keeps its loaded version. Restart or reconnect the MCP server after an update. To fix the package version, replace `@latest` with a version such as `@1.18.10`.

### 3. Check detection

Ask your assistant to call **`cli_agent_roster`** with `{}`. It reports detected CLIs and model configuration. Detection does not prove that authentication, quota, or a particular model will work; confirm with a roast.

## Tools

These are MCP tools invoked by your assistant, not terminal commands. The server exposes four:

| Tool | Purpose |
| --- | --- |
| `roast` | Review a path and context using a selected domain. |
| `roast_cli_debate` | Have two critics defend explicit opposing positions. |
| `cli_agent_roster` | Report detected critics and model configuration. |
| `brutalist_discover` | Suggest domains from an `intent` string. |

Legacy names such as `roast_codebase` and `roast_security` are not registered tools. Use `roast` with `domain` instead.

### Roast a repository

Call `roast` with:

```json
{
  "domain": "codebase",
  "target": "/absolute/path/to/repo",
  "context": "Review the authentication changes. Trace session creation, expiry, and authorization checks. Cite file paths and lines.",
  "limit": 20000
}
```

Use an existing directory as `target`. The path is included in the critic's prompt; it does not change the subprocess working directory, which defaults to the server's launch directory. Use absolute paths and identify the files or commands you want checked in `context`. For domains that review an idea, plan, or other text, put that material in `context`:

```json
{
  "domain": "architecture",
  "target": "/absolute/path/to/repo",
  "context": "We plan to move invoice generation to a queue. Assess duplicate delivery, transaction boundaries, and recovery after a worker crash."
}
```

| Domain | Review subject | Additional arguments |
| --- | --- | --- |
| `codebase` | Implementation | — |
| `file_structure` | Directory and module organization | `depth` |
| `dependencies` | Package dependencies | `includeDevDeps` |
| `git_history` | Commits and change history | `commitRange` |
| `test_coverage` | Tests and coverage gaps | `runCoverage` |
| `idea` | A proposal | `resources`, `timeline` |
| `architecture` | System design | `scale`, `constraints`, `deployment` |
| `research` | Research methods and claims | `field`, `claims`, `data` |
| `security` | Security controls and threats | `assets`, `threatModel`, `compliance` |
| `product` | Product decisions | `users`, `competition`, `metrics` |
| `infrastructure` | Deployment and operations | `scale`, `sla`, `budget` |
| `design` | Interface or visual design | `medium`, `audience`, `brand`, `url` |
| `legal` | Legal arguments or documents | `practice`, `jurisdiction`, `posture` |

For `design`, supplying a live `url` gives critics a concrete interface to inspect. The domain automatically requests the registered Playwright MCP server. Playwright is the built-in integration; the first Claude browser review may download Chromium. Register additional servers through the `BRUTALIST_MCP_SERVERS` JSON environment variable, keyed by name with `command` and `args`. Request names with `mcp_servers`. Claude and Codex wire these integrations; Agy currently ignores the field. Requested integrations replace Codex's configured MCP server set for that run. Check the result for actual browser observations.

### Choose critics and models

Omit `clis` to run all detected native critics. To select a subset, add:

```json
{
  "domain": "codebase",
  "target": "/absolute/path/to/repo",
  "clis": ["claude", "codex"]
}
```

No model override means the CLI chooses its configured/default model. Brutalist does not select the newest model or update the critic CLIs for you.

| Critic | Per-call selection |
| --- | --- |
| Claude Code | `models.claude` is passed to the CLI. |
| Codex | Uses its CLI configuration. `models.codex` is ignored unless the server has `BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE=true`; enabled overrides use discovered model migrations. |
| Antigravity | `models.agy` is passed through native `--model`. Run `agy models` to get choices available to your account. |

For Agy, copy a current ID or label from `agy models` into `models.agy`. Unpinned Agy responses leave the model unspecified: the adapter's plain-text output does not identify the selected model. Check Agy's local logs when you need that evidence. Brutalist disables Agy's CLI auto-update during critic runs; this does not pin the model.

### Debate a decision

Call `roast_cli_debate` with a topic and both positions:

```json
{
  "topic": "Should invoice generation move to a queue?",
  "proPosition": "Use a queue to isolate retries and absorb load spikes.",
  "conPosition": "Keep generation synchronous until idempotency and reconciliation are proven.",
  "agents": ["claude", "codex"],
  "rounds": 2,
  "context": "Current design: checkout writes the order and invoice in one database transaction. The proposed worker would receive an order ID after commit and retry on failure."
}
```

Debates require at least two detected CLIs. `agents` is optional; when supplied it contains exactly two critics, otherwise two are selected randomly. `rounds` accepts 1–3 and defaults to 3. The current debate handler accepts `target` but does not forward it to the critics; supply the evidence to debate in `context`. Use `roast` for a repository review. Positions are assigned for the debate. Its arguments are not independent endorsements. Custom routed clients are supported by `roast`, not debates.

## Read large results and follow up

`limit` accepts 1,000–100,000 and sets a chunk-size target in characters, not tokens. Roast pagination defaults to 90,000 characters; debate and automatic pagination use smaller defaults. Chunk boundaries, a minimum chunk size, and response headers mean it is not a hard output ceiling. Set it explicitly if your MCP client truncates results.

For another page, reuse the returned `context_id` and the next offset reported in the response. Keep the original domain and target; omit `resume`. For example, if the response asks you to continue at offset 20,000:

```json
{
  "domain": "codebase",
  "target": "/absolute/path/to/repo",
  "context_id": "<returned context_id>",
  "offset": 20000,
  "limit": 20000
}
```

You can also pass a cursor such as `"offset:20000"` instead of `offset`. Page reads retrieve cached output. The cache defaults to two hours and belongs to the server process; a restart loses it.

For a fresh follow-up, include the relevant earlier findings in `context` and set `force_refresh: true`:

```json
{
  "domain": "codebase",
  "target": "/absolute/path/to/repo",
  "force_refresh": true,
  "context": "The earlier review found duplicate invoice creation after retries. Check whether the new idempotency key prevents it; inspect both the database constraint and worker retry path."
}
```

The tool also accepts `context_id` with `resume: true` for history-based continuation, but the current handler has limitations: filesystem follow-ups record the target path as the new conversation message, and a cache hit can return earlier output without running critics. `force_refresh` skips history loading. Use the fresh-follow-up pattern above when you need a new review.

Use `force_refresh: true` after changing files, routed clients, or MCP integrations. File contents, `clients`, and `mcp_servers` are not all represented in the cache key.

## Custom Claude-compatible endpoints

`roast` can add named Claude Code clients routed through Anthropic-compatible endpoints. Set the token in the MCP server's environment and reference its variable name:

```json
{
  "domain": "codebase",
  "target": "/absolute/path/to/repo",
  "clis": [],
  "clients": [
    {
      "id": "gateway",
      "provider": "claude",
      "baseUrl": "https://gateway.example.com",
      "authTokenEnv": "REVIEW_GATEWAY_TOKEN",
      "model": "<model supported by your endpoint>"
    }
  ]
}
```

`clients` is additive to native critics; `clis: []` runs only named clients. Up to 16 clients are accepted. Endpoint, model, and credential-routing fields are supported only for the `claude` provider. You can also configure default clients through the server's `BRUTALIST_CLAUDE_CLIENTS` JSON environment variable. A nonempty per-call `clients` array replaces those defaults.

Routed clients use separate configuration directories under `~/.brutalist/claude-clients/<id>` unless `configDir` is supplied. They do not inherit native Claude credentials unless `includeProcessAuth: true` is set. Their `smallFastModel` defaults to the routed `model`.

The default containment setting, named `hardened`, suppresses requested MCP integrations. It does not sandbox shell commands or network access: Bash, WebFetch, and WebSearch remain available. `containment: "standard"` restores requested MCP integrations.

## Execution and troubleshooting

Critics can inspect files and invoke tools. Codex runs with `--sandbox read-only`. Claude denies its named mutation tools but enables Bash and web tools while bypassing permission prompts; this is not a filesystem sandbox. Agy runs with `--sandbox` and permission prompts disabled, and can write scratch artifacts. External MCP tools add their own capabilities. Use a checkout and credentials appropriate for those processes.

A roast can return findings when only some critics succeed. Check which critics contributed; a missing critic is not agreement. Error text may be generic or redacted. Authentication failures, quota limits, unsupported models, and client timeouts need separate diagnosis.

Useful server environment variables:

| Variable | Purpose |
| --- | --- |
| `BRUTALIST_TIMEOUT` | Per-agent roast timeout in milliseconds; default `7200000` (two hours). |
| `BRUTALIST_AGY_TIMEOUT` | Agy timeout ceiling in milliseconds; can shorten, not extend, the selected agent budget. |
| `AGY_BIN` | Override the Agy executable path. |
| `BRUTALIST_CODEX_ALLOW_MODEL_OVERRIDE` | Set exactly `true` to pass `models.codex` to Codex. |
| `BRUTALIST_MCP_SERVERS` | Additional MCP server definitions as a JSON object keyed by server name. |
| `BRUTALIST_CACHE_TTL_HOURS` | Result-cache lifetime; default `2`. |
| `BRUTALIST_LOG_FILE` | Set exactly `true` to enable NDJSON file logs. |
| `BRUTALIST_LOG_DIR` | Override the log directory; default `~/.brutalist-mcp/logs`. |
| `BRUTALIST_LOG_LEVEL` | Minimum file-log level; default `info`. |

Set these on the MCP server process, using your client's server environment configuration. The client tool timeout is a separate setting. Logs can contain paths, model names, and prompt excerpts; redaction does not make the entire file safe to share.

The `legal`, `research`, and `security` prompts ask critics to verify external authorities and label citations with `[VERIFIED: URL | "quote"]`, `[SUPPLIED: location | "quote"]`, or `[UNVERIFIED: reason]`. These are prompt instructions, not a programmatic guarantee that a citation was checked.

## GitHub pull-request reviews

The repository also contains a [GitHub Action](packages/github-action/README.md) and [orchestrator](packages/orchestrator). The Action posts findings as a PR review and has its own CLI installation and credential requirements. Use its README and [input definitions](packages/github-action/action.yml) for workflow setup, OAuth provisioning, and `custom-claude-clients` configuration.

## Development

```sh
npm ci
npm run build
npm test -- tests/unit tests/integration/pagination-e2e.test.ts tests/integration/cache.integration.test.ts tests/smoke
```

The [CI workflow](.github/workflows/ci.yml) also tests and builds the orchestrator and GitHub Action. Tagged releases publish the MCP package to npm with provenance after those checks pass.

License: MIT · [Report an issue](https://github.com/ejmockler/brutalist-mcp/issues)
