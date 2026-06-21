# Shared DJ Session ("rooms")

Status: **Phase 1 landed** (connection + presence + master claim/handoff). Phases 2–3
(state sync + full intent bus + master ticks) are scaffolded but not yet wired.

## Goal

An account with two (or more) connected devices can join one **shared session** —
a "room" — and DJ together. One device is the **audio master**: the only one that
actually produces sound (it's plugged into the speakers / the room). The other
device(s) are full **co-DJs** — every control works on both, but only the master's
audio is heard.

Decisions (locked):

- **Follower role:** full co-DJ. Every fader/transport/load on either device drives
  the shared decks. Audio still only leaves the master.
- **Audio master:** chosen by an **explicit claim** ("Output here") and passed by an
  explicit **hand off**. Never automatic.
- **Scope:** **same account only.** The room is keyed by `user_id`; a device can
  only ever reach its own account's room. (Guest/cross-account join codes are a
  later extension — the protocol already allows it.)

## Why control-plane sync (not audio sync)

Audio bytes never cross the wire. Only **intents** (control actions) and **track
identity** (videoId) do. When a co-DJ loads a track, the master re-resolves and
decodes it through the existing edge proxy + R2 community cache — the same path a
solo load uses. The master is the audio clock and periodically publishes its real
playhead so co-DJs' waveforms track the actual sound.

Three streams:

1. **co-DJ → intent → master** applies it to real audio.
2. **master → tick (~10 Hz, lossy) → co-DJs** keep waveforms in sync.
3. **either → state snapshot → a joiner** gets the current set on connect.

## Why a Durable Object

One `DjRoom` DO per account (`idFromName(user.id)`). It is the single
authoritative coordinator:

- **Single-threaded ⇒ total ordering.** Two devices grabbing the same control
  resolve deterministically and both converge. This is the whole reason it works.
- **WebSocket Hibernation API** — idle rooms cost nothing and survive DO eviction.
- Natural home for the authoritative master flag + the last-known snapshot.

No existing DOs in this project; `DjRoom` is the first. It is a **SQLite-backed**
DO (`new_sqlite_classes`), which runs locally under `wrangler dev` with no billing
and is available on the Workers plans.

## Convergence rules

- **Absolute setpoints only** — `setLevel(0.7)`, `setPlaying(true)`. Never deltas or
  bare toggles. Then a reordered or dropped message still converges (last-write-wins
  per `(deck, control)`).
- The DO **total-orders** intents and stamps a monotonic `seq` (best-effort across
  hibernation; correctness rides on delivery order, not the seq value).
- Continuous controls (faders, crossfade, jog) are **coalesced client-side**
  (~30–60 Hz, latest-wins) before sending, so a dropped frame self-heals on the next.

## Auth & security

- The WebSocket upgrade is authed by the existing `htl_session` httpOnly cookie
  (rides along automatically, same-origin). The Worker resolves it via
  `userBySession`; **no session ⇒ 401, no upgrade.**
- Room id is derived from `user_id`, so a device only ever lands in its own
  account's DO.
- **Nothing sensitive crosses the room socket:** only control intents, track IDs,
  and control-value snapshots. No audio, no OAuth/YouTube credentials, no cookies.
  The master forwards *its own* ephemeral YT auth for resolution exactly as today;
  co-DJs never see it.
- `deviceId` is a non-secret, client-generated, localStorage-persisted label — not a
  credential.

## Failure / handoff behavior

- The current master taps **Hand off** to pass output to a named peer; **Stop output
  here** to vacate.
- If the master disconnects, the DO clears the master and broadcasts the vacancy.
  **Audio holds** — we never auto-jump output to another device mid-set. Any
  remaining device can then claim **Output here** and resume.

## Wire protocol

Defined once in `src/htl/room/protocol.ts` (pure types; the DO treats `snapshot`
opaquely, so the file has no imports). `deviceId`/`name` are passed as query params
on the upgrade URL (`/api/room?device=…&name=…`).

Client → Server (`ClientMsg`):

| `t` | meaning |
|---|---|
| `claim` | request to become audio master (granted only if vacant / current master gone) |
| `handoff {to}` | current master passes output to peer `to` |
| `release` | current master vacates output |
| `intent {intent}` | a control action (absolute setpoint) |
| `tick {decks}` | master's live playhead, throttled |
| `state {snapshot}` | master publishes the authoritative `SessionSnapshot` (relayed opaquely) |
| `request-state` | a joiner asks for the current snapshot |

Server → Client (`ServerMsg`):

| `t` | meaning |
|---|---|
| `welcome {you, masterId, peers}` | sent on connect |
| `presence {peers}` | peer list changed |
| `role {masterId}` | master changed (claim / handoff / vacancy) |
| `intent {from, seq, intent}` | relayed control action |
| `tick {decks}` | relayed master playhead (to co-DJs) |
| `state {snapshot}` | the authoritative snapshot (to a joiner) |
| `error {message}` | e.g. "another device is the audio master — use hand off" |

`Intent` is an absolute-setpoint union: `crossfade`, `control` (tempo/trim/level/eq*/
filter/pitch), `toggle` (fx/keylock/quantize), `stem`, `transport`
(play/pause/cue/seek), `loop`, `hotcue`, `load`.

### Intent → engine mapping (phase 3)

A single `applyIntent(sink, intent)` funnels every inbound intent back onto the
**same** `deck.*`/`engine.*` methods the on-screen buttons call (mirrors
`applyDeckControls` in `App.tsx`). Local UI actions and network actions both pass
through it; `refresh()` re-renders. The master applies locally first (zero latency)
then broadcasts; a co-DJ sends + applies optimistically + reconciles from `tick`.

| intent | call |
|---|---|
| `crossfade {value}` | `setCrossfade(value)` + `engine.setCrossfade(value)` |
| `control {deck,param,value}` | `deck.set<Param>(value)` (tempo/trim/level/eqLow/eqMid/eqHigh/filter/pitch) |
| `toggle {deck,param,value}` | `deck.setFx/​setKeylock/​setQuantize(value)` |
| `stem {deck,stem,on}` | `deck.toggleStem(stem)` (to match `on`) |
| `transport {deck,action,position}` | `deck.play/​pause/​jumpToCue/​seek` |
| `loop {deck,action,beats}` | `deck.loopIn/​loopOut/​exitLoop/​reloop/​setBeatLoop` |
| `hotcue {deck,slot,action}` | `deck.hotCue/​saveLoop/​clearHotCue` |
| `load {deck,videoId,…}` | the existing deck-load path (resolve → decode) |

## Files

- `server/room.ts` — the `DjRoom` Durable Object (hibernatable WS, presence, master
  election, relay).
- `worker/index.ts` — `/api/room` upgrade route (cookie auth → `idFromName(user.id)`
  → forward to the DO stub); re-exports `DjRoom`.
- `wrangler.jsonc` — `ROOM` binding + `new_sqlite_classes` migration.
- `src/htl/room/protocol.ts` — wire types (single source of truth).
- `src/htl/room/client.ts` — `RoomClient` (connect/reconnect/send/on, role state).
- `src/htl/room/useRoom.ts` — React hook (gates on sign-in, manages connection).
- `src/components/RoomBar.tsx` — the chin "Sync" button + device popover.

## Build phases

1. **DONE** — DO + authed WS + presence + master claim/handoff; chin UI.
2. **Next** — `state` sync from `SessionSnapshot`; a joiner mirrors the current set;
   prove one intent (crossfade) end-to-end.
3. Full intent bus (`applyIntent` + dispatch wrapper over every control) + coalescing
   + master `tick` → co-DJ waveforms.
4. Polish: master-vacancy UX, reconnection edge cases, device rename.

## Dev / test

`vite` dev (5173) does **not** run the Worker, so the room needs `wrangler dev`
(`pnpm worker`). Open two browser profiles signed into the same account, enable Sync
in both, and one taps **Output here** — the role propagates to both. Nothing is
deployed until explicitly requested.

---

# Attachment model (2026-06-20 rework — supersedes the always-on "session" framing)

## The problem this fixes

The code grew an implicit assumption: **signed in ⇒ socket open ⇒ "in a session."**
The home-room socket (`home:${userId}`) opens automatically on sign-in and only
tears down when identity changes (`userId` / `isGuest` / `listenHandle`). `join()` /
`leave()` toggle a *membership flag* on that permanent socket — they never open or
close it. The social layer (broadcast, co-DJ invites, tune-in listeners, stage
step-up) all piled onto the same `enabled`/`joined`/`controlling` booleans.

Two concrete defects fall out:

1. **No solo zero-state.** A signed-in user is *always* in their home DjRoom. There
   is no "I'm just DJing alone" — only `joined:false` on a still-live socket.
2. **Lossy, asymmetric leave.** Joining adopts the room's board over your local
   decks via `applyRoomSnapshot`. Leaving (the `wasEnabledRef` edge in `App.tsx`)
   only pauses the decks + clears load guards. Your pre-join board is **destroyed,
   never restored.** `join` has no inverse.

## The two planes

**Plane 1 — your rig (the "local remote").** `home:${you}`, always-on, all of *your*
signed-in devices. This is **not a session you join** — it is one board with several
windows. One device is the audio master (anchor); the others are remote controls
onto the *same* decks (the iPad-controls-the-desktop use case — the reason the
always-on socket exists, and a feature we keep). Membership is **automatic**: sign in
→ your devices are your rig → they mirror. There is nothing to snapshot/restore
*within* your rig, because every device is a live view of one board.

**Plane 2 — visiting another rig.** A deliberate enter/leave: accept an invite, tune
into a broadcast, or step onto someone's stage. This is the **only** place
snapshot/restore lives — you are setting your own board aside to go play on someone
else's.

**Hosting is not visiting.** When *you* go live / open your rig to co-DJs, it is
still your board: no snapshot, no socket swap, nothing to restore. The crowd comes to
*your* home DO. Snapshot/restore is needed in exactly one direction: a **device**
leaving to visit another rig, then coming home.

## The unifying primitive: `attach(source)`

Each **device's** local audio engine is *attached* to exactly one board source at a
time (attachment is **per-device, not per-account** — your desktop can visit Alice
while your iPad stays home; they are different sockets):

```ts
type Attachment =
  | { to: "home" }                 // default: a live window on my own rig
  | { to: "rig"; host: string }    // visiting someone else's rig (co-DJ / listener / stage)
```

Every transition is the same three-step move:

1. **Detach** from the current source. If this device is that source's **anchor**,
   hand the anchor off first (§ Anchor handoff).
2. **Attach** to the new source: adopt its snapshot, start mirroring its
   intents/ticks.
3. **Re-attach home** = adopt `home:${me}`'s **current live** snapshot (decided:
   restore to the rig's *now*, not this device's stale pre-visit board, because
   another of my devices may have advanced it). The local pre-visit snapshot is only
   the **cold-start fallback** (home DO empty / evicted).

Visiting as a co-DJ and tuning in as a listener are the **same state machine** — they
differ only in *policy*, never in code path:

| case | attach to | can I drive? | where my edits go | restore on leave |
|---|---|---|---|---|
| **Visit as co-DJ** | another rig's DO | only if that host grants | gated intents → that host | `attach("home")` → rig's live state |
| **Tune-in listener** | another rig's DO (read-only) | no | requests only | `attach("home")` → rig's live state |
| **Come home** | `home:${me}` | full | my own rig | — |

So: "leave a session and restore" **is** `attach("home")`. "Co-DJ on Alice's rig"
**is** `attach({rig:@alice})`. One machine, two visit policies + home.

**Cue/prep is not an attachment.** Auditioning the next track is the **idle deck +
headphone PFL** (the existing cue bus), not a board detach — the idle deck *is* the
prep space, and your other devices *should* mirror it. The earlier "scratch detach"
idea was **dropped**: its only effect would be hiding idle-deck prep from your own
devices, which contradicts the local-remote feature. (The cue bus has its own audio
bugs — pitch + latency — tracked as a separate workstream; see the cue note in the
red team below.)

`autoIsRemote` **stays anchor-based** — the auto-mixer runs on whichever device is
the audio master, home or visiting, so a non-anchor device on your *own* rig (the iPad
controlling the desktop) is still a queue-remote: `enabled && !isAnchor`. What
`attachment` cleanly owns is the **snapshot/restore boundary** (P2) and the
**queue-edit policy** (P3): *attached to another rig without a control grant → queue
actions are requests; on home → direct edits (anchor) or queue intents (non-anchor).*

## Anchor handoff (covered by the existing master-vacancy rule)

Dropping `scratch` removes the hard case. What remains: when my device leaves my home
rig to **visit** another rig, my home rig may lose its audio master (if this device
was it). That is exactly the **existing** master-vacancy behavior — *audio holds, we
never auto-jump output* (§ Failure / handoff). Another of my devices can claim
**Output here**; if none is present, my home rig simply goes quiet while I'm away,
which is correct (I'm listening to the rig I'm visiting, not my own).

A **visiting** device is never the anchor of the rig it visits (it joined as a guest /
listener), so leaving that rig needs no handoff. So there is **no new anchor
machinery** — the Phase-1 explicit claim/handoff (arbitrated by the DO, single-
threaded) already covers it.

## Snapshot / restore contract

- **A board snapshot** = the existing `SessionSnapshot` (decks + videoIds + control
  setpoints + FX rack) **plus** the auto-mix queue (`mode`, `current`, `upcoming`)
  and crossfade. Captured from the live engine, same shape `publishState` already
  sends.
- **On `attach(away)`**: stash a local `preVisit` snapshot (cheap, in-memory) for the
  cold fallback, then adopt the target.
- **On `attach("home")`**: reconnect home, `request-state`, adopt the **server's**
  live snapshot. Only if home returns empty/cold do we replay `preVisit`.
- The home DO already persists its snapshot (throttled), so "restore to the rig's
  now" is mostly *reconnect + request-state* — the local snapshot is insurance.

## What dissolves

- **Dead queue button for "middle" roles** (joined-not-controlling co-DJ; stepped-up
  single-deck listener): policy table makes it a *request*, not a silent no-op.
- **Wasteful parallel radio on remotes**: only a rig's authority runs the radio
  engine; an attached visitor never fills a local queue it can't use.
- **Lost pre-join board**: `attach("home")` restores it.

(The index-based queue `move` race and the missing load-generation guard in the
AutoMixer are *orthogonal* correctness bugs — still fixed separately — but they get
easier to reason about once "who owns this queue" is a single attachment fact.)

## Phased migration (keeps the app working at each step)

1. **Introduce `Attachment` as the source of truth** in `useRoom`, derived from
   today's flags (`listenHandle`/`joinCode`/role) — no behavior change, just a single
   computed `attachment`. Re-express `autoIsRemote`, `followRef`, queue authority off
   it. *(pure refactor, green at each commit)*
2. **Snapshot/restore on the visit boundary.** Hook `preVisit` capture on
   `attach(away)` and live-snapshot adopt on `attach("home")`. Fixes the lost-board
   defect. *(the highest-value user-visible fix)*
3. **Policy cleanup**: queue-edit authority + the dead-button → request routing read
   straight off `attachment` (no more silent no-ops for middle roles).

(No `scratch`/detach step — dropped. No new anchor machinery — the existing master-
vacancy rule covers a device leaving home to visit. The cue bus pitch/latency fix is a
separate workstream, not part of this migration.)

## Red team

See the dedicated `### Red team` review appended below — attack scenarios, race
windows, and the open questions that survived the first pass.

### Red team

**R1 — Detach-the-anchor mid-broadcast.** You are live (crowd attached to your home
DO) and you detach your only DJ device to `scratch` to cue privately. The crowd's
audio source just vanished. Mitigation: a `scratch` detach while your rig is the
*broadcast source* must be **blocked or auto-handed-off** — you can only privately
cue if another of your devices can hold the anchor. If none can, the "Detach" control
is disabled with a reason ("no other device to keep the room playing"). **Open:** do
we silently fall back to "cue on headphones via the second output device" (the
existing PFL path) instead of a true detach? That may be the *real* user intent and
avoids the whole problem.

**R2 — Restore-to-now races a still-evolving rig.** `attach("home")` adopts the home
snapshot "now," but the home rig may be mid-transition (an iPad is auto-mixing). The
adopt lands a snapshot that's stale by the network RTT, then the next `tick`/`state`
corrects it — same eventual-consistency the join path already has. Acceptable, but
the **first** adopt can cause an audible jump on the returning device. Mitigation:
returning device attaches **muted/`listening:false`** and only un-mutes after the
first reconciled tick (the muted-by-default join model already exists).

**R3 — Two devices detach, both think they're anchor.** Desktop (anchor) detaches to
scratch and hands anchor to the iPad; simultaneously the iPad detaches. Anchor handoff
must go **through the DO** (single-threaded total order), not peer-to-peer, so one
loses and the rig either keeps a valid anchor or cleanly vacates (audio holds, per the
existing "never auto-jump output" rule). The handoff must be a *request the DO
arbitrates*, never an optimistic local flip.

**R4 — `preVisit` snapshot vs. "restore to now" — when do they disagree, and is the
fallback ever wrong?** If home is cold (DO evicted, no persisted snapshot) we replay
`preVisit`. But `preVisit` is this device's board from *before* the visit, which may
be hours stale. Is replaying it better than landing on an empty board? Probably yes
(you get *your* set back), but it can resurrect a track the user already moved on
from. **Open:** TTL the `preVisit` snapshot (e.g. ignore if older than the session)?

**R5 — Scope creep into a true second DO.** The doc says "two planes," but Plane 2
(visiting) already reuses the *target's* existing DO — there is **no new DO type**.
`scratch` is purely local (no DO at all). Good: C ("two rooms") is satisfied
*conceptually* without a second server object. Guard against anyone "implementing the
scratch room" as a DO — it must stay client-only, or we pay write quota for a private
board nobody else sees.

**R6 — Per-device attachment + account-private settings sync.** Today a same-account
device's colour/settings fan out to your *other* home devices. While one device is
**visiting** another rig, should it still receive your home settings pushes? It is on
a different socket (the visited rig's), so it physically won't — which is correct, but
means a theme change you make won't reach a visiting device until it comes home. Minor;
the poll backstop covers it. Note it so it's not later "fixed" into a cross-rig leak.

**R7 — The home rig with zero devices.** You close every device. The home DO
hibernates with its last snapshot (fine). You reopen on one device → `attach("home")`
→ `request-state` → adopt. But if the DO was **evicted** and lost its throttled
snapshot, you land empty and the `preVisit` fallback doesn't apply (you weren't
visiting). This is just the **existing** cold-start; the local-session restore
(`loadSession()` in `App.tsx`) already covers it. Confirm the rework doesn't bypass
that local restore on the home-attach path.

**R8 — Going live *while already visiting*.** Can a device that's attached to Alice's
rig hit "Go live" on its own? It shouldn't — your home rig is what goes live, and this
device isn't driving it. "Go live" must be gated to a device attached to `home`
(or trigger an implicit `attach("home")` first). Otherwise the affordance is
ambiguous.

**R9 — Reconnect flap mistaken for a detach.** A WS blip on a visiting device must not
trigger `attach("home")` + restore (that would yank the user out of the rig they're
visiting on every transient drop). The existing client distinguishes a reconnect
(status drops too, self-heals) from a true leave; the `attach` transitions must key on
the *deliberate* user action / role change, never on socket status alone — exactly the
bug the `wasEnabledRef` "still ONLINE" guard already encodes. Preserve that guard.

**Resolved (2026-06-20):** `scratch` detach **dropped** → R1 and R3 (both were detach
hazards) are moot; cue/prep is the existing PFL bus instead. R4 → **TTL the
cold-fallback snapshot** (ignore if older than the current app session). R8 →
**confirmed**: "Go live" is gated to a device attached to `home`; you can never make
someone else's rig go live. R2 / R6 / R7 / R9 keep their listed mitigations (reuse
machinery already in the tree).

**Cue bug (separate workstream).** PFL pitch is sharp (~+1.5 semitones) + latency
(~150–400 ms): root-caused to the `MediaStreamDestination → <audio>.setSinkId` bridge.
The context runs at the 48 kHz hardware default (`AudioEngine.ts` constructs it with no
`sampleRate`); the `<audio>` MediaStream path resamples to 44.1 kHz → the 48000/44100 ≈
+1.47-semitone shift; the HTMLMediaElement jitter buffer → the latency. The cue tap is
*post*-stretch (off `trimNode`), so it is **not** a wrong tap point. Fix path: (1)
verify the 48/44.1 ratio empirically, (2) pin `sampleRate: 44100` on the context — the
cheap pitch fix; latency stays a known browser limit of 2-output until a dedicated
cue-`AudioContext` (constructor `{ sinkId }`) spike proves it beats the `<audio>` path.

---

# Live broadcast — follower sync + directory liveness (2026-06-20/21)

Lessons + mechanisms hardened while debugging the public-broadcast / anon-listener path
in production.

## Followers run at the anchor's effective rate (the tick carries it)

A follower — an anon listener rendering its OWN decoded audio, OR a same-account remote
mirroring the clock — must advance at the **host's** effective playback rate or it drifts
and `onRoomTick` hard-seeks it back every few seconds (a visible playhead catch-up + the
occasional audible skip; on iOS the suspended-context path makes the visual snap obvious).

The trap: `effRate() = _rate·(1+_bend)·(1+_syncTrim)`. `_rate` tracks via tempo/pitch
intents, but **`_bend` (jog beat-match) and `_syncTrim` (continuous phase-lock) never cross
as intents** — jog is even dropped for the listener digest. So a follower that computes its
own rate drifts whenever the host nudges or sync-locks.

Fix: `DeckTick.rate = deck.effectiveRate` rides every 250 ms tick. A following deck stores
`_followRate`; `effRate()` and `followExtrapolate()` **override** the local rate with it, so
the follower's clock *and* a listener's own audio run in lockstep with the host — self-healing
each tick regardless of any dropped intent. `pushRate()` re-speeds the worklet on change;
`endFollow()` clears `_followRate` so a co-DJ that takes over the clock reverts to its own
tempo. (Deck.ts `effRate`/`followTick`/`endFollow`/`effectiveRate`; App.tsx `buildTick`/
`onRoomTick`; protocol.ts `DeckTick.rate`.)

## Directory "live now" freshness is CLIENT-HEARTBEAT-only (known limitation)

A host's row in the D1 `rooms` directory is kept LIVE solely by the host client's
`setInterval(announce, 30 s)` (useRoom), with a 90 s freshness filter on read (`liveRooms` /
`liveRoomStatus`). **There is no DjRoom DO alarm / server keepalive.** Consequences:

- A backgrounded/locked **mobile host** has its timer throttled → the room ages out of
  Discover *and* the `/@handle` "Listen live" affordance after 90 s even though the WebSocket
  is still connected and broadcasting.
- A stale `live=1` row can linger (heartbeat died without a clean `close`); the freshness
  filter hides it, so it's harmless to readers but misleading in the raw table.

Proper fix (deferred until mobile hosts matter): a DjRoom DO **alarm** refreshes the
directory while the host socket is connected — immune to client-timer throttling.

**Diagnosis note:** when a "live" host isn't discoverable, query the prod `rooms` row first
(`wrangler d1 execute htl-db --remote --command "SELECT … FROM rooms …"`) — `live` + the
`now - last_seen` age is the smoking gun (announce firing or not). `wrangler tail`'s JSON
shape doesn't match a naive `grep` filter, so it's a poor first tool here.

## Late-joiner stem delivery

A listener's join `sendCatchUp` re-sends the cached `lastStemView`, but it arrives in a
burst BEFORE the deck finishes decoding — `onRoomStemView`'s slot-vs-song guard then drops it
and nothing re-delivers (the host only re-streams on a NEW separation edge; anon listeners
aren't in `joinedSig`). So a mismatched stem view is **stashed** (`pendingStemView`) and
re-applied by an effect keyed on `loaded` once the deck's track lands.
