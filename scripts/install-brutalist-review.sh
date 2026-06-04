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
#   MIN_SEVERITY      inline-comment severity floor: nit|low|medium|high|critical
#                     (default: medium)
#   ENABLE_CODEX      1 to add the codex critic (broker-push model) (default: 0)
#   ALLOW_PUBLIC_CODEX 1 to allow ENABLE_CODEX on a PUBLIC repo (required there —
#                      ChatGPT-plan auth in public CI is ToS-grey + collaborator-
#                      exfiltratable; see the runbook) (default: 0)
#   CODEX_AUTH_FILE   local codex auth.json to seed CODEX_AUTH from
#                     (default: ~/.codex/auth.json)
#   ACTION_SHA / CLAUDE_CLI_VERSION / CODEX_CLI_VERSION  override the pinned
#                     action commit + critic CLI versions (advanced; keep in sync)
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

# Pin the action to an IMMUTABLE commit SHA, not the mutable VERSION tag — the
# action receives every OAuth token (github/anthropic/codex/agy), so a moved tag
# or a compromised tag-ref would hand an attacker all of them. ACTION_SHA MUST be
# the commit the VERSION tag points at — when bumping, set both and verify with:
#   git rev-parse <VERSION>^{commit}   (must equal ACTION_SHA)
ACTION_SHA="${ACTION_SHA:-15cedc8159a54662fa741395746d4aa0e161a3b4}"  # = v1.14.7
# Pin the critic CLIs (supply-chain: an unpinned @latest install runs BEFORE the
# secrets are present, but the planted binary persists and later receives tokens).
CLAUDE_CLI_VERSION="${CLAUDE_CLI_VERSION:-2.1.162}"
CODEX_CLI_VERSION="${CODEX_CLI_VERSION:-0.136.0}"

# Validate operator-supplied values before they are interpolated into the
# generated YAML (a poisoned env must not be able to inject workflow content).
# Version pins require >=2 dot-separated numbers (reject bare ints / trailing /
# double dots). MIN_SEVERITY mirrors the action's SeverityFilter (incl. 'nit').
[[ "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]                 || { echo "bad BRUTALIST_VERSION: $VERSION" >&2; exit 2; }
[[ "$ACTION_SHA" =~ ^[0-9a-f]{40}$ ]]                          || { echo "bad ACTION_SHA: $ACTION_SHA" >&2; exit 2; }
[[ "$MIN_SEVERITY" =~ ^(nit|low|medium|high|critical)$ ]]      || { echo "bad MIN_SEVERITY: $MIN_SEVERITY (nit|low|medium|high|critical)" >&2; exit 2; }
[[ "$CLAUDE_CLI_VERSION" =~ ^[0-9]+(\.[0-9]+)+$ ]]             || { echo "bad CLAUDE_CLI_VERSION: $CLAUDE_CLI_VERSION" >&2; exit 2; }
[[ "$CODEX_CLI_VERSION" =~ ^[0-9]+(\.[0-9]+)+$ ]]              || { echo "bad CODEX_CLI_VERSION: $CODEX_CLI_VERSION" >&2; exit 2; }

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
    # Codex on a PUBLIC repo is a real ToS boundary, not a style preference:
    # ChatGPT-plan auth in open-source CI risks account suspension, and ANY
    # write-access collaborator can exfiltrate CODEX_AUTH (the head.repo guard
    # only blocks forks). Require an explicit affirmative flag, not a silent
    # opt-in — the broker model lowers blast radius but does not erase it.
    if [[ "${ALLOW_PUBLIC_CODEX:-0}" != "1" ]]; then
      warn "REFUSING codex on NON-private repo ($REPO): ChatGPT-plan auth in public CI is"
      warn "ToS-grey (account-suspension risk) and any write-access collaborator can exfiltrate"
      warn "CODEX_AUTH. Re-run with ALLOW_PUBLIC_CODEX=1 to proceed deliberately, or omit"
      warn "ENABLE_CODEX to run claude+agy and keep codex local."
      exit 2
    fi
    warn "proceeding with codex on PUBLIC repo $REPO (ALLOW_PUBLIC_CODEX=1) — blast radius is"
    warn "your ChatGPT account; refresh is blanked (10-day cap) and fork PRs get no secrets."
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
    # Decode into a var first so a base64 failure (raw/non-encoded entry) WARNS
    # and skips the optional critic instead of aborting the whole install under
    # `set -o pipefail`, and so we never set an empty AGY_OAUTH_TOKEN secret.
    AGY_RAW=$(security find-generic-password -s gemini -a antigravity -w \
                | sed 's/^go-keyring-base64://' | base64 -d 2>/dev/null) || AGY_RAW=""
    if [[ -n "$AGY_RAW" ]]; then
      printf '%s' "$AGY_RAW" | gh secret set AGY_OAUTH_TOKEN --repo "$REPO"
      ok "AGY_OAUTH_TOKEN set (from macOS keychain)"
    else
      warn "agy keychain entry could not be decoded — agy critic will be skipped."
    fi
    unset AGY_RAW
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
  #
  # CONTRACT: this relies on codex NOT attempting a refresh when refresh_token is
  # "" (empirically validated, and the reason CODEX_CLI_VERSION is pinned — a
  # future codex could change this). If it ever does refresh, the review degrades
  # gracefully: the codex critic fails legibly ("CODEX OAuth token expired") and
  # claude+agy still post — it does not break the whole review.
  if [[ -f "$CODEX_AUTH_FILE" ]]; then
    node -e '
      const fs=require("fs");
      const a=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const t=a.tokens||{};
      if(!t.access_token){ console.error("codex auth.json has no access_token"); process.exit(1); }
      // NEVER propagate a local OPENAI_API_KEY into a public-repo secret — the
      // broker model is OAuth-only. Force null. Default id_token/account_id to
      // "" so JSON.stringify does not silently DROP missing keys (codex then
      // gets a malformed auth.json and fails).
      process.stdout.write(JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: { id_token: t.id_token ?? "", access_token: t.access_token, refresh_token: "", account_id: t.account_id ?? "" },
        last_refresh: a.last_refresh ?? null, auth_mode: "chatgpt",
      }));
    ' "$CODEX_AUTH_FILE" | gh secret set CODEX_AUTH --repo "$REPO"
    ok "CODEX_AUTH seeded (from $CODEX_AUTH_FILE, refresh_token blanked, auth_mode=chatgpt)"
    note "Register $REPO with the broker for ongoing refresh — see the runbook."
  else
    warn "CODEX_AUTH_FILE ($CODEX_AUTH_FILE) not found — codex critic will be skipped until"
    warn "the broker pushes CODEX_AUTH (see docs/brutalist-review-setup.md)."
  fi
elif gh secret list --repo "$REPO" 2>/dev/null | awk '{print $1}' | grep -qx CODEX_AUTH; then
  # Re-running without ENABLE_CODEX=1 does NOT silently disable codex: the secret
  # (and any broker registration) persist. Surface that so it isn't a footgun.
  warn "codex is disabled this run, but a CODEX_AUTH secret still EXISTS on $REPO."
  warn "To fully remove codex: gh secret delete CODEX_AUTH --repo $REPO (+ unregister it from the broker)."
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
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '20'
      - name: Install CLI critics
        run: |
          npm install -g @brutalist/mcp@${PKG_VERSION} \\
                         @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \\
                         @openai/codex@${CODEX_CLI_VERSION}
          # NOTE: the agy installer is unpinned upstream (no published checksum) —
          # residual supply-chain surface; it runs before any secret is present.
          curl -fsSL https://antigravity.google/cli/install.sh | bash
          echo "\$HOME/.local/bin" >> "\$GITHUB_PATH"
          # codex: disable the broken built-in image_generation tool (gpt-image-2)
          mkdir -p "\$HOME/.codex"
          printf '[features]\\nimage_generation = false\\n' > "\$HOME/.codex/config.toml"
      - name: Brutalist review
        uses: ejmockler/brutalist-mcp/packages/github-action@${ACTION_SHA} # ${VERSION}
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
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '20'
      - name: Install CLI critics
        run: |
          npm install -g @brutalist/mcp@${PKG_VERSION} @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}
          # NOTE: agy installer is unpinned upstream (no published checksum) — residual supply-chain surface.
          curl -fsSL https://antigravity.google/cli/install.sh | bash
          echo "\$HOME/.local/bin" >> "\$GITHUB_PATH"
      - name: Brutalist review
        uses: ejmockler/brutalist-mcp/packages/github-action@${ACTION_SHA} # ${VERSION}
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
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name // ""')
if [[ -z "$DEFAULT_BRANCH" ]]; then
  warn "no default branch on $REPO (empty repo?) — push an initial commit, then re-run."
  warn "workflow written to: $TMP"
  exit 1
fi
EXISTING_SHA=$(gh api "repos/$REPO/contents/$WF?ref=$DEFAULT_BRANCH" --jq .sha 2>/dev/null || true)
CONTENT=$(base64 < "$TMP" | tr -d '\n')
ARGS=(-f message="ci: install Brutalist Review ($VERSION, $CRITICS) on every PR" -f content="$CONTENT" -f branch="$DEFAULT_BRANCH")
[[ -n "$EXISTING_SHA" ]] && ARGS+=(-f sha="$EXISTING_SHA")
if gh api --method PUT "repos/$REPO/contents/$WF" "${ARGS[@]}" --jq '.commit.sha' >/dev/null 2>&1; then
  ok "workflow committed to $REPO@$DEFAULT_BRANCH:$WF"
  rm -f "$TMP"
else
  # Keep $TMP on failure — the operator needs it to add the workflow by hand.
  warn "could not push workflow (branch protection?). Add $WF manually from: $TMP"
fi
echo
ok "Done. Next PR on $REPO triggers the review ($CRITICS)."
note "See docs/brutalist-review-setup.md."
[[ "$ENABLE_CODEX" == "1" ]] && note "Codex stays fresh only once $REPO is registered with the broker (runbook)."
