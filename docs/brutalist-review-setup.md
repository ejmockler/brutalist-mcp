# Brutalist Review — install on any repo

Run the Brutalist multi-CLI code review on every PR of any repo.

- **Default critics: Claude + agy.** Works on public and private repos, no
  ongoing auth maintenance.
- **Codex is opt-in and private-repo-only** — see §3. On public repos, run
  codex locally, not in CI (reason in §3).

---

## 1. One-time prerequisites

Capture the critic credentials (each is one-time, browser-bound):

| Critic | Capture | Notes |
|--------|---------|-------|
| **claude** (required) | `claude setup-token` → copy the token | The orchestrator brain + the claude critic. |
| **agy** (optional) | `agy "hi"` once (browser OAuth) | Token lives in the macOS keychain; the installer extracts it. |
| **codex** (optional, private repos) | see §3 | ChatGPT-plan OAuth. |

---

## 2. Install (one command)

```bash
ANTHROPIC_OAUTH_TOKEN='<from claude setup-token>' \
  ./scripts/install-brutalist-review.sh <owner/repo>
```

Sets `ANTHROPIC_OAUTH_TOKEN` + `AGY_OAUTH_TOKEN` (auto-extracted from the
keychain on macOS), and commits `.github/workflows/brutalist-review.yml`
(pinned). Secrets are piped, never echoed. Idempotent. Optional env:
`BRUTALIST_VERSION`, `MIN_SEVERITY` (default `medium`), `AGY_TOKEN_FILE`.

Critics are independent — a repo with only `ANTHROPIC_OAUTH_TOKEN` runs
Claude-only; add `AGY_OAUTH_TOKEN` for the second lens.

---

## 3. Codex in CI — private repos / self-hosted runners only

**Do not enable codex-in-CI on a public/open-source repo.** OpenAI's
[CI/CD auth guide](https://developers.openai.com/codex/auth/ci-cd-auth)
explicitly forbids using a ChatGPT-plan `auth.json` there (token-exposure +
personal-account suspension risk), and the official `openai/codex-action` is
API-key-only (it proxies the billed Responses API — no subscription path). On
public repos, keep codex **local**.

On a **private** repo (or self-hosted runner), codex can run on your ChatGPT
plan with a self-healing GitHub App write-back. Hard facts to design around:

- **One active codex session per ChatGPT account** — empirically confirmed: a
  second `codex login` *revokes* the first. So you cannot run codex both
  locally and in CI on one account. To do both, use a **dedicated 2nd
  account** for CI (or only run codex in CI, not locally). Codex Access Tokens
  (refresh-free, isolated) would be ideal but are **Business/Enterprise-only**.
- **Refresh-token rotation** — codex rotates its token on refresh (~every 8
  days). CI must persist the rotated token back, or it goes stale. That's what
  the GitHub App + write-back + keep-warm job do.

### Enable it
1. Create a **GitHub App**: [github.com/settings/apps/new](https://github.com/settings/apps/new) →
   uncheck Webhook → **Repository permissions → Secrets: Read and write** →
   Create → Generate a private key (`.pem`), note the **App ID** → **Install**
   on the (private) repo.
2. On a trusted machine dedicated to CI's account: `codex login` →
   `~/.codex/auth.json`.
3. Install with codex enabled:
   ```bash
   ENABLE_CODEX=1 \
   ANTHROPIC_OAUTH_TOKEN='...' \
   APP_ID='<numeric App ID>' APP_PRIVATE_KEY_FILE=~/Downloads/*.pem \
   CODEX_AUTH_FILE=~/.codex/auth.json \
     ./scripts/install-brutalist-review.sh <owner/private-repo>
   ```
   This adds the codex critic, the App write-back, a **keep-warm** cron (every
   5 days — refreshes + writes back so the token never idles), and a
   `concurrency` group (codex's reuse-detection forbids concurrent refreshes).

### Durability (codex mode)
Hands-off in the normal case. Residual risk: a rotation hiccup or ~6 months
idle may need a one-time `codex login` + re-run of the installer. When codex
fails, the review degrades gracefully (Claude + agy still post) and the
summary says *"CODEX OAuth token expired — re-capture."*
