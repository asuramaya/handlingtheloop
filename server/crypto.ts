// AES-GCM encryption for service tokens stored at rest in D1. Even though D1 is
// private to our Cloudflare account, the user's whole posture here is "minimize
// blast radius" — so OAuth refresh tokens never sit in the DB as plaintext.
//
// Key: TOKEN_ENC_KEY can be ANY non-empty secret string — we SHA-256 it into a
// 256-bit AES key, so there's no exact-length/base64 requirement. A long random
// value is still best:  openssl rand -base64 32
// Stored format: base64url(iv) + "." + base64url(ciphertext+tag).

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Decode to a freshly-allocated ArrayBuffer (a concrete BufferSource the
// WebCrypto typings accept without the Uint8Array<ArrayBufferLike> friction).
function ub64u(s: string): ArrayBuffer {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const arr = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) arr[i] = b.charCodeAt(i);
  return arr.buffer;
}

async function importKey(secret: string): Promise<CryptoKey> {
  // Derive a fixed 256-bit AES key from the secret via SHA-256, so any non-empty
  // TOKEN_ENC_KEY string is valid (no length/base64 constraints).
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(plain: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(plain);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data.buffer as ArrayBuffer);
  return `${b64u(iv)}.${b64u(new Uint8Array(ct))}`;
}

export async function decrypt(token: string, keyB64: string): Promise<string> {
  const [ivPart, ctPart] = token.split(".");
  if (!ivPart || !ctPart) throw new Error("malformed ciphertext");
  const key = await importKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64u(ivPart) }, key, ub64u(ctPart));
  return new TextDecoder().decode(pt);
}
