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

/** Stored free-text (titles/artists): strip control chars, collapse, clamp length. */
export function cleanText(s: unknown, maxLen: number): string {
  return String(s ?? "")
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
//   - script-src: app bundle ('self') + onnxruntime from jsdelivr; 'wasm-unsafe-eval'
//     for the in-browser stem WASM; blob: for the worker/AudioWorklet bootstraps.
//   - connect-src https: — model weights (huggingface.co + its LFS CDNs) and the
//     ORT wasm fetch land on shifting hosts; the real guard is script-src.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/** Baseline response headers stamped on the SPA document alongside the CSP. */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), browsing-topics=()",
};
