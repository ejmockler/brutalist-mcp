# Brutalist GitHub Action

Multi-CLI brutalist code review (Claude Code, Codex, Antigravity) posted as inline PR comments.

This Action runs the [`@brutalist/orchestrator`](../orchestrator) against a pull request, then translates the resulting structured findings into a single GitHub review with grouped per-line comments and a synthesis summary.

## Architecture

```
Pull request opened/synced
        │
        ▼
GitHub Action runner
        │
        ├─ readInputs() ──── inputs/secrets validation
        ├─ fetchPullRequestContext() ── PR diff + commentable lines
        ├─ runOrchestrator() ─── @brutalist/orchestrator
        │                          ├─ spawns @brutalist/mcp via stdio
        │                          ├─ Claude Agent SDK (OAuth)
        │                          ├─ calls roast(codebase|architecture|security)
        │                          └─ submit_findings tool → structured Finding[]
        ├─ resolveFindings() ─── grep verbatimQuote at head SHA
        ├─ groupInlineFindings() ── cross-CLI on same line → one comment
        └─ submitReview() ────── POST /pulls/{n}/reviews (event: COMMENT)
```

## Requirements

The runner must have these CLIs installed (the orchestrator spawns them via the brutalist MCP server):

- `claude` (Claude Code) — required
- `codex` (Codex CLI) — optional
- `agy` (Antigravity CLI) — optional. Installed via `curl -fsSL https://antigravity.google/cli/install.sh | bash` (drops the binary at `~/.local/bin/agy`).

Plus the brutalist MCP binary itself: `npm i -g @brutalist/mcp`.

## OAuth setup

Each CLI has its own OAuth capture flow. Run once locally, store the result as a repo secret. The Action writes the secrets back to `$HOME` on every runner before invoking the orchestrator.

### Claude (required) — env-var OAuth

```bash
claude setup-token                          # interactive browser flow
gh secret set ANTHROPIC_OAUTH_TOKEN         # paste the printed token
```

Long-lived session token. No file on disk — the Agent SDK reads `CLAUDE_CODE_OAUTH_TOKEN` env directly. Regenerate if you ever see `authentication_failed`.

### Codex (optional) — file-based OAuth

```bash
codex login                                 # interactive browser flow → writes ~/.codex/auth.json
gh secret set CODEX_AUTH < ~/.codex/auth.json
```

The file holds `{ tokens: { refresh_token, access_token, id_token, account_id }, ... }`. The Action writes it to `~/.codex/auth.json` on the runner with mode 0600. **Don't also set `OPENAI_API_KEY`** — env vars override the file-based OAuth path.

### Antigravity (agy, optional) — file-based OAuth via macOS keychain capture

agy has no API-key auth path (issue [#78](https://github.com/google-antigravity/antigravity-cli/issues/78) — still file-based-OAuth-only through v1.0.10). The Action provisions tokens via a file the agy CLI's container-detection auto-loads, and the brutalist-mcp critic freezes agy's binary version (`AGY_CLI_DISABLE_AUTO_UPDATE`) during the run so a mid-fleet self-update can't silently change critic behavior (an uncontrolled 1.0.2→1.0.10 self-update is what once broke this critic). Model pins use agy's native `--model` flag (live as of 1.0.10).

```bash
# Step 1: one-time interactive auth on macOS (browser OAuth)
agy "hi"
# Step 2: extract the keychain blob, strip the go-keyring-base64: prefix,
#         base64-decode to raw JSON, store as a repo secret
security find-generic-password -s gemini -a antigravity -w \
  | sed 's/^go-keyring-base64://' | base64 -d \
  | gh secret set AGY_OAUTH_TOKEN
```

The raw JSON has shape `{"token":{"access_token","refresh_token","expiry","token_type":"Bearer"},"auth_method":"consumer"}`. The Action writes it to `~/.gemini/antigravity-cli/antigravity-oauth-token` (mode 0600) before invoking the orchestrator; agy's container-detection (cgroup-based — works in standard GitHub Actions Linux runners) auto-switches to file-based token storage and reads from there.

### Lifecycle caveat

Codex and agy both rotate access_tokens during use and rewrite their credential files. In ephemeral CI runners those writes vanish with the VM, so each run starts from the original secret's `refresh_token`. This works fine as long as the provider treats refresh tokens as long-lived (typical for installed-app OAuth). If the provider hard-rotates, the Action emits a `core.warning` after each run noting the new fingerprint — re-run `codex login` / `agy "hi"` and re-capture before the prior refresh token expires.

### Why OAuth at all?

Cost, rate-limits, and org policies follow the human identity that authorized the auth flow, not the bot. The `openai-api-key` API-key alternative still works for the Codex critic if you prefer that boundary. agy has no API-key alternative in v1.0.2.

## Usage

```yaml
# .github/workflows/brutalist.yml
name: Brutalist Review
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write   # required to post review comments

jobs:
  brutalist:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # full history so brutalist can read git context

      - name: Install CLI critics
        run: |
          npm i -g @brutalist/mcp@latest @anthropic-ai/claude-code
          # Optional: install additional critics for multi-perspective review.
          npm i -g @openai/codex
          curl -fsSL https://antigravity.google/cli/install.sh | bash

      - name: Brutalist review
        uses: ejmockler/brutalist-mcp/packages/github-action@v1.14.0
        with:
          # Required:
          anthropic-oauth-token: ${{ secrets.ANTHROPIC_OAUTH_TOKEN }}
          # Optional OAuth (recommended over API keys):
          codex-auth: ${{ secrets.CODEX_AUTH }}
          agy-oauth-token: ${{ secrets.AGY_OAUTH_TOKEN }}
          # Alternative API-key fallback for Codex (mutually exclusive with codex-auth):
          # openai-api-key: ${{ secrets.OPENAI_API_KEY }}
          # Optional additional Claude Code critic routed through a custom endpoint:
          # custom-claude-client-id: glm
          # custom-claude-base-url: https://immersivecommons13.tail5da903.ts.net
          # custom-claude-auth-token: ${{ secrets.GLM_ANTHROPIC_AUTH_TOKEN }}
          # custom-claude-model: glm-5.1
          # custom-claude-small-fast-model: glm-4.5-air
          # Optional: route MANY custom Claude critics at once (JSON array; up to 16).
          # Additive to the singular custom-claude-* inputs above (they append one
          # more client; deduped by id, keep-first on collision).
          # custom-claude-clients: |
          #   [
          #     { "id": "glm",  "baseUrl": "https://glm.example/v1",  "authToken": "${{ secrets.GLM_TOKEN }}",  "model": "glm-5.1", "contextWindow": 128000 },
          #     { "id": "kimi", "baseUrl": "https://kimi.example/v1", "authToken": "${{ secrets.KIMI_TOKEN }}", "model": "kimi-k2", "contextWindow": 200000 }
          #   ]
          # Defaults:
          # github-token: ${{ github.token }}
          # minimum-severity: low
          # working-directory: .
```

### Pinning

The `@v1.14.0` above is an exact release. Three pinning styles, strongest supply-chain guarantee first:

- **By commit SHA** — `…/github-action@<40-char-sha>` (optionally `# v1.14.8`). Immutable; nothing moves under you. Recommended for security-sensitive repos.
- **By exact release** — `…/github-action@v1.14.8`. Immutable tag; update by bumping the line.
- **By moving major/minor** — `…/github-action@v1` or `@v1.14`. These tags are auto-repointed to the newest release on each publish, so you receive patches without editing your workflow. Convenient, but you inherit changes you didn't pin to.

Tuning knobs (env on the action's step), useful once you're on a release that supports them: `BRUTALIST_ORCHESTRATOR_TIMEOUT_MS` (wall-clock budget, default 30m) and `BRUTALIST_ORCHESTRATOR_MAX_TURNS` (agent turn cap, default 50) — raise the latter if reviews of very large diffs terminate as incomplete.

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `anthropic-oauth-token` | yes | — | OAuth token from `claude setup-token`. Stored as a repo secret. |
| `github-token` | no | `${{ github.token }}` | Token used to post the review. Needs `pull-requests: write`. |
| `codex-auth` | no | — | Full contents of `~/.codex/auth.json` for Codex OAuth. Mutually exclusive with `openai-api-key`. |
| `agy-oauth-token` | no | — | Raw JSON from the macOS keychain `gemini/antigravity` entry (after `go-keyring-base64:` prefix strip + base64-decode). See "Antigravity (agy)" auth section above. |
| `openai-api-key` | no | — | OpenAI API key for the Codex critic. Fallback when `codex-auth` is absent. |
| `model` | no | `claude-opus-4-8` | Native Claude Agent SDK brain model. |
| `claude-critic-model` | no | `model` | Native Claude Code critic model. |
| `custom-claude-client-id` | no | `custom-claude` | Display id for an additional Claude Code critic routed through a custom endpoint. |
| `custom-claude-base-url` | no | — | `ANTHROPIC_BASE_URL` for the custom Claude Code critic. |
| `custom-claude-auth-token` | no | — | Bearer token for `ANTHROPIC_AUTH_TOKEN`; store as a GitHub secret. |
| `custom-claude-model` | no | — | Model name for the custom Claude Code critic, e.g. `glm-5.1`. |
| `custom-claude-small-fast-model` | no | — | Optional `ANTHROPIC_SMALL_FAST_MODEL`, e.g. `glm-4.5-air`. |
| `custom-claude-clients` | no | — | JSON array of N custom Claude-routed critics (each `{id, baseUrl, authToken, model, smallFastModel?, contextWindow?, containment?}`), up to **16**. ADDITIVE to the native critics, and additive to the singular `custom-claude-*` inputs (which append one more client; deduped by id, keep-first on collision). Per-entry tokens go in dedicated env vars (never inlined into the forwarded config); each client is isolated (`~/.brutalist/claude-clients/<id>`, mode `0700`) and hardened (no native creds, no `WebFetch`/`WebSearch`/MCP) by default — set `"containment":"standard"` to restore web/MCP tools. The diff chunker sizes chunks to the smallest participant `contextWindow`. |
| `working-directory` | no | `.` | Subtree of the repo to focus on. |
| `minimum-severity` | no | `low` | Inline-comment threshold. One of: `critical`, `high`, `medium`, `low`, `nit`. Lower-severity findings still appear in the summary. |

## Outputs

| Name | Description |
|---|---|
| `review-id` | Numeric ID of the submitted review. |
| `review-url` | HTML URL of the review. |
| `inline-comment-count` | Number of grouped inline comments posted. |
| `out-of-diff-count` | Number of findings rendered in the summary instead of inline. |
| `dropped-count` | Number of findings dropped because the verbatim quote couldn't be located in the file (likely fabrication). |

## How findings get attributed

Each CLI critic emits prose; the orchestrator extracts findings keyed to specific `(path, verbatimQuote)` pairs. The Action then:

1. **Verifies** every quote against the file at the PR head SHA via line-by-line substring match. Quotes that don't resolve get dropped (they're almost always fabrications) and counted in `dropped-count`.
2. **Groups** findings sharing the same `(path, line, side)` into a single inline comment with stacked CLI badges.
3. **Buckets** out-of-diff findings (real concern, not on a changed line) into the review summary's "Out-of-diff findings" section.

A grouped comment looks like:

> 🪓 **Brutalist** — 2 critics, rollup: 🔴 critical
>
> **[Codex 🔴 critical]** *security* — JWT in localStorage exfiltrates via XSS
> *full body…*
>
> **[Claude 🔴 critical]** *security* — Same. Plus rotation is missing.
> *full body…*

## Limitations / known gaps

- **Bundling not yet wired.** v0 ships unbundled — the deps tree (`@octokit/rest`, `@actions/core`, `@brutalist/orchestrator`) needs to ship alongside `dist/index.js`. Production usage will need `ncc build` integration in this package's release workflow.
- **No conversation continuation yet.** A user reply to an inline comment doesn't (yet) trigger a follow-up roast via `resume: true` + cached `context_id`. Planned for v1.
- **Domain scope narrowed.** v0 routes only `codebase`, `architecture`, `security`. The orchestrator is domain-general; widening is a system-prompt change.
- **No suggestion stacking.** If multiple CLIs propose code suggestions on the same line, only the top-severity finding's suggestion renders (GitHub's suggestion blocks would conflict otherwise).
