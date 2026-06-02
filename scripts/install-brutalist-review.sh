#!/usr/bin/env bash
#
# install-brutalist-review.sh — add the Brutalist Review action to ANY GitHub
# repo in one shot. Default critics: claude + agy.
#
# Codex is OPT-IN (ENABLE_CODEX=1) and intended for PRIVATE repos only:
# OpenAI's CI auth guide forbids ChatGPT-plan auth.json on public/open-source
# repos, and codex-action is API-key-only (billing). On public repos, leave
# codex off and run it locally. See docs/brutalist-review-setup.md.
#
# What this does (mechanical parts only):
#   1. sets the critic secrets on the target repo,
#   2. writes .github/workflows/brutalist-review.yml (pinned),
#   3. (codex mode) sets the App secrets + verifies the App is installed.
#
# Manual prerequisites (browser-bound) are NOT done here — see the runbook.
#
# Usage (default, claude + agy):
#   ANTHROPIC_OAUTH_TOKEN=...  ./scripts/install-brutalist-review.sh <owner/repo>
#
# Usage (codex enabled — PRIVATE repos / self-hosted runner):
#   ENABLE_CODEX=1  ANTHROPIC_OAUTH_TOKEN=...  \
#   APP_ID=...  APP_PRIVATE_KEY_FILE=~/Downloads/*.pem  CODEX_AUTH_FILE=~/.codex/auth.json \
#   ./scripts/install-brutalist-review.sh <owner/repo>
#
# Optional env:
#   AGY_FROM_KEYCHAIN 1 to extract the agy token from the macOS keychain
#                     (default: 1 on macOS, else 0)
#   AGY_TOKEN_FILE    raw JSON agy token file (alternative to keychain)
#   BRUTALIST_VERSION action/package version tag to pin (default: v1.14.7)
#   MIN_SEVERITY      inline-comment severity floor (default: medium)
#   ENABLE_CODEX      1 to add the codex critic + self-healing App write-back
#                     + keep-warm job (default: 0)
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
    warn "ENABLE_CODEX=1 on a NON-private repo ($REPO). OpenAI's CI auth guide forbids"
    warn "ChatGPT-plan auth.json on public/open-source repos (token-exposure + account-"
    warn "suspension risk). Use a private repo / self-hosted runner, or run claude+agy only."
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

KEY_FILE=""
if [[ "$ENABLE_CODEX" == "1" ]]; then
  # codex (opt-in). Normalize auth_mode:"chatgpt"; keep refresh_token so the
  # write-back can maintain a CI-dedicated login's chain.
  if [[ -f "$CODEX_AUTH_FILE" ]]; then
    node -e '
      const fs=require("fs");
      const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const t=a.tokens||{};
      if(!t.access_token){ console.error("codex auth.json has no access_token"); process.exit(1); }
      process.stdout.write(JSON.stringify({
        OPENAI_API_KEY: a.OPENAI_API_KEY ?? null,
        tokens: { id_token: t.id_token, access_token: t.access_token, refresh_token: t.refresh_token ?? "", account_id: t.account_id },
        last_refresh: a.last_refresh, auth_mode: "chatgpt",
      }));
    ' "$CODEX_AUTH_FILE" | gh secret set CODEX_AUTH --repo "$REPO"
    ok "CODEX_AUTH set (from $CODEX_AUTH_FILE, auth_mode normalized)"
  else
    warn "CODEX_AUTH_FILE ($CODEX_AUTH_FILE) not found — codex critic will be skipped."
  fi
  # self-healing write-back App
  if [[ -n "${APP_ID:-}" ]]; then
    printf '%s' "$APP_ID" | gh secret set CODEX_AUTH_APP_ID --repo "$REPO"
    ok "CODEX_AUTH_APP_ID set"
    KEY_FILE="${APP_PRIVATE_KEY_FILE:-}"
    [[ -n "$KEY_FILE" ]] && KEY_FILE=$(ls $KEY_FILE 2>/dev/null | head -1 || true)
    if [[ -n "$KEY_FILE" && -f "$KEY_FILE" ]]; then
      gh secret set CODEX_AUTH_APP_PRIVATE_KEY --repo "$REPO" < "$KEY_FILE"
      ok "CODEX_AUTH_APP_PRIVATE_KEY set (from $KEY_FILE)"
    else
      warn "APP_PRIVATE_KEY_FILE not found — write-back stays inert."
    fi
  else
    note "APP_ID not provided — codex write-back inert (codex breaks when its token expires)."
  fi
fi

# --- 2. workflow -----------------------------------------------------------
WF=".github/workflows/brutalist-review.yml"
TMP=$(mktemp)

if [[ "$ENABLE_CODEX" == "1" ]]; then
cat > "$TMP" <<YML
name: Brutalist Review

# claude + codex + agy review on every PR. Codex uses ChatGPT-plan auth.json
# (private repos / self-hosted runners ONLY — see docs/brutalist-review-setup.md)
# with a self-healing GitHub App write-back + a keep-warm schedule.
on:
  pull_request:
    types: [opened, synchronize, reopened]
  schedule:
    - cron: '0 7 */5 * *'   # keep the codex token warm

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: brutalist-review-codex-auth
  cancel-in-progress: false

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
      - name: Detect codex write-back App
        id: appcheck
        env:
          APP_ID: \${{ secrets.CODEX_AUTH_APP_ID }}
        run: |
          if [ -n "\$APP_ID" ]; then echo "ready=true" >> "\$GITHUB_OUTPUT"; else echo "ready=false" >> "\$GITHUB_OUTPUT"; fi
      - name: Mint App token (ephemeral, 1h)
        id: app-token
        if: steps.appcheck.outputs.ready == 'true'
        uses: actions/create-github-app-token@v3
        with:
          app-id: \${{ secrets.CODEX_AUTH_APP_ID }}
          private-key: \${{ secrets.CODEX_AUTH_APP_PRIVATE_KEY }}
      - name: Install CLI critics
        run: |
          npm install -g @brutalist/mcp@${PKG_VERSION} \\
                         @anthropic-ai/claude-code \\
                         @openai/codex
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
          codex-auth: \${{ secrets.CODEX_AUTH }}
          agy-oauth-token: \${{ secrets.AGY_OAUTH_TOKEN }}
          minimum-severity: ${MIN_SEVERITY}
      - name: Persist refreshed codex OAuth token (self-healing)
        if: always() && steps.app-token.outputs.token != ''
        env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          AUTH="\$HOME/.codex/auth.json"
          if [ ! -f "\$AUTH" ]; then echo "No \$AUTH — skipping."; exit 0; fi
          if ! node -e "const t=require('\$AUTH')?.tokens?.refresh_token; if(!t)process.exit(1)" 2>/dev/null; then
            echo "auth.json has no refresh_token — skipping write-back."; exit 0
          fi
          gh secret set CODEX_AUTH --repo "\${{ github.repository }}" < "\$AUTH" \\
            && echo "Persisted refreshed CODEX_AUTH." || echo "::warning::write-back failed."

  codex-keepwarm:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - name: Detect codex write-back App
        id: appcheck
        env:
          APP_ID: \${{ secrets.CODEX_AUTH_APP_ID }}
        run: |
          if [ -n "\$APP_ID" ]; then echo "ready=true" >> "\$GITHUB_OUTPUT"; else echo "ready=false" >> "\$GITHUB_OUTPUT"; fi
      - name: Mint App token (ephemeral, 1h)
        id: app-token
        if: steps.appcheck.outputs.ready == 'true'
        uses: actions/create-github-app-token@v3
        with:
          app-id: \${{ secrets.CODEX_AUTH_APP_ID }}
          private-key: \${{ secrets.CODEX_AUTH_APP_PRIVATE_KEY }}
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install codex
        run: npm install -g @openai/codex
      - name: Provision + refresh codex token
        env:
          CODEX_AUTH: \${{ secrets.CODEX_AUTH }}
        run: |
          if [ -z "\$CODEX_AUTH" ]; then echo "No CODEX_AUTH — nothing to keep warm."; exit 0; fi
          mkdir -p "\$HOME/.codex"; printf '%s' "\$CODEX_AUTH" > "\$HOME/.codex/auth.json"; chmod 600 "\$HOME/.codex/auth.json"
          printf '%s' "reply with: warm" | codex exec --sandbox read-only --skip-git-repo-check 2>&1 | tail -5 || true
      - name: Persist refreshed codex OAuth token
        if: always() && steps.app-token.outputs.token != ''
        env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
        run: |
          AUTH="\$HOME/.codex/auth.json"
          if [ ! -f "\$AUTH" ]; then echo "No \$AUTH — skipping."; exit 0; fi
          if ! node -e "const t=require('\$AUTH')?.tokens?.refresh_token; if(!t)process.exit(1)" 2>/dev/null; then
            echo "auth.json has no refresh_token — skipping."; exit 0
          fi
          gh secret set CODEX_AUTH --repo "\${{ github.repository }}" < "\$AUTH" \\
            && echo "Kept CODEX_AUTH warm." || echo "::warning::keep-warm write-back failed."
YML
else
cat > "$TMP" <<YML
name: Brutalist Review

# claude + agy review on every PR, posted as inline comments. Codex is run
# locally, not in CI (OpenAI forbids ChatGPT-plan auth.json on public repos;
# codex-action is API-key-only). To enable codex on a private repo /
# self-hosted runner, re-run the installer with ENABLE_CODEX=1.
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

# --- 3. (codex mode) verify App installation ------------------------------
if [[ "$ENABLE_CODEX" == "1" && -n "${APP_ID:-}" && -n "$KEY_FILE" && -f "$KEY_FILE" ]]; then
  INSTALLED=$(node -e '
    const fs=require("fs"),crypto=require("crypto"),https=require("https");
    const pem=fs.readFileSync(process.argv[1],"utf8"), appId=process.argv[2], repo=process.argv[3];
    const now=Math.floor(Date.now()/1000), b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
    const h=b64({alg:"RS256",typ:"JWT"}), p=b64({iat:now-60,exp:now+540,iss:Number(appId)});
    const s=crypto.sign("RSA-SHA256",Buffer.from(h+"."+p),pem).toString("base64url");
    https.request({host:"api.github.com",path:`/repos/${repo}/installation`,headers:{Authorization:`Bearer ${h}.${p}.${s}`,Accept:"application/vnd.github+json","User-Agent":"install"}},
      r=>process.stdout.write(String(r.statusCode))).end();
  ' "$KEY_FILE" "$APP_ID" "$REPO" 2>/dev/null || echo "err")
  if [[ "$INSTALLED" == "200" ]]; then ok "GitHub App is installed on $REPO"
  else warn "GitHub App NOT installed on $REPO (HTTP $INSTALLED). Install: https://github.com/settings/apps"; fi
fi

rm -f "$TMP"
echo
ok "Done. Next PR on $REPO triggers the review ($CRITICS)."
note "See docs/brutalist-review-setup.md. Codex-in-CI (ENABLE_CODEX=1) is for private repos only."
