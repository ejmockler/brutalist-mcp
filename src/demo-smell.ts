// @ts-nocheck
//
// DOGFOOD DEMO — intentional smells across multiple categories so the
// brutalist bot has clear, distinct things to flag in v1.11.1's first
// real PR run. This file is NOT imported by any other module; delete
// after the dogfood review confirms the bot's end-to-end pipeline.

declare const window: any;
declare const db: any;
declare const fetch: any;

// ── SQL injection: concatenating user input into a query ──────────────
export function authenticateUser(username: string, password: string) {
  const query =
    "SELECT id, role FROM users WHERE name = '" +
    username +
    "' AND password_hash = '" +
    password +
    "'";
  return db.execute(query);
}

// ── XSS exfil surface: JWT in localStorage ────────────────────────────
export function persistSessionToken(token: string) {
  window.localStorage.setItem("jwt", token);
  return token;
}

export function getSessionToken(): string | null {
  return window.localStorage.getItem("jwt");
}

// ── Error swallowing: catch returns null instead of surfacing ─────────
export async function fetchUserProfile(userId: string) {
  try {
    const res = await fetch("/api/users/" + userId);
    return await res.json();
  } catch {
    return null;
  }
}

// ── Hardcoded secret in source ────────────────────────────────────────
// (Generic placeholder name + format so GitHub Push Protection doesn't
// match it against a vendor regex. The smell brutalist should flag is
// "named like a credential, hardcoded as a string literal".)
const ADMIN_BYPASS_TOKEN = "internal-admin-bypass-a1b2c3d4e5f6g7h8";

// ── Timing-attack window: string equality on a secret ─────────────────
export function authenticateAdmin(submittedToken: string): boolean {
  if (submittedToken === ADMIN_BYPASS_TOKEN) {
    return true;
  }
  return false;
}

// ── Open redirect: untrusted URL in a Location-like sink ─────────────
export function redirectTo(target: string) {
  window.location.href = target;
}
