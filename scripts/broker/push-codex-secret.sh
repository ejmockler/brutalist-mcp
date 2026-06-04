#!/usr/bin/env bash
# Push a fresh codex access_token (refresh_token BLANKED) to the CODEX_AUTH
# secret on each target repo. OUTBOUND only — works from behind a firewall with
# no inbound, no CI runner on your VPN. The broker host is the SOLE refresher;
# CI reads the secret and never refreshes, so the lineage never desyncs.
#
# Env:
#   REPOS        space-separated owner/repo list to push to (REQUIRED)
#   BROKER_URL   broker base URL (default http://127.0.0.1:8080 — set to the
#                broker's VPN IP:port if running this from another host)
#   BROKER_HOME  dir holding broker.key (default: this script's dir)
#
# Requires: `gh` authenticated with Secrets:write on each repo, and python3.
set -euo pipefail
REPOS="${REPOS:?set REPOS to a space-separated list of owner/repo}"
HOMEDIR="${BROKER_HOME:-$(cd "$(dirname "$0")" && pwd)}"
BROKER_URL="${BROKER_URL:-http://127.0.0.1:8080}"
KEY=$(cat "$HOMEDIR/broker.key")

RESP=$(curl -fsS -m 30 -H "X-Broker-Key: $KEY" "$BROKER_URL/token/force")
# Pass the response on STDIN, not argv — argv is world-visible in `ps`/`/proc`,
# and $RESP holds the live access_token. (NB: `python3 - <<PY` can't be used here
# — the heredoc would claim stdin and json.load would get EOF; the program goes in
# -c, the data on stdin, exactly like the EXP line below.)
AUTH=$(printf '%s' "$RESP" | python3 -c '
import sys, json, time
r = json.load(sys.stdin)
print(json.dumps({
  "OPENAI_API_KEY": None,
  "tokens": {"id_token": r.get("id_token", ""), "access_token": r["access_token"],
             "refresh_token": "", "account_id": r.get("account_id", "")},
  "last_refresh": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
  "auth_mode": "chatgpt",
}))
')
EXP=$(printf "%s" "$RESP" | python3 -c "import sys,json,time; print(time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime(json.load(sys.stdin)['exp'])))")
for repo in $REPOS; do
  printf "%s" "$AUTH" | gh secret set CODEX_AUTH --repo "$repo"
  echo "pushed CODEX_AUTH -> $repo (access_token exp $EXP)"
done
