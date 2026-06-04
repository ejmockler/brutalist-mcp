#!/usr/bin/env python3
# codex token broker — reference implementation.
#
# Holds ONE codex (ChatGPT-plan) login, is the SOLE refresher of its token
# lineage, and serves a fresh access_token over your private network. Consumers
# (your laptop's codex + CI's codex) fetch tokens here and NEVER refresh, so the
# single-use rotating refresh chain never desyncs (codex reuse-detection would
# otherwise revoke the whole family). See docs/brutalist-review-setup.md §3.
#
# Bind to a PRIVATE address ONLY — your VPN/Tailscale IP, or 127.0.0.1. NEVER
# 0.0.0.0. Access is gated by a shared key in broker.key (X-Broker-Key header).
#
# Env:
#   BROKER_BIND_IP  address to bind (default 127.0.0.1; set to your tailnet IP
#                   to serve other machines on the VPN)
#   BROKER_PORT     port (default 8080)
#   BROKER_HOME     dir holding auth.json + broker.key (default: this file's dir)
#
# Files in BROKER_HOME:
#   auth.json   the ONE codex login — copy of ~/.codex/auth.json after `codex login`
#   broker.key  shared secret — generate: openssl rand -hex 32 > broker.key && chmod 600 broker.key
import json, time, base64, os, threading, urllib.request, http.server

HOME = os.environ.get("BROKER_HOME") or os.path.dirname(os.path.abspath(__file__))
AUTH = os.path.join(HOME, "auth.json")
KEY = open(os.path.join(HOME, "broker.key")).read().strip()
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"   # codex's public OAuth client id (not a secret)
TOKEN_URL = "https://auth.openai.com/oauth/token"
BIND_IP = os.environ.get("BROKER_BIND_IP", "127.0.0.1")
PORT = int(os.environ.get("BROKER_PORT", "8080"))
BUFFER = 600  # refresh when <10 min to access-token expiry
_lock = threading.Lock()

def log(m):
    with open(os.path.join(HOME, "broker.log"), "a") as f:
        f.write("%s %s\n" % (time.strftime("%FT%TZ", time.gmtime()), m))

def claims(jwt):
    try:
        p = jwt.split(".")[1]; p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))
    except Exception:
        return {}

def load():
    with open(AUTH) as f: return json.load(f)

def save(a):
    tmp = AUTH + ".tmp"
    with open(tmp, "w") as f: json.dump(a, f)
    os.replace(tmp, AUTH); os.chmod(AUTH, 0o600)

def access_exp(a): return claims(a["tokens"].get("access_token", "")).get("exp", 0)

def account_id(a):
    t = a["tokens"]
    auth = claims(t.get("id_token", "")).get("https://api.openai.com/auth", {}) or {}
    return auth.get("chatgpt_account_id") or t.get("account_id", "")

def refresh(a):
    body = json.dumps({
        "client_id": CLIENT_ID, "grant_type": "refresh_token",
        "refresh_token": a["tokens"]["refresh_token"],
        "scope": "openid profile email offline_access",
    }).encode()
    req = urllib.request.Request(TOKEN_URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    a["tokens"]["access_token"] = d["access_token"]
    if d.get("refresh_token"): a["tokens"]["refresh_token"] = d["refresh_token"]
    if d.get("id_token"): a["tokens"]["id_token"] = d["id_token"]
    a["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    save(a)
    log("refreshed: new access exp %s" % access_exp(a))
    return a

def get_token(force=False):
    with _lock:
        a = load()
        if force or access_exp(a) - time.time() < BUFFER:
            a = refresh(a)
        return {"access_token": a["tokens"]["access_token"],
                "id_token": a["tokens"].get("id_token", ""),
                "account_id": account_id(a), "exp": access_exp(a)}

class H(http.server.BaseHTTPRequestHandler):
    def _send(self, code, obj):
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.end_headers(); self.wfile.write(json.dumps(obj).encode())
    def do_GET(self):
        path = self.path.split("?")[0]
        if path not in ("/token", "/token/force", "/health"):
            return self._send(404, {"error": "not found"})
        if path == "/health":
            return self._send(200, {"ok": True})
        if self.headers.get("X-Broker-Key", "") != KEY:
            log("DENIED bad-key from %s" % self.client_address[0])
            return self._send(403, {"error": "forbidden"})
        try:
            self._send(200, get_token(force=(path == "/token/force")))
        except Exception as e:
            log("ERROR %r" % e); self._send(500, {"error": str(e)})
    def log_message(self, *a): pass

if __name__ == "__main__":
    log("starting on %s:%d" % (BIND_IP, PORT))
    http.server.HTTPServer((BIND_IP, PORT), H).serve_forever()
