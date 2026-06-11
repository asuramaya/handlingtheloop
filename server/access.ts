// Cloudflare Access verification for the admin worker. Access gates the subdomain
// at the edge (only allowed identities ever reach the worker); we ALSO verify the
// injected JWT here so the worker can't be reached by bypassing Access (e.g. a
// direct workers.dev hit, or a forged header). Fails CLOSED — any missing config,
// bad signature, wrong audience, or off-allowlist email denies.

export interface AccessEnv {
  CF_ACCESS_TEAM_DOMAIN?: string; // e.g. "yourteam.cloudflareaccess.com"
  CF_ACCESS_AUD?: string; // the Access application's Audience (AUD) tag
  ADMIN_EMAILS?: string; // comma-separated allowlist of admin emails
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}
let jwksCache: { keys: Jwk[]; at: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  const j = (await res.json()) as { keys?: Jwk[] };
  jwksCache = { keys: j.keys ?? [], at: Date.now() };
  return jwksCache.keys;
}

export type AccessResult = { ok: true; email: string } | { ok: false; reason: string };
const tail = (s: string | undefined, n = 8) => (s ? "…" + s.slice(-n) : "∅");

/** Verify the Cloudflare Access JWT. Returns the admin email, or a failure reason
 *  (only ever seen by a request that already passed Access — safe to surface). */
export async function verifyAccess(req: Request, env: AccessEnv): Promise<AccessResult> {
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!team || !aud) return { ok: false, reason: `not configured (TEAM_DOMAIN=${!!team}, AUD=${!!aud})` };

  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, reason: "no Cf-Access-Jwt-Assertion header — Access isn't injecting a JWT to the worker" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed JWT" };

  try {
    const header = b64urlToJson<{ kid: string; alg: string }>(parts[0]);
    const payload = b64urlToJson<{ aud?: string | string[]; email?: string; exp?: number; iss?: string }>(parts[1]);

    const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (!auds.includes(aud)) return { ok: false, reason: `aud mismatch: token=[${auds.map((a) => tail(a)).join(",")}] expected=${tail(aud)}` };
    if (!payload.exp || payload.exp * 1000 < Date.now()) return { ok: false, reason: "token expired" };
    if (payload.iss && payload.iss !== `https://${team}`) return { ok: false, reason: `iss mismatch: got '${payload.iss}' expected 'https://${team}'` };

    const email = (payload.email || "").toLowerCase();
    if (!email) return { ok: false, reason: "no email claim in token" };
    const allow = (env.ADMIN_EMAILS || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (allow.length && !allow.includes(email)) return { ok: false, reason: `email '${email}' not in ADMIN_EMAILS (${allow.length} entries)` };

    const jwk = (await getJwks(team)).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: `signing key ${tail(header.kid)} not found in JWKS` };
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as unknown as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig = b64urlToBytes(parts[2]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig as BufferSource, data as BufferSource);
    return ok ? { ok: true, email } : { ok: false, reason: "signature invalid" };
  } catch (e) {
    return { ok: false, reason: "verify error: " + (e as Error).message };
  }
}
