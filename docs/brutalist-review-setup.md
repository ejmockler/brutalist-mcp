# Brutalist Review — install on any repo

Run the Brutalist multi-CLI code review (Claude + Codex + agy) on every PR of
any repo, with **self-healing Codex OAuth** so it keeps working hands-off.

There are two parts:
- **One-time prerequisites** (browser-bound, can't be scripted) — §1.
- **Per-repo install** — one command, §2.

---

## 1. One-time prerequisites

### 1a. The codex-write-back GitHub App (do once, reuse on every repo)

Codex on a **ChatGPT plan** uses OAuth with refresh-token *rotation*. In
stateless CI the rotated token must be written back to the `CODEX_AUTH` secret,
which needs a credential the built-in `GITHUB_TOKEN` doesn't have. A GitHub App
is the right tool: non-expiring, scoped, ephemeral per-run tokens (no PAT).

1. **github.com/settings/apps/new** → name it (e.g. `brutalist-reviewer`),
   Homepage URL = any, **uncheck Webhook → Active**.
2. **Repository permissions → Secrets: Read and write** (auto-adds Metadata).
   Nothing else.
3. Create → **Generate a private key** (`.pem`), note the numeric **App ID**.
4. **Install App** → install on each target repo (or "All repositories").

The same App ID + `.pem` work for every repo you install it on.

### 1b. Capture the critic credentials

| Critic | Capture | Notes |
|--------|---------|-------|
| **claude** (required) | `claude setup-token` → copy the token | The orchestrator brain + inner claude critic. |
| **codex** (optional) | `codex login` → `~/.codex/auth.json` | ChatGPT-plan OAuth. **See §3 — use a CI-dedicated login.** |
| **agy** (optional) | `agy "hi"` once (browser OAuth) | Token lives in the macOS keychain; the installer extracts it. |

### 1c. Codex: the two-login model (the durable answer)

Codex refresh-tokens rotate, and **a chain can have only one owner** — if your
daily local codex and CI share one login, whoever refreshes first invalidates
the other and OpenAI's reuse-detection revokes the family. You do **not** need a
second ChatGPT account; you need CI to own its **own login chain**:

```
codex login            # login #1 — capture THIS for CI (don't use it locally)
#   → run the installer (§2), which captures ~/.codex/auth.json into CODEX_AUTH
codex login            # login #2 — this one stays your local daily codex
```

Two logins on one account = two independent refresh chains. CI rotates its
chain (persisted by the write-back App); your local codex rotates the other.
They never collide. *(Codex Access Tokens — the refresh-free CI auth — are
Business/Enterprise-only; on Plus/Pro this two-login approach is the way.)*

---

## 2. Per-repo install (one command)

```bash
ANTHROPIC_OAUTH_TOKEN='<from claude setup-token>' \
APP_ID='<numeric App ID>' \
APP_PRIVATE_KEY_FILE=~/Downloads/brutalist-reviewer.*.pem \
CODEX_AUTH_FILE=~/.codex/auth.json \
./scripts/install-brutalist-review.sh <owner/repo>
```

It sets the secrets (`ANTHROPIC_OAUTH_TOKEN`, `CODEX_AUTH`, `AGY_OAUTH_TOKEN`,
`CODEX_AUTH_APP_ID`, `CODEX_AUTH_APP_PRIVATE_KEY`), commits
`.github/workflows/brutalist-review.yml` (pinned, with the write-back +
concurrency group), and verifies the App is installed on the repo. Secrets are
piped, never echoed. Re-running is idempotent. Optional env: `BRUTALIST_VERSION`
(default the pinned release), `MIN_SEVERITY` (default `medium`), `AGY_TOKEN_FILE`.

Every critic is independent: a repo with only `ANTHROPIC_OAUTH_TOKEN` runs
Claude-only; add `CODEX_AUTH`/`AGY_OAUTH_TOKEN` to light up the others.

---

## 3. Durability & maintenance

- **With the App + a CI-dedicated codex login:** hands-off. Codex refreshes its
  chain during a run; the write-back persists the rotated token to `CODEX_AUTH`
  for the next run. No PAT, no expiry treadmill. A **keep-warm** job (cron every
  5 days, same workflow) refreshes + writes back in a controlled serialized run,
  so the token never goes idle and rotation never happens during a racing PR.
- **CI needs its own codex chain.** Codex (ChatGPT plan) rotates one login's
  token on refresh; if your local codex and CI share a login they revoke each
  other. Give CI its own: `codex login` → capture for CI → `codex login` again →
  that stays local. Two independent chains on one account, no conflict. (Not
  bulletproof-forever on Plus — a rotation hiccup or ~6mo idle may need a
  one-time re-login + re-run of the installer; the keep-warm job makes that
  rare. The only zero-maintenance options — Codex Access Tokens — are
  Business/Enterprise-only.)
- **Without the App** (or with a shared/blanked token): codex works until its
  access-token expires (~7–10 days) or its chain is rotated out from under CI,
  then needs re-capture. The review degrades gracefully — Claude carries it and
  the run still goes green; a failed codex surfaces an actionable
  "CODEX OAuth token expired — re-capture" message.
- **If codex starts failing with `refresh_token_reused`/401:** the chain was
  revoked (concurrent use / a shared local login). Recover with
  `codex logout && codex login`, then re-run the installer to re-capture.
- **agy** is a slow, sometimes-non-converging critic on large repos; it's
  capped per-critic (`BRUTALIST_TIMEOUT`) so it can't hang the run, and scoped
  to the diff (`BRUTALIST_PR_DIFF`, deterministic) so it reviews the change, not
  the whole tree.
