# Sync — the two planes

There are two completely different sync systems in this app and they are easy to
confuse. Getting the difference wrong has already caused one silent cross-device
data-loss bug, so it is worth being blunt about it.

|  | **Account sync** | **Session sync** |
|---|---|---|
| what | your setup follows you | people play together |
| shape | a last-write-wins **blob** | a stream of **intents** |
| transport | `fetch` → `/api/me/*` → D1 | WebSocket → a **Durable Object** |
| cadence | debounced push, 30 s poll backstop | live |
| conflict | newest timestamp wins, whole blob | the **anchor** is authority |
| code | `src/htl/state/settingsSync.ts` | `src/htl/room/`, `server/room.ts` |
| doc | this file | [shared-session.md](./shared-session.md) |

---

## 1. Account sync — your setup, across machines

**The client is the source of truth; the server is a mirror.** Everything lives in
localStorage first, because the UI and the hardware preset browse read it
*synchronously during render* and cannot await anything. The account copy is a
mirror of that, not the other way round.

What rides it: settings, the FX **preset banks** (all ten, chains included), MIDI
maps, colour themes, keymaps. The Collection + playlists ride the same contract on
a separate endpoint (`/api/me/library`) with a bigger cap.

### The contract

- Every local change stamps a shared clock, `htl:settingsUpdatedAt`.
- On sign-in: pull. **Remote newer → adopt it. Local newer (or the account is
  empty) → push.**
- After that: any change debounce-pushes (800 ms). A 30 s poll is the backstop
  under the live account-room nudge.
- The server caps the blob at **256 KB** and returns 413 past it.

### Two edges that have actually cut

**① An inbound blob must be written DOWN, not just into React state.** The banks
live in localStorage; `settings.fxBanks` is only the mirror. The hydrate that
writes them back down originally ran **once, on mount** — and the account blob
*always* arrives after mount (the sign-in reconcile, the poll, and the live
broadcast all call `setSettings` later). So a second device showed the factory
arrangement, and its first local edit then announced *that* back over the account
and destroyed the first device's curation. Silently, in both directions.

The fix has three parts and all three matter: the hydrate depends on
`settings.fxBanks` rather than on mount; it is **dirty-checked**, which is what
makes the outbound leg's own state update harmless instead of a loop; and a kind
the blob does not mention is **left alone**, never cleared, so a device keeps a
bank the account has not seen yet.

> **The rule:** whenever a synchronous local store mirrors an async remote one, the
> write-down depends on the remote *value*, not on mount. The loop everyone fears
> is prevented by making the write **idempotent**, not by making it **rare**.

**② A push that can fail silently is a backup that can fail silently.** The 413 was
swallowed by a bare `.catch(() => {})`, so a user past the cap simply stopped
syncing, on every device, with nothing anywhere to say so. It is reported now —
Settings ▸ Audio ▸ Effect presets carries the line.

### Is the cap a real risk? (measured 2026-09-01)

| | size | of 256 KB |
|---|---|---|
| a live settings blob (65 fields) | 1.3 KB | 0.5% |
| + all ten preset banks as **references** | 5.4 KB | 2.1% |
| + all ten **fully edited** (every one of 145 presets) | 29.4 KB | 11.5% |

The banks are **bounded** — 145 presets is a fixed ceiling. The growth vector to
watch is anything storing a MIDI map *per saved profile*, which has none.

### The one-way legs

Deliberately two one-way pipes, so there is no cycle to reason about:

```
a bank write ──announce──▶ settings.fxBanks ──▶ (settingsSync) ──▶ D1
localStorage ◀──hydrate─── settings.fxBanks ◀── (settingsSync) ◀── D1
```

Nothing reads `settings.fxBanks` except the hydrate, and nothing writes it except
the announce.

---

## 1b. Reading a provider playlist — the third pipe

Importing or re-syncing a Spotify / TIDAL / YouTube playlist is not account sync, but it
shares its hazard: a read that comes back SHORT must never be mistaken for the truth.

**Every provider read is budgeted, and every budgeted read reports `truncated`.**

| Path | Budget | Reaches |
| --- | --- | --- |
| YouTube, signed in (`server/ytdata.ts`) | 12 pages **or** 9 s | ~600 items |
| YouTube, public (`server/innertube.ts`) | 12 continuations **or** 8 s | ~1200 items |
| TIDAL playlist items (`server/tidalData.ts`) | 60 pages | ~1200+ items |
| TIDAL playlist list | 30 pages (a loop guard, not a cap) | every real collection |

The page budget is subrequest arithmetic, not superstition: a YouTube page costs one
subrequest and its enrichment costs another, so P pages cost `1 + 2P` of a Worker
request's 50.

`truncated` on the public path means one thing only: a continuation was still pending
when a budget ran out. Measured against the live API (2026-09-01), the declared item
count is not usable as evidence — a 13-item playlist hands back 10 videos with no
continuation, because unavailable videos still count toward its total.

**What `truncated` buys.** A short read adds and never prunes (`749454e`): the re-sync
reconciler takes it as an input and returns `removeIds: []`, because a track missing from
a partial read is not evidence the user removed it. Getting this wrong destroyed real
playlists once — see `htl-library-sync-dedupe`.

**What is still disclosed rather than solved.** A playlist past the budget imports
partially, forever, and says so in the toast. Matched (Spotify/TIDAL) re-syncs also report
the songs they could not find a video for — silence there meant a playlist that reported
"+3" was really "+3, and two are missing".

---

## 2. Session sync — playing together

Not a shared state blob: a stream of **intents** (28 kinds — control, load, seek,
queue, sample, …) plus periodic snapshots and playhead ticks, over a WebSocket
into one `DjRoom` Durable Object per room.

- **The anchor is authority, not "the controller".** Whoever holds it owns the
  playhead; everyone else follows and corrects drift.
- **Your own devices** are a silent control-extension of one rig. Visiting someone
  else's is an `attach()` with snapshot/restore at the boundary.
- **Going live** promotes the room to a broadcast; past ~500 listeners a
  `RelayRoom` crowd-shard tier fans out (validated to N=1000).
- **Dispatch matters**: a DM-style direct message wakes a peer; a reply on a
  broadcast thread takes the slow sweep lane. The same distinction bites in the
  app's own notification path.

Full protocol, roles and lifecycle: **[shared-session.md](./shared-session.md)** —
whose *header* is stale (it says phases 2–3 are unwired; they shipped) but whose
body is accurate.

### ★ THE ADDRESSING LAW

Every multi-device bug this app has had is the same bug: **a name that meant one
thing on the sender and something else on the receiver.**

- An `fxPad` gesture carried the chain's **id** — a per-deck sequence number (`c3`)
  that never matches anywhere else, so the far side silently fired whatever its own
  focus was aimed at.
- An `fxParam` carried a **slot** — an index into `chains.flatMap(devices)`. That
  list was the master chain alone until stem chains arrived; afterwards a DJ with
  one more chain than their phone sent "slot 5" for a reverb the phone resolved to a
  different device, or to nothing.
- `fxRack` carried the **master chain only**, so adding a chain, renaming one,
  changing its stems, or recalling a chain preset broadcast a message that could not
  describe what had changed — and the far side kept what it had.

So: **an address that crosses the wire is made of names, never of indices or ids.**
Chain name + device kind. It is the same key `applyFxChainSnapshot` rebuilds on, for
the same reason. `src/htl/room/fxWire.ts` builds every FX intent so fourteen call
sites cannot each forget a field.

And when an address resolves to nothing on the receiver, **the gesture is dropped,
not guessed.** Falling back to the index would be exactly the original bug.

### The other half: work that never reaches the wire

An automated process that drives the decks directly bypasses all of the above,
because the setters it calls do not emit. The AutoMixer hit this and papered over it
by re-publishing a whole snapshot at each transition boundary. Smart Fader is
continuous — a transition under a hand, with no boundaries to hang that on — so it
emits its own moves as the ordinary `control` / `transport` intents those moves
already had, and its arm/disarm crosses as a board action so the mode is *shared*
rather than merely announced.

### The harness

`src/htl/room/roomSim.ts` runs two simulated devices over one wire and asks the only
question that matters: *after this gesture, do both devices hold the same state?*

What is **real**: the apply path (`applyIntent.ts`, the same function the app runs),
the board-action registry, the intent builders, and — for the Smart Fader tests — the
actual `SmartFader` class. What is **simulated**: the deck, and specifically its FX
address space, modelled exactly as `FxRack` does it because that address space is the
thing under test. No audio is simulated and none is claimed: green here means *both
devices agree on which device the gesture named*, never *it sounded right*.

`applyIntent` was lifted out of `useSessionSync` for this. While it sat inside a
`useCallback`, "does this gesture reach the other device intact?" was a question the
suite structurally could not ask — so nobody asked it, and the answer drifted.

---

## Testing either one, locally

`scripts/draglab/account.mjs` stands in for the entire signed-in server with
`page.route`, so cross-device behaviour is drivable on one machine with no D1 and
no OAuth:

```js
const acct = await fakeAccount(page, { settings: { fxBanks: { eq: bankOf("MINE", "Bass Kill") } } });
acct.pushes / acct.lastPush   // what left this device
acct.setRemote(data, ts)      // another device just wrote
acct.fail(413)                // the server starts refusing
```

Faking the **server** rather than the client is what keeps it honest — the app runs
its real `fetchMe`, reconcile, debounce and push. For session sync, two tabs
against `pnpm worker` is the cheap path; see [DEV.md](../DEV.md) and
[qa-session-smoke.md](./qa-session-smoke.md).
