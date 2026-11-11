// sessionFollow — the PURE decision core of the inbound session-sync follower (useSessionSync).
//
// The follower side of a shared room makes three subtle, bug-prone decisions on every snapshot /
// tick. Historically they lived inline inside useSessionSync's engine-side-effecting callbacks,
// which (running inside a React hook against the live AudioEngine) can't be unit-tested. These
// functions are the decisions ONLY — no engine, no refs, no time source (the caller passes elapsed
// ms in) — so they're deterministic and exhaustively testable. useSessionSync calls them and then
// performs the side effect the returned action names. See sessionFollow.test.ts for the encoded
// bug scenarios (loops-forever, skip-on-join, only-pull-forward, grace window, load dedupe).

// ── Tick drift-correction thresholds ────────────────────────────────────────────────────────────
// A flip (play↔pause) seeks to the master only when we're off by more than this — a tiny drift on a
// flip isn't worth a source rebuild (audible).
export const FLIP_SEEK_DRIFT = 0.05;
// While both are PLAYING, a tick is a stale snapshot of a moving clock, so a follower naturally runs
// a little ahead (network latency) — we must only ever pull FORWARD when genuinely behind by more
// than this, never backward (the "loops a second forever, never catches up" bug). Seconds.
export const BEHIND_THRESHOLD = 0.6;
// Minimum gap between catch-up seeks while playing — prevents back-to-back yanks. Milliseconds.
export const SEEK_GRACE_MS = 1200;
// Both PAUSED → a seek is silent (no source rebuild), so align tightly. Seconds.
export const PAUSED_ALIGN_DRIFT = 0.12;
// A deck the anchor is actively ticking is "tick-driven"; the post-decode join fallback must NOT
// start it from a stale snapshot position (the tick will start it fresh). Milliseconds.
export const TICK_DRIVING_MS = 1000;

// What onRoomTick should do for one deck given the master's tick and our local deck state.
export type FollowAction =
  | { kind: "start"; seek: boolean } // master plays, we're paused → resume+play (seek-first if drifted)
  | { kind: "stop"; seek: boolean } //  master paused, we play → pause (land on master pos if drifted)
  | { kind: "catchup" } //             both playing, we've fallen behind past grace → seek forward, reset grace
  | { kind: "align" } //               both paused, drifted → silent reposition (no grace reset)
  | { kind: "hold" }; //               in sync (or a mere lead) → do nothing

export interface FollowTickInput {
  masterPlaying: boolean;
  deckPlaying: boolean;
  deckPos: number; // our current playhead, seconds
  masterPos: number; // the tick's authoritative playhead, seconds
  sinceFollowSeekMs: number; // ms since our last follow-driven seek (now - followSeekAt)
}

// Mirror the master's transport + correct drift for ONE deck. The caller has already established the
// deck has a buffer and isn't being locally scrubbed. Pure: maps (master, local) → one action.
export function decideFollowTick(p: FollowTickInput): FollowAction {
  const drift = Math.abs(p.deckPos - p.masterPos);
  if (p.masterPlaying && !p.deckPlaying) return { kind: "start", seek: drift > FLIP_SEEK_DRIFT };
  if (!p.masterPlaying && p.deckPlaying) return { kind: "stop", seek: drift > FLIP_SEEK_DRIFT };
  if (p.deckPlaying) {
    // Both playing. behind > 0 = we're behind the (already stale) tick. Only correct a real lag,
    // never a lead, and not more than once per grace window.
    const behind = p.masterPos - p.deckPos;
    if (behind > BEHIND_THRESHOLD && p.sinceFollowSeekMs > SEEK_GRACE_MS) return { kind: "catchup" };
    return { kind: "hold" };
  }
  // Both paused → a tight align is silent.
  return drift > PAUSED_ALIGN_DRIFT ? { kind: "align" } : { kind: "hold" };
}

// What applyRoomSnapshot should do for one deck. The snapshot may (re)load a changed track, reconcile
// an already-loaded track's discrete state ONCE, or skip — guarded so a duplicate snapshot can't load
// twice (load dedupe) nor a republished snapshot stomp live edits (reconcile dedupe).
export type SnapshotDeckAction = "load" | "reconcile" | "skip";

export interface SnapshotDeckInput {
  snapVideoId: string | null; // the track the master has on this deck
  loadedId: string | null; //    what we currently have decoded
  roomLoadTarget: string | null; // a room-driven load already in flight for this deck
  loadingVid: string; //         the id currently decoding ("" = none)
  reconciledTarget: string | null; // the id whose discrete state we've already reconciled
}

export function decideSnapshotDeck(p: SnapshotDeckInput): SnapshotDeckAction {
  const v = p.snapVideoId;
  if (!v) return "skip";
  // A genuinely new track for this deck that isn't already loaded / loading / targeted → load once.
  if (v !== p.loadedId && v !== p.roomLoadTarget && v !== p.loadingVid) return "load";
  // Already showing it but not yet reconciled → mirror its cue/loop/stem/fx state once.
  if (v === p.loadedId && p.reconciledTarget !== v) return "reconcile";
  return "skip";
}

// The post-decode join fallback: once a remote-driven track finishes decoding, a late joiner can sit
// decoded-but-paused if no tick flips it — so start it from the snapshot transport, UNLESS the anchor
// is actively ticking this deck (its flip branch will start fresh at the live position; starting here
// from the now-stale snapshot pos would get yanked an instant later — the audible skip on join).
export interface JoinStartInput {
  snapPlaying: boolean; //     the snapshot says this deck is playing
  deckPlaying: boolean; //     our just-decoded deck's state
  sinceLastTickMs: number; //  ms since the anchor last ticked this deck (now - lastTickAt)
}

export function shouldStartOnDecode(p: JoinStartInput): boolean {
  const tickDriving = p.sinceLastTickMs < TICK_DRIVING_MS;
  return p.snapPlaying && !p.deckPlaying && !tickDriving;
}

// ── Track-identity divergence (the "shared board, wrong song" guard) ──────────────────────────────
// The FLOOR between reload attempts while a deck is diverged and NOTHING is loading the anchor's
// track. Each further attempt doubles (see resyncBackoffMs). Milliseconds.
export const RESYNC_RETRY_MS = 3000;
// The ceiling that doubling stops at. A diverged deck keeps trying forever, just not faster than
// this. Milliseconds.
export const RESYNC_BACKOFF_CAP_MS = 30000;
// How long to tolerate an in-flight load of the anchor's track before assuming a stuck load-guard
// and forcing a fresh attempt — long enough that a genuine slow-link (4G) load completes first. Ms.
// Measured from the LOAD's own last sign of life (its claim, then every chunk, the decode and the
// analysis), never from the last resync: the question is whether THIS load is stuck, and the resync
// clock cannot answer it. A slow load that keeps receiving is not stuck, however long it takes.
export const RESYNC_STUCK_MS = 15000;

/** How long to wait before the Nth consecutive resync attempt on one deck: 3 s, 6 s, 12 s, 24 s,
 *  capped. A self-heal that retries at a FIXED rate forever is a livelock generator by
 *  construction — if a load takes longer than the interval, every attempt cancels the one before it
 *  and the deck never lands (ruling ab419a94, where that ran ~1 run in 3 on a desktop with a warm
 *  cache; a phone on 4G with a cold cache is the population it would hurt most). Backing off is
 *  correct on every device without knowing how long a load takes there, which is why it is the fix
 *  rather than a bigger constant: no measurement taken on one machine can be trusted for the
 *  machine this actually hurts. */
export function resyncBackoffMs(attempts: number): number {
  const n = Math.max(0, attempts - 1);
  return Math.min(RESYNC_RETRY_MS * 2 ** Math.min(n, 20), RESYNC_BACKOFF_CAP_MS);
}

// A follower's per-deck action once the anchor stamps track identity on the tick (DeckTick.vid).
// `tickVid` is the videoId the anchor holds on this deck; `loadedId` is what the follower actually
// has. Match (or an old anchor that doesn't stamp) → drive normally. Otherwise the deck has
// DIVERGED — a load was lost/failed on a flaky link — and must NOT be driven (applying the anchor's
// playhead/transport to the wrong buffer is the bug). Self-heal by reloading the anchor's track,
// throttled, with a force path that defeats a stuck load-guard.
export type TickResync =
  | "drive" //       identity matches (or can't tell) → run the normal tick logic
  | "wait" //        diverged, but a load is in flight / within the retry throttle → hold, don't drive
  | "load" //        diverged, nothing loading this vid, throttle elapsed → start a reload
  | "force-load"; // diverged, a load has been "in flight" too long (stuck guard) → reset + reload

export interface TickResyncInput {
  tickVid: string | null | undefined; // the anchor's loaded videoId for this deck (absent on old anchors)
  loadedId: string | null; //           what the follower currently holds
  inFlightForMs: number | null; //      age of an in-flight load of tickVid on this deck; null = none
  sinceResyncMs: number | null; //      now − the last resync attempt; null = never attempted
  attempts: number; //                  consecutive resync attempts on this deck since it last landed
}

// ★ THE GUARD IS THE INVARIANT, NOT THE CLOCK. A live in-flight load of the anchor's track means
// WAIT, whatever any interval says — the only thing that overrides it is that load being stuck, and
// that is measured from the load's own start. The old shape asked "has the retry interval elapsed?"
// while a load was running, and a load slower than the interval was cancelled and restarted forever
// (ruling ab419a94). With ownership of the in-flight claim now honest (App/loadClaim.ts), this
// question is answerable, and the retry constant stops being load-bearing: it only governs how soon
// we try again after a load genuinely ENDED.
//
// ★ AND AN UNSET CLOCK IS "NEVER", NOT "ANCIENT". `sinceResyncMs` used to arrive as
// `performance.now() − (resyncAt ?? 0)`, so a deck that had never resynced reported the tab's whole
// uptime — an absence rendered as a very large number, which crossed every threshold it was
// compared against (thread 1d40b603). null says the one thing the sentinel could not.
export function decideTickResync(p: TickResyncInput): TickResync {
  if (p.tickVid == null || p.tickVid === p.loadedId) return "drive"; // identity matches / can't tell
  if (p.inFlightForMs != null) return p.inFlightForMs >= RESYNC_STUCK_MS ? "force-load" : "wait";
  if (p.sinceResyncMs == null) return "load"; // never tried on this deck → first attempt is immediate
  return p.sinceResyncMs >= resyncBackoffMs(p.attempts) ? "load" : "wait";
}

// ── A deck that holds the wrong track (join window, lost load) ───────────────────────────────────
// ★ A FOLLOWER MUST NOT SOUND A TRACK THE SESSION IS NOT PLAYING. decideTickResync stops the TICK
// from driving a diverged deck, but nothing stopped the deck itself: a guest who pressed play on its
// own board while knocking kept playing it, inside the session, until the host's track replaced it
// (setBuffer stops it, then the tick starts the right one: a song, a stop and a start on join). And
// a host's play / seek / hot-cue intent arriving while the host's track is still downloading was
// applied to whatever buffer the deck held, sounding the guest's old track. Both are the same fact:
// the deck's buffer is not the session's.
export interface DeckIdentityInput {
  loadedId: string | null; //         what the deck holds
  tickVid: string | null | undefined; // what the anchor last said it holds on this deck (absent on old anchors)
  roomLoadTarget: string | null; //   a room-driven (or our own shared) load in flight / landed for this deck
}

/** The deck holds a track other than the session's: the anchor names another one, or a room load is
 *  replacing it. Our OWN shared load (roomLoadTarget === loadedId, a co-DJ who just picked a track
 *  the anchor has not landed yet) is not foreign. */
export function holdsForeignTrack(p: DeckIdentityInput): boolean {
  if (p.roomLoadTarget != null && p.roomLoadTarget === p.loadedId) return false;
  if (p.roomLoadTarget != null && p.roomLoadTarget !== p.loadedId) return true;
  return p.tickVid != null && p.tickVid !== p.loadedId;
}

/** Intents that make a deck SOUND or move its playhead. Applied to a foreign buffer they play the
 *  wrong song; the tick follower starts the right one at the live position once it lands. */
export function isAudibleDeckIntent(kind: string, action?: string): boolean {
  if (kind === "transport") return true;
  if (kind === "hotcue") return action === "press";
  return false;
}

// ── Half-open socket detection (the 4G stall) ─────────────────────────────────────────────────────
// A flaky link can STALL a socket without firing `onclose`: it looks online while silently dropping
// everything the host sends. Only a JOINED FOLLOWER can rely on a steady inbound stream (the anchor
// ticks ~4/s + presence), so silence for `staleMs` means the socket is dead and must be torn down
// to force a reconnect → resync. The anchor itself, a lone session, or a passive listener may
// legitimately be quiet, so they never trip this. `lastRecvAt === 0` = nothing received yet on this
// connection (let `welcome` land first).
export interface SocketStaleInput {
  online: boolean; //      status === "online"
  hasSocket: boolean; //   a live, non-closed socket exists
  follower: boolean; //    joined AND a remote anchor exists (anchorId set and not us)
  lastRecvAt: number; //   wall-clock ms of the last inbound message (0 = none yet)
  now: number;
  staleMs: number;
}

export function isSocketStale(p: SocketStaleInput): boolean {
  if (!p.online || !p.hasSocket || !p.follower || p.lastRecvAt === 0) return false;
  return p.now - p.lastRecvAt >= p.staleMs;
}

// A stem we ourselves touched within this window is left alone, so our own in-flight change isn't
// briefly stomped by a slightly-stale echo of the anchor's authoritative state. Milliseconds.
export const STEM_TOUCH_GRACE_MS = 400;

// Per-stem convergence on a tick that carries the anchor's authoritative stem mixer state. Decides,
// for ONE stem, whether to re-apply the gain and/or the mute — idempotently (only when a value
// actually moved) and never within the touch-grace. Pure: the caller reads/writes the deck.
export interface StemConvergeInput {
  sinceTouchMs: number; // ms since we last touched this stem (now - stemTouch[id][name])
  masterGain: number | null | undefined; // the anchor's gain for this stem (absent on some ticks)
  masterMuted: boolean; // the anchor's mute for this stem
  localLevel: number; // our current stem gain (deck.stemLevel)
  localActive: boolean; // our current state: true = audible (NOT muted) — deck.stemActive
}

export function decideStemConverge(p: StemConvergeInput): { setGain: boolean; setMute: boolean } {
  if (p.sinceTouchMs < STEM_TOUCH_GRACE_MS) return { setGain: false, setMute: false };
  const setGain = p.masterGain != null && p.localLevel !== p.masterGain;
  // active === muted means our audible-state disagrees with the anchor's desired mute → flip it.
  // (active=true & want-muted=true → mute; active=false & want-muted=false → unmute.)
  const setMute = p.localActive === p.masterMuted;
  return { setGain, setMute };
}

// ── Timed follow (a tick stamped with the room clock) ────────────────────────────────────────────
// ★ Operator, 2026-11-10: "maintaining the best possible alignment in audio between host and
// clients". Once a tick says WHEN its position was true (DeckTick.at, room-server ms) and both
// sides report what they actually HEAR (playhead minus output + buffer latency), the follower knows
// its real error in both directions, not a stale snapshot's. Small errors glide out with a
// speed trim the ear does not notice (DJ sync's own method); large ones seek, ahead or behind.
/** Beyond this error (s) a playing follower seeks instead of gliding. */
export const TIMED_SEEK_ERR = 0.12;
/** Within this (smoothed) error (s) nothing is done: below what an ear hears between two speakers,
 *  and above the audio clock's own read jitter (a render quantum, ~3 ms, more on some devices). A
 *  4 ms band had the trim flipping ±0.3 % every second chasing that jitter (measured, two headless
 *  devices): a faint pitch wobble with key lock off. */
export const TIMED_DEADBAND = 0.008;
/** The follower's speed trim: fraction of rate per second of error, and its ceiling. */
export const TIMED_TRIM_GAIN = 0.3;
/** Smoothing of the error the trim acts on: new = old·(1−a) + err·a per tick (4/s → ~1 s memory). */
export const TIMED_ERR_ALPHA = 0.3;
export const TIMED_TRIM_MAX = 0.015;

export type TimedFollowAction =
  | { kind: "start"; target: number } //  master plays, we're paused → seek to target, play
  | { kind: "stop"; target: number } //   master paused, we play → pause, land on target
  | { kind: "seek"; target: number } //   both playing, off by more than TIMED_SEEK_ERR → seek
  | { kind: "trim"; trim: number } //     both playing, small error → glide (0 = on time)
  | { kind: "align"; target: number } //  both paused and apart → silent reposition
  | { kind: "hold" };

export interface TimedFollowInput {
  masterPlaying: boolean;
  deckPlaying: boolean;
  /** Where the host is AUDIBLY now (track s): tick pos + elapsed room time × rate. */
  masterNow: number;
  /** Our engine playhead (track s). */
  deckPos: number;
  /** Our own audible latency in track seconds (latency × rate): what we hear trails deckPos by it. */
  deckLatency: number;
  sinceFollowSeekMs: number;
  /** The error smoothed over recent ticks (s, + = ahead), for the trim; absent = this tick's own. */
  smoothErr?: number;
}

export function decideTimedFollow(p: TimedFollowInput): TimedFollowAction {
  // The engine position at which we would HEAR exactly what the host is heard playing now.
  const target = p.masterPlaying ? p.masterNow + p.deckLatency : p.masterNow;
  if (p.masterPlaying && !p.deckPlaying) return { kind: "start", target };
  if (!p.masterPlaying && p.deckPlaying) return { kind: "stop", target };
  if (!p.deckPlaying) return Math.abs(p.deckPos - target) > PAUSED_ALIGN_DRIFT ? { kind: "align", target } : { kind: "hold" };
  const err = p.deckPos - target; // > 0: we are AHEAD of the host
  if (Math.abs(err) > TIMED_SEEK_ERR) return p.sinceFollowSeekMs > SEEK_GRACE_MS ? { kind: "seek", target } : { kind: "hold" };
  const e = p.smoothErr ?? err; // the trim acts on the smoothed error; the seek on the raw one
  if (Math.abs(e) <= TIMED_DEADBAND) return { kind: "trim", trim: 0 };
  const trim = Math.max(-TIMED_TRIM_MAX, Math.min(TIMED_TRIM_MAX, -e * TIMED_TRIM_GAIN));
  return { kind: "trim", trim };
}
