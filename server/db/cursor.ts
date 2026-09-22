// The keyset cursor codec, in ONE place.
//
// Two directory reads page this way (live rooms, published sets) and a third will. The encoding was
// written once inside rooms.ts as private helpers; copying it into sets.ts would have been the
// cheapest thing to do and the start of the usual story — two copies that agree today, drift on the
// first change, and a reader who checks one of them and stops.
//
// ★ BASE64URL IS NOT SECRECY AND THIS DOES NOT PRETEND IT IS. Anyone who wants the payload can
// decode it in one line. What it buys is honest and smaller: the cursor stops LOOKING parseable, so
// no client grows code that splits it and then breaks when the key changes, and an internal id no
// longer sits in plain sight in URLs, logs and referrers — which is where casual leakage actually
// happens. Tamper-EVIDENCE would be an HMAC with a key to manage, and neither of today's payloads
// is a credential.
//
// ★ A MALFORMED CURSOR READS AS NO CURSOR. A browse surface shows its first page on a typo; it does
// not 400, and it never binds NaN and silently matches nothing, which looks exactly like an empty
// directory.

const SEP = ":"; // inside the encoding only — never seen by a client

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): string | null {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null; // not valid base64 → not one of ours → treated as no cursor
  }
}

/** Encode a keyset boundary: a numeric sort key plus the unique id that breaks its ties. */
export function encodeKeyset(sortKey: number, id: string): string {
  return b64url(`${sortKey}${SEP}${id}`);
}

/** Decode a keyset boundary, or null for anything that is not one of ours. */
export function decodeKeyset(c: string | null | undefined): { sortKey: number; id: string } | null {
  if (!c) return null;
  const raw = unb64url(c);
  if (!raw) return null;
  // Split on the FIRST separator only, so an id containing one survives the round trip. Otherwise
  // page 2 decodes to a truncated id, matches nothing, and looks exactly like "the directory ended".
  const i = raw.indexOf(SEP);
  if (i <= 0) return null;
  const sortKey = Number(raw.slice(0, i));
  const id = raw.slice(i + 1);
  if (!Number.isFinite(sortKey) || !id) return null;
  return { sortKey, id };
}
