// Framework-free security helpers shared by the Worker (worker/index.ts), the
// Node dev server (server/api.ts), and the admin worker (server/admin.ts). Pure
// functions only — no Request/Response coupling except the small `clientIp`/`allow`
// pair — so they're trivially unit-testable (see server/security.test.ts).

/** HTML-escape safe for BOTH text and (quoted) attribute contexts: & < > " '.
 *  The previous admin esc() escaped only <>& and rendered thumbnails inside a
 *  double-quoted attribute, so a `"` in attacker-controlled metadata broke out. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

// The ONLY Content-Type we ever serve a cached stem with. We never replay the
// uploader's Content-Type (that let an attacker host text/html on our origin).
// Stems are self-describing binary (the client sniffs the magic header, not this),
// so a fixed opaque type is safe and decodes identically.
export const STEM_DOWNLOAD_CONTENT_TYPE = "application/octet-stream";

/** Headers that stop a binary response from ever being interpreted as an inline
 *  document (nosniff) and force a download rather than render-on-navigation. */
export const DOWNLOAD_SAFE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "content-disposition": "attachment",
};

/** Magic-byte sniff: does this look like an audio container we actually produce
 *  or could legitimately cache? Producers are htl-Opus ("HTO1") and WAV
 *  ("RIFF"…"WAVE"); common containers are tolerated. HTML/JS/SVG payloads have
 *  none of these signatures, so they're rejected at upload. */
export function looksLikeAudioStem(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const at = (i: number, s: string): boolean => {
    for (let k = 0; k < s.length; k++) if (bytes[i + k] !== s.charCodeAt(k)) return false;
    return true;
  };
  if (at(0, "HTO1")) return true; // htl-Opus (src/htl/stems/opus.ts)
  if (at(0, "RIFF") && at(8, "WAVE")) return true; // WAV
  if (at(0, "OggS")) return true; // Ogg (Opus/Vorbis)
  if (at(0, "fLaC")) return true; // FLAC
  if (at(0, "ID3")) return true; // MP3 with ID3v2
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true; // raw MPEG audio frame
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true; // Matroska/WebM
  if (at(4, "ftyp")) return true; // MP4 / M4A
  return false;
}

/** Keep only real http(s) URLs; everything else (javascript:, data:, vbscript:,
 *  relative, garbage) → null. Used for stored thumbnails. */
export function sanitizeHttpUrl(s: unknown, maxLen = 400): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().slice(0, maxLen);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? t : null;
  } catch {
    return null;
  }
}

/** Sniff an uploaded avatar by MAGIC BYTES (never trust the client content-type). Returns the
 *  canonical content-type for the real format, or null if it isn't a supported image. Serving by
 *  the sniffed type + nosniff prevents a polyglot/HTML-as-image from ever executing. */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  // RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  return null;
}

/** Identity/presentation text (display name, bio, room/set title) — cleanText PLUS the slur
 *  blocklist mask, so harassment/doxx slurs don't render verbatim in public search/cards. */
export function cleanProfile(s: unknown, maxLen: number): string {
  return cleanChat(cleanText(s, maxLen));
}

/** Stored free-text (titles/artists): NFKC-normalize, strip control + zero-width/bidi chars,
 *  collapse, clamp. NFKC + bidi-strip kill homoglyph/RTL display spoofing in names. */
export function cleanText(s: unknown, maxLen: number): string {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Clamp to a finite number in [min,max], or null if not a usable number. Keeps
 *  fractional precision (BPM/beat-offset are fractional). */
export function clampNum(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

// ── Public handles (the social layer's @identity) ───────────────────────────
// v1: ascii [A-Za-z0-9_], 3-20 chars. Case is PRESERVED for display; uniqueness
// is checked on the NFKC+lowercase FOLD (so `Hector` and `hector` collide).
// Unicode handles are deliberately deferred — they invite homoglyph impersonation
// (Cyrillic `а` vs Latin `a`), which a single-script ascii rule sidesteps.
export const HANDLE_MIN = 3;
export const HANDLE_MAX = 20;
// Minimum time between handle RENAMES (first claim is always free). Stops
// flip-flopping to dodge blocks/links and frees the old handle slowly. Local dev
// shares this; delete `.dev-data/user.json` to reset while testing.
export const HANDLE_RENAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Reserved handles: app route names (so a handle can't shadow /api, /room …),
 *  impersonation targets, and a small profanity seed. Checked against the FOLD. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // routes / system
  "api", "auth", "me", "room", "rooms", "admin", "login", "logout", "signin",
  "signout", "settings", "about", "help", "support", "terms", "privacy", "legal",
  "static", "assets", "public", "dist", "favicon", "robots", "sitemap", "ws",
  "health", "status", "search", "explore", "live", "home", "app", "new",
  // identity / impersonation
  "official", "staff", "team", "mod", "mods", "moderator", "moderators", "system",
  "htl", "handlingtheloop", "user", "users", "account", "accounts", "anonymous",
  "anon", "guest", "everyone", "here", "all", "null", "undefined", "none",
  // profanity seed (extend server-side as needed)
  "fuck", "shit", "cunt", "nigger", "faggot", "rape",
]);

/** NFKC-normalize + lowercase — the canonical key a handle is unique on. */
export function foldHandle(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

export type HandleResult =
  | { ok: true; handle: string; folded: string }
  | { ok: false; reason: string };

/** Validate a requested handle. Returns the cleaned (case-preserved) handle plus
 *  its fold on success, or a user-facing reason on failure. The fold is what the
 *  DB's UNIQUE index is enforced on; never check availability on the raw form. */
export function validateHandle(raw: unknown): HandleResult {
  const handle = String(raw ?? "").trim();
  if (!handle) return { ok: false, reason: "handle required" };
  if (handle.length < HANDLE_MIN) return { ok: false, reason: `at least ${HANDLE_MIN} characters` };
  if (handle.length > HANDLE_MAX) return { ok: false, reason: `at most ${HANDLE_MAX} characters` };
  if (!/^[A-Za-z0-9_]+$/.test(handle)) return { ok: false, reason: "letters, numbers and _ only" };
  const folded = foldHandle(handle);
  if (RESERVED_HANDLES.has(folded)) return { ok: false, reason: "that handle is reserved" };
  if (handleHasSlur(folded)) return { ok: false, reason: "that handle isn't allowed" };
  return { ok: true, handle, folded };
}

// Slurs unambiguous enough to match as a SUBSTRING of a handle (no innocent word contains them),
// so "niggerbot"/"faggot69" are caught. Ambiguous terms (rape/coon/spic/cunt → grape/raccoon/
// spice/scunthorpe) are matched whole-token-ish instead, to dodge the Scunthorpe problem.
const HARD_SLURS = ["nigger", "nigga", "faggot", "kike", "tranny", "wetback", "chink"];

/** Does a single token (handle/username) carry a slur? Two folds, because they catch different
 *  evasions: the LEET fold (n1gg3r→nigger, f4gg0t→faggot) and a RAW letters-only strip
 *  (rapist1→rapist, where leet would wrongly map the digit). Substring for the hard set,
 *  whole-token (+plural) for the ambiguous rest so the Scunthorpe problem stays avoided. */
export function handleHasSlur(token: string): boolean {
  const leet = foldToken(token); // leetspeak un-substituted
  const raw = token.toLowerCase().replace(/[^a-z]/g, ""); // digits/symbols dropped, no leet
  if (!leet && !raw) return false;
  if (HARD_SLURS.some((s) => leet.includes(s) || raw.includes(s))) return true;
  const hit = (w: string) => !!w && (CHAT_BLOCKLIST.has(w) || CHAT_BLOCKLIST.has(w.replace(/s$/, "")));
  return hit(leet) || hit(raw);
}

// Chat slur/profanity blocklist (L3). Severe terms only — masked, not dropped, so a line
// still posts but censored; the host mute/ban handles repeat offenders. Matched per WHOLE
// token (with leetspeak fold + simple plural), NOT substring — so "grape"/"therapy" are safe
// from the "rape" entry (the Scunthorpe problem). Extend server-side as needed.
export const CHAT_BLOCKLIST: ReadonlySet<string> = new Set([
  "nigger", "nigga", "faggot", "fag", "cunt", "rape", "rapist", "retard",
  "kike", "spic", "chink", "tranny", "wetback", "coon",
]);

const LEET: Record<string, string> = { "4": "a", "@": "a", "8": "b", "3": "e", "1": "i", "!": "i", "0": "o", "5": "s", "$": "s", "7": "t" };

// Fold a token to its comparable form: lowercase, common leetspeak un-substituted, non-letters
// stripped. "F4gg0t!" → "faggot". Used only for the blocklist check, never for display.
function foldToken(t: string): string {
  return t.toLowerCase().replace(/[4@83105$!7]/g, (c) => LEET[c] ?? c).replace(/[^a-z]/g, "");
}

/** Mask blocklisted slurs in a chat line (L3). Whole-token match (fold + trailing-s plural);
 *  a hit becomes a run of • of the original length. Returns the cleaned, display-safe text. */
export function cleanChat(text: string): string {
  return text.replace(/\S+/g, (tok) => {
    const f = foldToken(tok);
    const base = f.replace(/s$/, "");
    if (f && (CHAT_BLOCKLIST.has(f) || CHAT_BLOCKLIST.has(base))) return "•".repeat(Math.max(3, tok.length));
    return tok;
  });
}

/** Best-effort client IP for rate-limit keys (Cloudflare edge sets cf-connecting-ip). */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "anon";
}

/** Cloudflare Workers Rate Limiting binding shape (configured in wrangler.jsonc). */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

/** Consult a rate limiter if one is bound; true = allowed. Absent binding (plain
 *  `vite` dev, or not yet provisioned) or any limiter error → allowed, so a
 *  misconfiguration can never take the route down. */
export async function allow(rl: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!rl) return true;
  try {
    return (await rl.limit({ key })).success;
  } catch {
    return true;
  }
}

// Content-Security-Policy for the SPA document (production Worker only — Vite dev
// keeps its own headers). The load-bearing directives are script-src WITHOUT
// 'unsafe-inline' (so an injected <script> can't run), object-src 'none', and
// base-uri 'self'. img/style/connect stay permissive to avoid breaking the app's
// cross-origin thumbnails, inline React styles, and model/runtime downloads.
//   - script-src: app bundle + onnxruntime ('self' — ORT is now self-hosted under
//     /ort/, no third-party CDN); 'wasm-unsafe-eval' for the in-browser stem WASM;
//     blob: for the worker/AudioWorklet bootstraps. NO external script origin.
//   - connect-src https: — model weights (huggingface.co + its LFS CDNs) land on
//     shifting hosts; the ORT wasm is same-origin now. The real guard is script-src.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self' https://asuramaya.com",
  "form-action 'self'",
].join("; ");

/** Baseline response headers stamped on the SPA document alongside the CSP. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  // microphone=(self): output-device SELECTION needs it — enumerateDevices only fills
  //   in real deviceIds/labels for audiooutput once an audio permission is granted, and
  //   the cue/output picker reveals names via a one-shot getUserMedia (immediately
  //   stopped, never recorded). microphone=() (empty) blocked that at the policy layer,
  //   so device routing silently no-op'd. speaker-selection=(self): lets setSinkId /
  //   selectAudioOutput route to a chosen device. Both same-origin only; geo/camera/
  //   topics stay fully disabled.
  "permissions-policy": "geolocation=(), microphone=(self), camera=(), browsing-topics=(), speaker-selection=(self)",
};
