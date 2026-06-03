#!/usr/bin/env bash
#
# install-brutalist-review.sh — add the Brutalist Review action to ANY GitHub
# repo in one shot. Default critics: claude + agy.
#
# Codex is OPT-IN (ENABLE_CODEX=1). It uses ChatGPT-plan OAuth via the
# "broker-push" model, NOT an OpenAI API key:
#   * An always-on broker (e.g. noot-1) holds the ONE codex login and is the
#     SOLE refresher of its token lineage. Every ~4 days it pushes a fresh,
#     short-lived access_token (refresh_token BLANKED) to the repo's CODEX_AUTH
#     secret via `gh secret set` — outbound only, no inbound, firewall-friendly.
#   * CI just READS CODEX_AUTH and runs codex. It never refreshes, so the
#     broker's refresh chain never desyncs. The CI secret therefore holds only a
#     ~10-day access token (no refresh_token) — leaking it can't rotate the
#     account, and fork PRs don't receive secrets anyway.
# This installer SEEDS the initial CODEX_AUTH (refresh blanked) so the first
# runs work immediately; you then register the repo with the broker for ongoing
# refresh (see docs/brutalist-review-setup.md → "Register a repo with the broker").
#
# Note on open-source repos: ChatGPT-plan auth in CI is ToS-grey for public
# repos. The broker model minimizes exposure (short-lived token, no refresh,
# fork-PRs blocked from secrets via the head.repo guard), but it's still your
# call — leave codex off and run it locally if you'd rather not.
#
# What this does (mechanical parts only):
#   1. sets the critic secrets on the target repo,
#   2. writes .github/workflows/brutalist-review.yml (pinned),
#   3. (codex mode) seeds CODEX_AUTH (refresh blanked) from a local auth.json.
#
# Manual prerequisites (browser-bound) are NOT done here — see the runbook.
#
# Usage (default, claude + agy):
#   ANTHROPIC_OAUTH_TOKEN=...  ./scripts/install-brutalist-review.sh <owner/repo>
#
# Usage (codex enabled — broker-push model):
#   ENABLE_CODEX=1  ANTHROPIC_OAUTH_TOKEN=...  CODEX_AUTH_FILE=~/.codex/auth.json \
#   ./scripts/install-brutalist-review.sh <owner/repo>
#   # then register <owner/repo> with the broker so the token stays fresh.
#
# Optional env:
#   AGY_FROM_KEYCHAIN 1 to extract the agy token from the macOS keychain
#                     (default: 1 on macOS, else 0)
#   AGY_TOKEN_FILE    raw JSON agy token file (alternative to keychain)
#   BRUTALIST_VERSION action/package version tag to pin (default: v1.14.7)
#   MIN_SEVERITY      inline-comment severity floor (default: medium)
#   ENABLE_CODEX      1 to add the codex critic (broker-push model) (default: 0)
#   CODEX_AUTH_FILE   local codex auth.json to seed CODEX_AUTH from
#                     (default: ~/.codex/auth.json)
#
# Secrets are always piped (never echoed). Re-running is idempotent.
set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" || "$REPO" != */* ]]; then
  echo "usage: $0 <owner/repo>   (e.g. $0 ejmockler/brutalist-mcp)" >&2
  exit 2
fi

VERSION="${BRUTALIST_VERSION:-v1.14.7}"
PKG_VERSION="${VERSION#v}"
MIN_SEVERITY="${MIN_SEVERITY:-medium}"
ENABLE_CODEX="${ENABLE_CODEX:-0}"
CODEX_AUTH_FILE="${CODEX_AUTH_FILE:-$HOME/.codex/auth.json}"

note() { printf '  %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
gh repo view "$REPO" >/dev/null 2>&1 || { echo "cannot access repo $REPO (check gh auth + permissions)" >&2; exit 1; }

CRITICS="claude + agy"
[[ "$ENABLE_CODEX" == "1" ]] && CRITICS="claude + codex + agy"
echo "Installing Brutalist Review ($VERSION) on $REPO — critics: $CRITICS"

if [[ "$ENABLE_CODEX" == "1" ]]; then
  IS_PRIVATE=$(gh repo view "$REPO" --json isPrivate --jq .isPrivate 2>/dev/null || echo "unknown")
  if [[ "$IS_PRIVATE" != "true" ]]; then
    warn "ENABLE_CODEX=1 on a NON-private repo ($REPO). The broker model blanks the"
    warn "refresh_token (CI holds only a ~10-day access token) and fork-PRs can't read"
    warn "secrets, but ChatGPT-plan auth in CI is still ToS-grey for open-source. Your call."
  fi
fi

# --- 1. secrets ------------------------------------------------------------
# claude (required)
if [[ -n "${ANTHROPIC_OAUTH_TOKEN:-}" ]]; then
  printf '%s' "$ANTHROPIC_OAUTH_TOKEN" | gh secret set ANTHROPIC_OAUTH_TOKEN --repo "$REPO"
  ok "ANTHROPIC_OAUTH_TOKEN set"
else
  warn "ANTHROPIC_OAUTH_TOKEN not provided — set it (claude setup-token) or the run fails preflight."
fi

# agy (optional critic)
if [[ -n "${AGY_TOKEN_FILE:-}" && -f "$AGY_TOKEN_FILE" ]]; then
  gh secret set AGY_OAUTH_TOKEN --repo "$REPO" < "$AGY_TOKEN_FILE"
  ok "AGY_OAUTH_TOKEN set (from $AGY_TOKEN_FILE)"
elif [[ "${AGY_FROM_KEYCHAIN:-$([[ $OSTYPE == darwin* ]] && echo 1 || echo 0)}" == "1" ]]; then
  if security find-generic-password -s gemini -a antigravity -w >/dev/null 2>&1; then
    security find-generic-password -s gemini -a antigravity -w \
      | sed 's/^go-keyring-base64://' | base64 -d \
      | gh secret set AGY_OAUTH_TOKEN --repo "$REPO"
    ok "AGY_OAUTH_TOKEN set (from macOS keychain)"
  else
    warn "agy keychain entry not found (run \`agy \"hi\"\` once) — agy critic will be skipped."
  fi
else
  note "agy token not provided — agy critic will be skipped (optional)."
fi

if [[ "$ENABLE_CODEX" == "1" ]]; then
  # codex (opt-in, broker-push model). Seed CODEX_AUTH with the refresh_token
  # BLANKED: CI must never refresh — the broker is the sole refresher of the
  # token lineage, and a second refresher would invalidate the chain (codex
  # refresh tokens are single-use with reuse-detection). The broker overwrites
  # this seed with a fresh token within its push interval.
  if [[ -f "$CODEX_AUTH_FILE" ]]; then
    node -e '
      const fs=require("fs");
      const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const t=a.tokens||{};
      if(!t.access_token){ console.error("codex auth.json has no access_token"); process.exit(1); }
      process.stdout.write(JSON.stringify({
        OPENAI_API_KEY: a.OPENAI_API_KEY ?? null,
        tokens: { id_token: t.id_token, access_token: t.access_token, refresh_token: "", account_id: t.account_id },
        last_refresh: a.last_refresh, auth_mode: "chatgpt",
      }));
    ' "$CODEX_AUTH_FILE" | gh secret set CODEX_AUTH --repo "$REPO"
    ok "CODEX_AUTH seeded (from $CODEX_AUTH_FILE, refresh_token blanked, auth_mode=chatgpt)"
    note "Register $REPO with the broker for ongoing refresh — see the runbook."
  else
    warn "CODEX_AUTH_FILE ($CODEX_AUTH_FILE) not found — codex critic will be skipped until"
    warn "the broker pushes CODEX_AUTH (see docs/brutalist-review-setup.md)."
  fi
fi

# --- 2. workflow -----------------------------------------------------------
WF=".github/workflows/brutalist-review.yml"
TMP=$(mktemp)

if [[ "$ENABLE_CODEX" == "1" ]]; then
cat > "$TMP" <<YML
name: Brutalist Review

# claude + codex + agy review on every PR, posted as inline comments.
# Codex auth: a broker (e.g. noot-1) pushes a fresh ChatGPT-plan access_token
# (refresh blanked) to the CODEX_AUTH secret out-of-band — no tailnet, no
# inbound, firewall-friendly. CI just reads it; codex never refreshes. The
# image_generation tool is disabled (codex#21952 gpt-image-2 bug).
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  brutalist:
    runs-on: ubuntu-latest
    timeout-minutes: 35
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install CLI critics
        run: |
          npm install -g @brutalist/mcp@${PKG_VERSION} \\
                         @anthropic-ai/claude-code \\
                         @openai/codex
          curl -fsSL https://antigravity.google/cli/install.sh | bash
          echo "\$HOME/.local/bin" >> "\$GITHUB_PATH"
          # codex: disable the broken built-in image_generation tool (gpt-image-2)
          mkdir -p "\$HOME/.codex"
          printf '[features]\\nimage_generation = false\\n' > "\$HOME/.codex/config.toml"
      - name: Brutalist review
        uses: ejmockler/brutalist-mcp/packages/github-action@${VERSION}
        env:
          BRUTALIST_TIMEOUT: "900000"
          BRUTALIST_ORCHESTRATOR_TIMEOUT_MS: "1500000"
        with:
          github-token: \${{ github.token }}
          anthropic-oauth-token: \${{ secrets.ANTHROPIC_OAUTH_TOKEN }}
          codex-auth: \${{ secrets.CODEX_AUTH }}
          agy-oauth-token: \${{ secrets.AGY_OAUTH_TOKEN }}
          minimum-severity: ${MIN_SEVERITY}
YML
else
cat > "$TMP" <<YML
name: Brutalist Review

# claude + agy review on every PR, posted as inline comments. Codex is run
# locally, not in CI. To add the codex critic via the broker-push model
# (ChatGPT-plan auth, no API key), re-run the installer with ENABLE_CODEX=1
# and register the repo with the broker — see docs/brutalist-review-setup.md.
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  brutalist:
    runs-on: ubuntu-latest
    timeout-minutes: 35
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install CLI critics
        run: |
          npm install -g @brutalist/mcp@${PKG_VERSION} @anthropic-ai/claude-code
          curl -fsSL https://antigravity.google/cli/install.sh | bash
          echo "\$HOME/.local/bin" >> "\$GITHUB_PATH"
      - name: Brutalist review
        uses: ejmockler/brutalist-mcp/packages/github-action@${VERSION}
        env:
          BRUTALIST_TIMEOUT: "900000"
          BRUTALIST_ORCHESTRATOR_TIMEOUT_MS: "1500000"
        with:
          github-token: \${{ github.token }}
          anthropic-oauth-token: \${{ secrets.ANTHROPIC_OAUTH_TOKEN }}
          agy-oauth-token: \${{ secrets.AGY_OAUTH_TOKEN }}
          minimum-severity: ${MIN_SEVERITY}
YML
fi

# Push the workflow via the API (uses the repo's default branch).
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
EXISTING_SHA=$(gh api "repos/$REPO/contents/$WF?ref=$DEFAULT_BRANCH" --jq .sha 2>/dev/null || true)
CONTENT=$(base64 < "$TMP" | tr -d '\n')
ARGS=(-f message="ci: install Brutalist Review ($VERSION, $CRITICS) on every PR" -f content="$CONTENT" -f branch="$DEFAULT_BRANCH")
[[ -n "$EXISTING_SHA" ]] && ARGS+=(-f sha="$EXISTING_SHA")
if gh api --method PUT "repos/$REPO/contents/$WF" "${ARGS[@]}" --jq '.commit.sha' >/dev/null 2>&1; then
  ok "workflow committed to $REPO@$DEFAULT_BRANCH:$WF"
else
  warn "could not push workflow (branch protection?). Add $WF manually — written to: $TMP"
fi

[[ -f "$TMP" ]] && rm -f "$TMP"
echo
ok "Done. Next PR on $REPO triggers the review ($CRITICS)."
note "See docs/brutalist-review-setup.md."
[[ "$ENABLE_CODEX" == "1" ]] && note "Codex stays fresh only once $REPO is registered with the broker (runbook)."
