# Brutalist Review — install on any repo

Run the Brutalist multi-CLI code review on every PR of any repo.

- **Default critics: Claude + agy.** Works on public and private repos, no
  ongoing auth maintenance.
- **Codex is opt-in** (§3) via the **broker-push model** — ChatGPT-plan auth,
  no OpenAI API key, and (unlike a naive `auth.json`-in-a-secret) it coexists
  with your *local* codex on the *same* account and stays fresh hands-off.

---

## 1. One-time prerequisites

Capture the critic credentials (each is one-time, browser-bound):

| Critic | Capture | Notes |
|--------|---------|-------|
| **claude** (required) | `claude setup-token` → copy the token | The orchestrator brain + the claude critic. |
| **agy** (optional) | `agy "hi"` once (browser OAuth) | Token lives in the macOS keychain; the installer extracts it. |
| **codex** (optional) | a running **broker** (§3) | ChatGPT-plan OAuth, pushed to CI out-of-band. |

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

## 3. Codex in CI — the broker-push model

The hard problem: codex authenticates against your **ChatGPT plan** (the
official `openai/codex-action` is API-key-only — it bills the Responses API, no
subscription path), and a ChatGPT-plan login is *singular and self-rotating*:

- **One active grant per account.** A second `codex login` *revokes* the first.
- **Single-use refresh tokens with reuse-detection.** Two independent refreshers
  on the same lineage → the chain is invalidated (`refresh_token_reused`). So you
  can't just drop `auth.json` into a CI secret and let CI refresh it: CI and your
  laptop would fight over the lineage and both break.

**The broker fixes this by making exactly one process the refresher.** An
always-on host (a home server, a NAS, a small VM — here, `noot-1`) holds the one
login and is the **sole refresher**. Everyone else — your laptop *and* CI — just
*consumes* short-lived access tokens it hands out. Codex does no validation on
consume, so a freshly-minted access token with the refresh field blanked works
fine and can't desync anything.

```
broker host (always-on, behind a firewall — outbound only)
  codex-broker        ── holds the ONE login; sole refresher of the lineage
  codex-push.timer    ── every ~4 days: refresh, blank refresh_token,
                          `gh secret set CODEX_AUTH --repo <each repo>`   ──┐
                                                                           │ outbound
  laptop ── pulls a fresh access_token from the broker over your VPN       │ HTTPS
                                                                           ▼
GitHub:  CODEX_AUTH secret (short-lived access token, refresh BLANKED)
  └─► CI reads it → ~/.codex/auth.json → codex exec     (never refreshes)
```

Why this satisfies the usual constraints: the broker only makes **outbound**
calls, so it works from behind a firewall with no inbound and **no CI runner on
your VPN**. CI treats `CODEX_AUTH` like any normal secret. Because CI never
refreshes, the broker's lineage never desyncs — local + CI run off one account
indefinitely.

**Public repos:** the CI secret holds only a ~10-day access token with **no
refresh token**, and fork PRs don't receive secrets (the workflow's
`head.repo.full_name == github.repository` guard also blocks them) — so exposure
is far lower than shipping a full `auth.json`. It's still ToS-grey to use a
ChatGPT-plan login in CI on open-source; that's your call.

### 3a. Stand up the broker (once, on the always-on host)

1. `codex login` on that host → `~/codex-broker/auth.json` (a dedicated copy,
   kept out of the host's own `~/.codex`).
2. Run the broker as a **systemd *user* service** (`loginctl enable-linger
   <user>` so it survives logout). It refreshes when the access token is within
   ~10 min of expiry and serves `/token` over your VPN IP only, key-gated. See
   `noot-1:~/codex-broker/broker.py`.
3. Run the push as a **systemd timer** (`OnUnitActiveSec=4d`): it force-refreshes,
   builds an `auth.json` with `refresh_token=""` + `auth_mode:"chatgpt"`, and
   `gh secret set CODEX_AUTH --repo <r>` for each repo in its `REPOS` list, using
   the host's own `gh` auth. See `noot-1:~/codex-broker/push-codex-secret.sh`.
4. Point your laptop at the broker (optional): a small `pull` script + a launchd/
   cron job that writes `~/.codex/auth.json` (refresh blanked) every few hours, so
   local codex also rides the one lineage.

### 3b. Install codex on a repo

```bash
ENABLE_CODEX=1 \
ANTHROPIC_OAUTH_TOKEN='...' \
CODEX_AUTH_FILE=~/.codex/auth.json \
  ./scripts/install-brutalist-review.sh <owner/repo>
```

This seeds `CODEX_AUTH` (refresh blanked) so the first runs work immediately,
and writes the codex-enabled workflow (installs `@openai/codex`, disables the
broken `image_generation` tool — codex#21952 — and reads `CODEX_AUTH`). No
GitHub App, no in-CI refresh, no keep-warm cron: the broker owns refresh.

### 3c. Register the repo with the broker (ongoing freshness)

Add `<owner/repo>` to the push script's `REPOS` on the broker host and kick one
push:

```bash
ssh <broker-host> 'REPOS="owner/repo-a owner/repo-b" ~/codex-broker/push-codex-secret.sh'
```

(or edit the env in the systemd unit / `REPOS` file the script reads). The
broker's `gh` must have access to set secrets on each repo. From then on the
4-day timer keeps every registered repo's `CODEX_AUTH` fresh.

### Durability (codex mode)
Hands-off. The broker refreshes every ~4 days; access tokens live ~10 days, so
there's ample margin. If the broker host is down longer than the token TTL,
codex degrades gracefully — Claude + agy still post, and the summary notes
*"CODEX OAuth token expired."* Recovery is just bringing the broker back (or a
one-time `codex login` on it if the lineage ever fully lapses).
