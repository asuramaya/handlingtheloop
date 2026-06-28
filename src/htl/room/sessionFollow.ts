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
