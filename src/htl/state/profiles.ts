// Shared codec for the named-profile systems (colour themes, keyboard profiles, MIDI maps).
// Each of those is a saved, account-synced, shareable bundle; they differ only in their
// payload + validation. This collapses the three identical uid / export / parse trios into
// one envelope layer. The per-type VALIDATION stays in each module's `sanitize` closure —
// that's the part that legitimately differs (which keys to keep, default name, fresh id).

export function uid(prefix = "p"): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Wrap a payload object in the shared {kind, version, [payloadKey]: obj} envelope — pretty
// JSON for clipboard / file. `kind` stays distinct per type ("htl-color-profile" etc.).
export function exportEnvelope<T>(kind: string, version: number, payloadKey: string, obj: T): string {
  return JSON.stringify({ kind, version, [payloadKey]: obj }, null, 2);
}

// Parse shared text → the inner payload, run through `sanitize`. Backward-compatible: accepts
// the enveloped form {kind, [payloadKey]} OR a bare payload object (matching the old
// parseMap / parseColorProfile fallback), so existing exports still import. Returns null on
// anything malformed.
export function parseEnvelope<T>(
  kind: string,
  payloadKey: string,
  text: string,
  sanitize: (raw: unknown) => T | null,
): T | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const inner = o && o.kind === kind && o[payloadKey] != null ? o[payloadKey] : o;
    return sanitize(inner);
  } catch {
    return null;
  }
}
