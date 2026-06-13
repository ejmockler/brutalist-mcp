# codex token broker — reference implementation

The durable way to run the **codex** critic in CI on your **ChatGPT plan** (no
OpenAI API key) without your laptop's codex and CI fighting over the one login.

## Why this exists

A ChatGPT-plan codex login is singular and self-rotating:

- **One active grant per account** — a second `codex login` revokes the first.
- **Single-use refresh tokens with reuse-detection** — two independent refreshers
  on the same lineage invalidate the whole chain (`refresh_token_reused`).

So you can't just drop `~/.codex/auth.json` into a CI secret and let CI refresh
it: CI and your laptop would both refresh and both break. **The broker makes
exactly one process the refresher.** An always-on host holds the one login and
is the sole refresher; everyone else (laptop + CI) only *consumes* short-lived
access tokens with the `refresh_token` blanked, which codex accepts and which
can't desync anything.

```
broker host (always-on, behind a firewall — outbound only)
  broker.py            ── holds the ONE login; sole refresher; serves /token over your VPN
  push-codex-secret.sh ── every ~4 days (timer): refresh, blank refresh_token,
                          `gh secret set CODEX_AUTH --repo <each repo>`   ──► GitHub secret
  laptop ── pulls a fresh access_token from the broker over your VPN
GitHub Actions ── reads CODEX_AUTH → ~/.codex/auth.json → codex exec  (never refreshes)
```

Outbound-only, so it works behind a firewall with no inbound and **no CI runner
on your VPN**. The CI secret holds only a ~10-day access token (no refresh), and
fork PRs don't receive secrets.

## Files

| File | Role |
|------|------|
| `broker.py` | The broker: holds `auth.json`, sole refresher, serves `/token` (key-gated, private bind). |
| `push-codex-secret.sh` | Force-refresh + `gh secret set CODEX_AUTH` on each repo in `REPOS`. |
| `systemd/codex-broker.service` | Run the broker as a user service (survives logout via linger). |
| `systemd/codex-push.service` + `.timer` | Run the push every 4 days. |

## Setup (on the always-on broker host)

```bash
mkdir -p ~/codex-broker && cp broker.py push-codex-secret.sh ~/codex-broker/
chmod +x ~/codex-broker/push-codex-secret.sh

# 1. The one login + the shared key
codex login                                   # then:
cp ~/.codex/auth.json ~/codex-broker/auth.json
chmod 600 ~/codex-broker/auth.json
openssl rand -hex 32 > ~/codex-broker/broker.key && chmod 600 ~/codex-broker/broker.key

# 2. Broker as a user service (set BROKER_BIND_IP to your VPN IP to serve peers)
cp systemd/codex-broker.service ~/.config/systemd/user/
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now codex-broker.service
curl -fsS -H "X-Broker-Key: $(cat ~/codex-broker/broker.key)" http://127.0.0.1:8080/token | head -c 80

# 3. The 4-day push (edit REPOS in the unit first)
cp systemd/codex-push.service systemd/codex-push.timer ~/.config/systemd/user/
$EDITOR ~/.config/systemd/user/codex-push.service     # set REPOS="owner/repo ..."
systemctl --user daemon-reload
systemctl --user enable --now codex-push.timer
systemctl --user start codex-push.service             # push once now
```

`gh` on the broker host must be authenticated with **Secrets: write** on each
target repo.

## Register another repo

Add it to `REPOS` in `~/.config/systemd/user/codex-push.service` (or pass inline)
and push once:

```bash
REPOS="owner/repo-a owner/repo-b" ~/codex-broker/push-codex-secret.sh
```

## Optional: point your laptop at the broker

So local codex also rides the one lineage (never refreshes), add a pull on a
schedule (launchd/cron) that writes `~/.codex/auth.json` with the refresh blanked:

```bash
curl -fsS -H "X-Broker-Key: $KEY" "$BROKER_URL/token" | \
  python3 -c 'import sys,json; r=json.load(sys.stdin); print(json.dumps({"OPENAI_API_KEY":None,"tokens":{"id_token":r["id_token"],"access_token":r["access_token"],"refresh_token":"","account_id":r["account_id"]},"auth_mode":"chatgpt"}))' \
  > ~/.codex/auth.json
```

## Security notes

- **Bind privately.** `BROKER_BIND_IP` must be a VPN/loopback address, never
  `0.0.0.0`. Access is additionally gated by `broker.key`.
- **Public repos.** Putting a ChatGPT-plan token in a public repo's secret is
  ToS-grey; the broker minimizes blast radius (short-lived token, no refresh,
  fork PRs blocked) but any **write-access collaborator** on a target repo can
  exfiltrate `CODEX_AUTH`. Use a dedicated account or keep codex off repos whose
  collaborators you don't fully trust.
- **`client_id`** in `broker.py` is codex's public OAuth client id (baked into
  the codex binary), not a secret.
