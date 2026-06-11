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
