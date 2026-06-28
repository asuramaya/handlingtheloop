# QA — 2-device shared-session smoke test

The automated suite (`pnpm test`, 525+ cases) covers all the **pure decision logic** of the
shared session — drift correction, snapshot dedupe, join-start, stem convergence, lyrics
contamination guards, the gesture-bus dispatch (see `src/htl/room/sessionFollow.ts`,
`src/App/useSessionSync.ts`, `htl-session-follow-tests` memory). What it **cannot** reach in a
plain-node test runner is the part that actually moves audio: does a decoded follower really
`seek`/`play`, do stem-view envelopes and word-timed lyrics stream device→device, does a recorded
set replay through the engine. **This checklist is that gap** — run it before any deploy that
touched the session/streaming path. It's deliberately ordered host-first, then guest-observes.

When an item fails, the cross-referenced decision is already unit-proven, so look at the **wiring**
(the engine call the hook makes), not the math.

## Setup

Sessions + social need the Durable Object, so use the worker, not `pnpm dev` (which fakes auth and
doesn't wire the live relay — see `DEV.md`).

```
pnpm check            # gate: tsc x2 + full test suite must be green first
cp .dev.vars.example .dev.vars   # set DEV_LOGIN=1 for the shortcut login
pnpm worker:lan:https            # https needed for cross-origin isolation (threaded stems) on devices
```

- **Two browser tabs** (fastest): tab A `…/api/auth/dev?name=Host`, tab B (incognito) `?name=Guest`.
- **Two real devices** (the real test — covers mobile on-device DSP + wireless drift): desktop as
  Host, phone on the same Wi-Fi at `https://<lan-ip>:8787`, dev-login as `Phone`. Find the IP with
  `ip route get 1.1.1.1`. iPhone is the important guest (on-device stems, audio-unlock, OOM).

Host: load tracks on A and B, **Session → start**. Guest: knock → Host approves. Guest is now a
pure follower (not driving). Keep both screens visible.

---

## A. Join & initial alignment  ·  *decideSnapshotDeck, reconcileDeckState*
- [ ] Guest joining **mid-set** mirrors the host's current tracks on **both** decks (not blank, not stale).
- [ ] Guest adopts the host's per-deck **tempo / pitch / EQ / filter / loop / cue / hot-cues** on join
      (a guest must not keep a stale local +8% tempo — that desyncs its own playback).
- [ ] No **double-load**: a deck already showing the host's track is not re-decoded (watch the network
      tab / load spinner — it should fire once per track, not on every republished snapshot).
- [ ] Waveform **zoom stays local** (each device keeps its own; it is not a synced control).

## B. Track load sync  ·  *runRoomLoad self-healing dedupe*
- [ ] Host loads a **new** track to A → guest decodes + shows the same track within a beat or two.
- [ ] Host loads to **both** decks quickly → both land on the guest (concurrent load, neither blocks).
- [ ] A failed/aborted guest decode **self-heals**: the deck doesn't stick on the old track — the next
      snapshot retries (force it by loading a flaky/long track, then another).

## C. Transport & drift  ·  *decideFollowTick, shouldStartOnDecode* (the historically bug-prone part)
- [ ] Host **plays** A → guest starts playing A, aligned (a clean seek before the source starts, no stutter).
- [ ] Host **pauses** → guest pauses and lands on the host's paused position.
- [ ] Host **seeks** (jump to a cue) → guest follows the jump.
- [ ] **No "loops a second forever":** with both playing steadily, the guest must NOT repeatedly snap
      backward. A playing follower is only ever pulled *forward* when it falls behind; a small lead
      (network latency) is left alone. Watch for ~1 s ago, re-loop, repeat.
- [ ] **No audible skip on join:** a guest that joins while a deck is playing starts at the **live**
      position, not the stale snapshot position then a yank forward.
- [ ] **Suspended-mobile host** (background the host phone briefly, foreground it): the guest does not
      rubber-band — a momentarily frozen host clock must not drag followers back.
- [ ] Guest's **own scrub** isn't fought by incoming ticks (scrub the guest waveform; it shouldn't be
      yanked until you release).

## D. Control sync  ·  *applyIntent*
- [ ] **Crossfader** move on host → guest's crossfader + audio follow.
- [ ] **EQ / trim / level / filter** knob on host → guest mirrors (per-band + shapes).
- [ ] **Tempo / pitch / keylock / quantize / tempo-range** → mirrored.
- [ ] **FX**: arm a pad / move an FX knob / change the rack on host → guest hears + shows it (FX rack
      reconciles so the throw isn't silent on the guest).
- [ ] **Loop in/out/exit, beat-loop, hot-cues, beat-jump** → mirrored.
- [ ] **SYNC / KEY** button state mirrors (display only — the tempo/pitch itself crosses as a control).

## E. Stems  ·  *decideStemConverge, useStemViewSync*
- [ ] Host **mutes / unmutes** a stem (e.g. vocals) → guest's cell + audio follow.
- [ ] Host moves a **stem gain** → guest follows; a stem the **guest** just touched isn't stomped by a
      slightly-stale echo for ~400 ms.
- [ ] **Mobile guest stem-view streaming:** on a phone guest with no local stems, the host's 4-lane
      stem envelopes render (the lanes draw, not blank) — and if they don't arrive within ~7 s the
      "Waiting for the host's stems…" tell appears, then clears when they land.
- [ ] **Phone guest stem divergence:** if the host has a stem muted when the guest joins, the guest
      materializes local stems so it's audible (idle sessions stay mix-only — the iOS OOM guard).

## F. Lyrics streaming  ·  *useLyricsSync (cross-track contamination guard)*
- [ ] Host's **word-timed captions** stream to the guest's caption ribbon (guest sees the same
      playhead-accurate lyrics even on a phone / YouTube-engine track).
- [ ] **No cross-track contamination:** while the host changes tracks, the guest never paints the
      previous track's lyrics on the new one (the videoId must match the loaded deck).
- [ ] **Reprocess lyrics** on the host re-resolves and re-streams cleanly.

## G. Recorded-set replay  ·  *useReplay*
- [ ] Host **records a set** (go live → play a mix → end) → it saves.
- [ ] **Replay** the saved set: it plays back on its own local clock through the engine (transport,
      loads, FX throws, crossfades all reproduce). No live peer needed.

## H. Color / vibe sync
- [ ] Host changes the **room color / vibe** → guest's accent/theme follows (and back-broadcasts when
      the host is anchor). Resolves on `room.status` changes (this is the one session concern left in
      App.tsx because its effects need the reactive room object).

## I. Roles & teardown
- [ ] **Anchor handover:** host hands the board to a co-DJ (or leaves) → control continuity holds, the
      queue survives the handover.
- [ ] **Knock / approve / kick** lifecycle works both ways; a kicked guest stops following.
- [ ] **Go live → anonymous listener:** open an incognito window with no login, tune into the live
      room → it reconstructs the mix (the broadcast plane).
- [ ] Leaving / ending the session restores each device to its own always-on rig (attach/restore
      boundary — see `docs/shared-session.md`).

---

## Sign-off
- Run on: ___ desktop↔desktop (tabs)  ___ desktop↔iPhone  ___ desktop↔Android
- `pnpm check` green: ___   ·   Date / build: ___
- Notes / failures: ___

A failure in A–G points at the engine wiring behind a unit-proven decision; A/C/E/F regressions are
the ones the App.tsx decomposition could have introduced, so weight those.
