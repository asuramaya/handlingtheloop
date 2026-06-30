// Content moderation via Workers AI — a cheap, vendor-free, edge-inline gate run at WRITE time
// (avatar upload, profile save), never on read. Both checks FAIL OPEN: any model error, timeout,
// or an unbound `AI` (local dev) returns "not unsafe", so moderation can degrade but can never
// break an upload or a profile edit. It's a best-effort filter layered ON TOP of the deterministic
// slur blocklist (cleanProfile) + the magic-byte image validation, not a replacement for either.
import type { AiBinding } from "./db/core";

/** Zero-shot NSFW/violence gate for an uploaded avatar — a general vision model used as a yes/no
 *  classifier (no dedicated NSFW vendor). Returns true ⇒ BLOCK. */
export async function imageIsUnsafe(ai: AiBinding | undefined, bytes: Uint8Array): Promise<boolean> {
  if (!ai) return false;
  try {
    const r = (await ai.run("@cf/llava-1.5-7b-hf", {
      image: [...bytes],
      prompt:
        "Does this image contain pornography, nudity, sexual content, gore, graphic violence, or a hate symbol? Answer with only one word: YES or NO.",
      max_tokens: 5,
    })) as { description?: string; response?: string } | null;
    const out = String(r?.description ?? r?.response ?? "");
    return /\byes\b/i.test(out);
  } catch {
    return false; // fail open — never block an upload on a moderation hiccup
  }
}

/** Llama Guard 3 over user-set identity text (display name + bio). Purpose-built safety classifier;
 *  returns the unsafe verdict + violated category codes. Returns true ⇒ BLOCK. */
export async function textIsUnsafe(ai: AiBinding | undefined, text: string): Promise<boolean> {
  const t = text.trim();
  if (!ai || t.length < 2) return false;
  try {
    const r = (await ai.run("@cf/llama-guard-3-8b", {
      messages: [{ role: "user", content: t }],
    })) as { response?: string } | null;
    // Llama Guard replies "safe" or "unsafe\n<S-codes>". Treat a leading "unsafe" as a block.
    return /^\s*unsafe\b/i.test(String(r?.response ?? ""));
  } catch {
    return false;
  }
}
