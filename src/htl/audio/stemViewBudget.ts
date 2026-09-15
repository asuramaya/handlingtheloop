// THE STEM-VIEW WIRE BUDGET — one invariant, two owners, so it lives in neither of them.
//
// ★ WHY THIS FILE EXISTS. server/room.ts bounded the stemview envelope at a hand-written
// `size <= 400_000`. That number encodes something the CLIENT owns: how large an envelope
// extractStemView can actually produce, which is set by the bucket clamp in Deck.ts. A constant in
// the server asserting an invariant owned by the client is a closed-world claim spelled
// numerically — it is correct only until someone changes the clamp, and then it is silently wrong
// in whichever direction hurts. So the ceiling is DERIVED here from the clamp itself, and both
// sides import it. Same reasoning as digestKey.ts: shared truth belongs to neither caller.
//
// It could not live in Deck.ts regardless. Not because Deck.ts touches browser globals at module
// scope — it does not; its four `AudioContext` references are a type annotation and two comments —
// but because importing it drags LoopEngine, JogEngine, pcmMeter and the rest of the audio graph
// into a Worker that has no business loading any of it.
//
// ★ THE PROBLEM THE BOUND ACTUALLY SOLVES, which is NOT bandwidth on the stream. room.ts admits a
// frame to `lastStemView` under the SAME `if` that relays it, and the rate limit is per
// sender:deck. But lastStemView is replayed by sendCatchUp to EVERY arriving socket, forever, with
// no rate limit and no size check. So the cost is frames × JOINERS, and joiners are not in the
// sender's rate budget: ONE frame passing the limit ONCE sets a per-arrival tax paid by everyone
// thereafter. Rate-limiting a write whose effect is persistent. Measured: at a 293 KB/deck payload
// every arrival was handed 600.6 KB, linear in crowd size, three for three.
//
// ★ ONE THRESHOLD, NOT TWO. A tempting fix is to cache-admit at a small size and relay-admit at a
// large one. That institutionalises a band of sizes where an arrival's view PERMANENTLY differs
// from a live peer's — and nothing on either side can tell. Making that divergence merely
// observable is instrumentation standing in for a fix. A frame too large to cache is too large to
// relay, because relaying it is what creates the divergence.
//
// ★ IT FAILS CLOSED, AND THE DIRECTION IS DELIBERATE. An over-large envelope is dropped for
// everyone, so a remote waveform goes ABSENT — visibly broken, and a user reports it. The
// alternative failure is a STALE same-song envelope: a waveform that no longer matches the audio
// playing, which nobody reports because it still looks like a waveform. Silent wrongness is worse
// than visible absence.
//
// ★★ OPERATIONAL RULE, AND IT IS TWO-PHASE. The envelope is produced by the HOST'S BROWSER, which
// may be an hours-old tab talking to a freshly deployed Worker. Old client + new server is always
// fine (its envelopes are smaller). The dangerous order is the reverse: a RAISED clamp reaching
// clients before the server's bound rises drops every envelope ENTIRELY, live peers included.
// So, whenever these numbers go up:
//     1. raise MAX_STEMVIEW_BYTES on the SERVER, deploy it, confirm it is live;
//     2. only then raise MAX_BUCKETS / BAND_BUCKETS on the client.
// Backwards blacks out every remote waveform in every session at once.

/** Buckets per stem lane, the clamp extractStemView applies regardless of track length
 *  (`minBucket = max(1024, ceil(length / MAX_BUCKETS))` — it caps the COUNT, not the resolution). */
export const MAX_BUCKETS = 4500;

/** Coarse band-energy resolution shipped over the wire, per band. */
export const BAND_BUCKETS = 768;

/** Lanes in a separation. Imported rather than assumed: a fifth stem would change the ceiling. */
export const STEM_LANES = 4;

/** Bands per stem (low/mid/high). */
export const BANDS_PER_STEM = 3;

/** base64 length for n bytes — 4 chars per 3 bytes, padded up. */
const b64Len = (n: number): number => Math.ceil(n / 3) * 4;

/** The largest envelope this client can produce for ONE deck, derived rather than measured.
 *  Per stem: min+max lanes (2 × MAX_BUCKETS int8) plus 3 band lanes (BAND_BUCKETS int8 each),
 *  each base64'd. At the current constants: 4 × (12,000 + 3,072) = 60,288 chars ≈ 61 KB. */
export const STEMVIEW_PAYLOAD_CEILING = STEM_LANES * (b64Len(2 * MAX_BUCKETS) + BANDS_PER_STEM * b64Len(BAND_BUCKETS));

/** JSON structure around the payload — keys, quotes, braces, the numeric fields. Generous: the
 *  envelope is a handful of short keys per stem, so this is headroom, not an estimate to tune. */
export const STEMVIEW_ENVELOPE_OVERHEAD = 4096;

/** A Durable Object value is capped at 128 KiB. room.ts states this in three places, and today the
 *  admitted envelope could exceed it — which is why persistStemViews has an "oversized lives in
 *  memory only" path at all. */
export const DO_VALUE_CAP = 128 * 1024;

/** Headroom over the derived ceiling, so a modest client-side change does not instantly black out
 *  remote waveforms — the failure the two-phase rule above exists to manage. */
const HEADROOM = 2;

/** What the SERVER admits, for both relay and cache.
 *
 *  Derived from the client's own clamp, then CLAMPED TO THE DO CAP rather than merely landing
 *  under it. At today's constants the derivation gives 128,768 and the cap 131,072, so the min is
 *  the derivation — but that is arithmetic luck, and a later bucket change would silently push an
 *  admitted envelope past what the DO can store. Writing the min makes "everything admitted is
 *  also persistable" a PROPERTY instead of a coincidence, which in turn means the oversized
 *  in-memory-only path can eventually retire rather than lurking as a second code path nobody
 *  exercises.
 *
 *  Anything above this cannot have been produced by this client — which is what makes dropping it
 *  safe rather than merely convenient. */
export const MAX_STEMVIEW_BYTES = Math.min((STEMVIEW_PAYLOAD_CEILING + STEMVIEW_ENVELOPE_OVERHEAD) * HEADROOM, DO_VALUE_CAP);
