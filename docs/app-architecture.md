# App.tsx architecture — the spine + concern hooks

`src/App.tsx` is the integration hub of the whole client. It was ~4779 lines; a decomposition
pass (2026-06) brought it to ~3400 by lifting self-contained concerns into `src/App/*` hooks. This
doc is the map: what lives where, the pattern used, and **why the auto-mix region is deliberately
left in App**.

The goal of the split was **parallel-edit-ability**, not architectural purity — App genuinely IS
the integration point and most of its state is coupled by necessity. The win is that two agents can
own `useSessionSync.ts` and `useMidiRouting.ts` without colliding on one 4000-line file. A wide
`deps` bag is the accepted price.

## The spine — `src/App/spine.ts`

A handful of ambient values are threaded into nearly every hook/component. Rather than prop-drill or
deps-bag them everywhere, they live on a React context that descendants PULL.

- `App()` is a thin wrapper: it creates the spine (`engine` lazy singleton, `refresh`, `emitRef`,
  `roomRef`) and renders `<SpineContext.Provider value={spine}><AppBody/></Provider>`.
- `AppBody()` is the former App body; it reads `const { engine, refresh, emitRef, roomRef } =
  useSpine()` at the top, so internal usage is unchanged.
- Consumers pull via `useSpine()` / `useEngine()` / `useEmit()` / `useRefresh()`. A new hook or
  component reads context — it never adds an App prop-thread.
- `emit` is built deep inside AppBody (it needs the room), so descendants reach it through the
  stable `emitRef`. `roomRef` is created empty in the wrapper and filled in AppBody after `useRoom`
  (`roomRef.current = room`) — this is what dissolves the old `useRoom ↔ session` ordering cycle: a
  session hook reads `useSpine().roomRef` and can therefore be declared BEFORE `useRoom`.

## The concern hooks — `src/App/`

Each is a PURE RELOCATION: function bodies are sed-extracted verbatim, the spine is pulled via
`useSpine()`, and everything else arrives via a `deps` object destructured to the original names so
closures + `useCallback` dep arrays are byte-identical. Type-only imports from `../App` (e.g.
`StemStatus`) are erased at build, so there's no runtime cycle.

| Hook | Owns | Feeds |
|---|---|---|
| `useStemPipeline` | `deriveStems` + cache-promote + stem helpers | the load path, badges, lanes |
| `useMidiRouting` | `onMidiEvent` dispatcher (the whole control surface) | `useMidi` + `useGamepad` |
| `useSessionSync` | inbound deck-state engine: reconcile / runRoomLoad / applyRoomSnapshot / applyIntent / onRoomIntent / onRoomTick + post-decode reconcile | `useRoom` callbacks, replay, boot-restore |
| `useStemViewSync` | inbound host-streamed 4-lane envelopes + the host streamers (sendHostStemView / handleStemRequest) | `useRoom.onStemView`, onStemsReady effect, stemReqRef |
| `useLyricsSync` | inbound onRoomLyrics + sendHostLyrics + reprocessLyrics | `useRoom.onLyrics`, broadcast effects, a deck's onReprocessLyrics |
| `useReplay` | G1c recorded-set replay (local-clock playback of a saved set) | follow/lock gates, ReplayBar, Profile/Discover |

The session region splits **by concern** (each = an inbound handler + its paired outbound streamer +
effects), NOT "all the `onRoom*` together." `useRoom` and `nowPlaying` (a render memo) stay in App.

The lazy-`roomRef` trick (read `roomRef.current` at call-time) works for **callbacks** but NOT for
**effects** whose dep arrays must re-fire on `room.*` changes — those need the reactive `room` object
and stay in App.

## What's deliberately left in App

- **`useRoom` + `nowPlaying`** — `useRoom` is the live room handle read across the whole render;
  `nowPlaying` is a render memo fed into it.
- **Color sync** (`onRoomSettings` + the two `--accent` body-paint / outbound-broadcast effects +
  `liveColorSig`) — `onRoomSettings` must exist BEFORE `useRoom` (it's passed to it), but its paired
  effects sit AFTER and their dep arrays read REACTIVE `room.status`/`signedIn`/`sendSettings`. A
  `roomRef.current` in a dep array isn't reactive, so they can't move; splitting would strand half
  the concern. It's 13 lines — not worth it.
- **The auto-mix region** (`mixQueue` / `autoStatus` / the `AutoMixer` setup / `autoControl` / queue
  editing) — see below.

## Why auto-mix is the hub, not a carve target

The auto-mix region is the genuine integration crossroads. Its dependency graph is a clean **DAG**
(no cycle):

```
crossfade seam  →  auto-mix (deckTrack, autoStatus)  →  mobile-stems  →  session-host-publish
```

But three values are **shared** (each consumed by two concerns):

- `applyCrossfade` / `crossfadeRef` — the smart-fader path AND the auto-mixer. `applyCrossfade` is
  kept *pure* on purpose (its comment says so) so the AutoMixer never routes through Smart Fader;
  `dragCrossfade` is the UI handler that branches Smart-Fader-armed vs plain.
- `deckTrack` (pure `meta` + `library` → `TrackMeta`) — the auto-mixer AND `applyMobileStemMode`.
- `autoStatus` — the auto-mixer AND the mobile-stem reconcile effect AND the session-publish effects.

Carving auto-mix wouldn't *remove* that sharing — it converts it into a wide deps-bag (in) + a
return-bag (out) that App still reaches into, so an auto-mix agent would STILL coordinate with App on
`deckTrack`/`autoStatus`. The seam stays leaky, and the carve would be the only one requiring a
declaration **reorder** (to topologically sort the scrambled file) rather than a pure verbatim
relocation — the one move that can shift effect-timing/TDZ behavior, with no runtime test to catch
it. The coupling is **benign** — these concerns genuinely *should* share one crossfade path, one
track-reader, one auto-mix state. Leaving it is the natural shape of an integration point, not debt.

**If a future pass does want to reduce the entanglement**, the single high-leverage move is to lift
`deckTrack` into a tiny `useDeckTrack(meta, library)` helper that auto-mix and mobile-stems each call
independently — that dissolves the worst shared seam (#2) and makes any later auto-mix carve
reorder-free. The rest is just code that lives near each other.

## The carve pattern (for the next one)

1. `sed -n 'A,Bp'` the function bodies VERBATIM into a new `src/App/useX.ts`.
2. Wrap with a `deps` interface + `const { … } = deps` destructure (original names) and a
   `return { … }`; pull the spine via `useSpine()`.
3. Refs pass through the deps bag (never in `useCallback` dep arrays). Module-level helpers the carve
   shares with App (e.g. `applyDeckStems`) pass via deps too (importing them from App would cycle).
4. To narrow a wide ref like `latest` (App holds `{meta,loaded,…}`, the hook needs only `.loaded`):
   type the dep `{ readonly current: { loaded: … } }` — readonly-current is covariant so App's wider
   `MutableRefObject` assigns in. A read-only union ref (e.g. `lyricsModelRef: LyricsModel`) needs the
   same covariant `{ readonly current: string }` because `MutableRefObject` is invariant.
5. Splice App: replace the block with the hook call, delete the now-orphaned imports, run
   `tsc -b` (filter `stems/`) + `tsc -p tsconfig.node.json` + `vite build`. Behavior is preserved by
   construction; tsc catches the wiring.
