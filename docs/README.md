# Docs ↔ code — what is covered, what is not

An inventory, taken **2026-09-01** by walking the tree rather than by memory. The
point of this file is to be honest about the gap: ~80,000 lines of TypeScript
across 348 files, against ~2,300 lines of design docs. Most of the code is not
documented anywhere but itself — which is deliberate in places (the comments in
this codebase carry the *why*, and a doc that restates them rots faster than they
do) and simply a gap in others.

Start with **[map.md](./map.md)** — the whole system in one read. Everything below
is the detail behind it.

## The inventory

| Area | Size | Doc | Status |
|---|---|---|---|
| `src/htl/audio` — engine, decks, FX devices, worklets, bank engine | 45 files · 15.6k | [fx-rack](./fx-rack.md) (rack, chains, banks, sampler) · [audio-io](./audio-io.md) (mic, cue, recording) | current; the **DSP of each device** is documented only in its own file header |
| `src/components` — the whole UI | 77 files · 19.8k | [app-architecture](./app-architecture.md) (App.tsx decomposition only) | **thin** — no doc covers the deck UI, the waveform, or the library panel |
| `src/styles` | 15 files · 13.6k | — | **none**. Conventions live in the CSS comments |
| `server/` — resolver, accounts, room, social, admin | 41 files · 10.3k | [youtube-relay](./youtube-relay.md) (cold-load fallback only) | **thin** — `accounts.ts` (1.1k) and `room.ts` (1.4k) have no doc |
| `src/htl/automix` — auto-DJ | 12 files · 2.9k | [smart-fader](./smart-fader.md) covers the *gesture*, not the mixer | **gap** — the remaining one worth closing |
| `src/htl/analysis` — LOD pyramid, beatgrid, key, palette | 8 files · 2.6k | [analysis](./analysis.md) | current (2026-09-01) |
| `src/htl/room` — session protocol + client | 10 files · 2.5k | [shared-session](./shared-session.md) · [sync](./sync.md) (how it differs from account sync) | ⚠ **stale header** — says phases 2–3 "not yet wired"; there are 28 intent kinds and it shipped |
| `src/htl/stems` — cache, separator worker, model registry, GPU queue | 9 files · 2.1k | [stems](./stems.md) (shipped pipeline) · [engine-stem-paging](./engine-stem-paging.md) (a design, **not built**) | current |
| `src/App` — spine + 7 concern hooks | 7 files · 2.0k | [app-architecture](./app-architecture.md) | current |
| `src/htl/lyrics` — align, LRC, convergence | 12 files · ~2k | — | **gap** — a whole subsystem, `lrcAlign.ts` alone is 967 lines |
| `src/htl/state` — settings, account sync, session snapshot | 13 files · 1.8k | [sync](./sync.md) | current (2026-09-01) |
| `src/htl/midi` — layer + device profiles | 10 files · 1.5k | [ddj-flx4](./ddj-flx4.md) (one profile, hardware-verified) | the *layer* (learn, routing, profiles) is undocumented |
| `src/components/social` | 16 files · 1.5k | [social-layer](./social-layer.md) | plan-shaped; shipped since |
| `src/htl/media` — YouTube source + OAuth headers | 11 files · 1.0k | README "How it works" | adequate |
| `src/htl/library` — Collection, playlists, sync | 8 files · 0.8k | — | **gap** (it has had two live data-loss bugs; see the file comments) |
| `migrations/` — 26 D1 migrations | 467 lines | [DEPLOY](../DEPLOY.md) (how to apply) | schema itself undocumented |
| `src/htl/gamepad` | 3 files · 358 | — | small; the file header suffices |
| `src/htl/persistence` | 3 files · 327 | — | small |
| `src/htl/fingerprint` | 1 file · 35 | — | small |
| `scripts/draglab` — UI + account harness | 4 files · 451 | [DEV](../DEV.md) | current |
| `scripts/fxlab` — DSP measurement | — | — | **gap**, and it carries a known trap: ⚠ *it asserts nothing about its own input*, so a green measurement is not a green feature |
| `engine/` — portable Rust DSP core | — | — | **PARKED**, far behind the TS engine |

## Docs with a stale header

Read the body, distrust the status line:

- **[shared-session](./shared-session.md)** — "Phases 2–3 scaffolded but not yet
  wired". They shipped: 28 intent kinds, live broadcast, recorded sets.
- **[social-layer](./social-layer.md)** — written as a project plan; the epics in
  it are live. Read the ★ CURRENT STATE block, not the intro.
- **[security-handoff](./security-handoff.md)** — dated 2026-06-22 with a
  2026-07-03 addendum. The cookie path it discusses is gone; its open items have
  not been re-verified since.
- **[engine-stem-paging](./engine-stem-paging.md)** — honestly labelled "design,
  not yet built", and still true. It is a *proposal*, not a description.

## The gaps

Three of the five originally listed here were closed on 2026-09-01
([analysis](./analysis.md), [sync](./sync.md), [stems](./stems.md)). What is left,
ranked by what a reader loses:

1. **`server/room.ts` + the two Durable Objects** — 1.4k lines holding every live
   session. [shared-session](./shared-session.md) describes the protocol, not the
   server that runs it.
2. **The auto-mixer.** 1k lines choosing when and how two tracks meet.
   [smart-fader](./smart-fader.md) documents the hand gesture that shares its DSP,
   not the machine.
3. **The MIDI layer** — learn, routing, profiles. One device profile is documented
   ([ddj-flx4](./ddj-flx4.md)); the layer under it is not.
4. **The library + its sync**, which has had two live data-loss bugs.
5. **`server/accounts.ts`** (1.1k) — auth, the social graph, moderation.

### A note on method

An inventory is only useful if it names **absence**, and absence matches no grep.
The way this list was built: enumerate the system from the *code* side —
directories, `/api/*` routes, D1 tables, storage keys — then ask, per item, which
document has ever heard of it. Reading the existing docs would never have
surfaced the lyrics subsystem or the analysis chain.

And rank by **consequence**, not size. The beatgrid was never the biggest gap; it
was the worst one, because SYNC, quantize, loops, auto-mix and phrase anchors all
inherit its errors.
