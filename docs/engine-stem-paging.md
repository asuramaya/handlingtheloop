# Engine spec — cross-platform sliding-window stem paging

**Status:** design, not yet built. **Owner:** engine/audio.
**Supersedes:** the `DESKTOP_FREE_STEMS_SECONDS` length cap (Deck.ts:1000) and the
"pack everything in RAM" model that OOMs on long stem-separated tracks.

## 1. The problem, stated correctly

Today a deck holds the whole track's PCM resident — the mix, or 4 time-aligned int16
stems — in `stretchWorklet`. Two long stem-separated tracks (~460 MB int16 each at 10 min)
cross the WKWebView jetsam line (~1–1.5 GB) and crash the tab. The current mitigation is a
**seconds** threshold (`DESKTOP_FREE_STEMS_SECONDS`, mobile always releases the float32
source) — but that rations the wrong resource. Length is a bad proxy for memory: it's blind
to stem count, sample rate, channels, and how many decks are loaded. A 4-stem stereo track
at 11:59 sails under a 12-min cap and still OOMs; deadmau5 at 10:30 "should" be fine and
isn't. **Any seconds cap is a guess that content you don't control will eventually falsify.**

The constraint is **bytes**, so ration bytes.

## 2. The core idea

A deck never reads the whole track at once — it reads a **moving window** around the
playhead (plus pinned loop/cue regions). Hold the window resident; keep the rest on a backing
tier (RAM if it fits the budget, else OPFS flash) and page it in just-in-time.

- Resident cost becomes **bounded by `windowBytes`, not track length.** A 3-hour mix costs
  the same RAM as a 3-minute single.
- The track-length failure class is **deleted on every platform**, not relocated.
- `windowBytes` is a **per-platform policy knob**; the *engine is one code path*. That's how
  1:1 desktop⇄mobile becomes true by construction instead of asserted in a doc.

Desktop's "hold everything" is just the degenerate case `window = whole track`. Mobile is the
same engine with a smaller budget. **Same branch runs on both** (see §9 — this is load-bearing
for not rotting).

## 3. Goals / non-goals

**Goals**
- Bound resident PCM by a chosen byte budget, independent of track length or count.
- Full-fidelity, DSP-capable 4 stems on **every** deck, **every** platform, at all times —
  no capability degradation (the Impossible-Burger rejection: no seams mid-performance).
- One engine, window-size + backing-tier as policy; the paging branch exercised on desktop
  (so it can't become a mobile-only path that rots).
- Seek/cue/loop latency perceptually zero.

**Non-goals**
- Encoded (Opus/AAC) backing — raw int16 only in the hot tier (no per-seek decode spike).
- Changing the WSOLA/vocoder DSP itself. This is a *storage/feed* layer beneath it.
- Native shell / Rust spine — paging removes the memory cliff that was their main
  justification, so this retires that conversation rather than feeding it.

## 4. The central knob: a byte budget

```
windowBytes        per-platform RAM budget for the resident window (per deck)
window = min(track, windowBytes / bytesPerSecond)   // seconds of PCM held resident
bytesPerSecond = nStems * channels * sampleRate * 2  // int16
```

`DESKTOP_FREE_STEMS_SECONDS` is deleted; the policy is now a budget table:

| platform        | windowBytes/deck | backing tier            | notes                              |
|-----------------|------------------|-------------------------|------------------------------------|
| desktop         | large (e.g. whole track up to ~256 MB) | RAM if ≤budget, else OPFS | normal tracks never touch disk |
| mobile          | tight (e.g. ~24 MB ≈ 30 s) | OPFS (almost always)    | + low-rate floor resident          |
| dev/CI forced   | tiny (e.g. ~6 MB ≈ 8 s) | OPFS                    | forces the paging branch (§9)      |

Numbers are starting points; tune against real device measurement
(`measureUserAgentSpecificMemory()`).

## 5. Architecture

```
load → decode → int16 stems ──┐
                              ├─► backing tier:  RAM buffer (fits budget)  OR  OPFS file
                              │                  (planar int16 per stem, §6)
                              ▼
                       PAGER WORKER  (owns OPFS handle; off audio thread)
                              │  reads source-sample ranges, writes pages
                              ▼
                    SharedArrayBuffer RING  ──►  stretchWorklet (audio thread)
                              ▲                    reads groups from the ring window,
                  seek/loop/cue commands           runs WSOLA/vocoder unchanged
                              │
                     low-rate FLOOR (always-resident ~24 kHz full track) — miss cover
```

- **Pager Worker** owns the OPFS `FileSystemSyncAccessHandle` and does all disk reads. The
  AudioWorklet cannot touch OPFS sync handles directly, and disk reads must never block the
  audio thread — so the Worker is the disk owner and the SAB ring is the hand-off.
- **SAB ring** carries the resident window's int16 PCM keyed by **source-sample position**.
  No `postMessage` copies on the hot path; the worklet reads the ring directly.
- **stretchWorklet stays as-is** except: instead of holding `gL[g]/gR[g]` as whole-track int16
  arrays, it reads the current group samples from the SAB window. Its FIFO/ring (`RING`,
  `wHead`/`rHead`) and the WSOLA search are unchanged — it already consumes a stream, not an
  addressable whole-track buffer.
- **Floor:** a low-rate (~24 kHz) full-track int16 set, ~75 MB/track, always resident. Covers
  a page miss with *zero onset latency* while the full-rate page loads (§8).

## 6. OPFS file layout

One file per (track, fidelity). Hot tier = full-rate; floor = low-rate.

- **Planar int16 per stem**: `[stem0 L][stem0 R][stem1 L][stem1 R]…` each a contiguous run of
  `frames` int16. Planar (not interleaved) so a range read for the active groups is contiguous
  and you can read only the stems you need.
- **O(1) range seek**: byte offset of source sample `s` in stem `g` channel `c` is
  `base[g][c] + s*2`. No index structure needed — it's arithmetic. A window `[lo, hi)` for the
  active groups is a handful of contiguous `read(buf, {at})` calls.
- **Header** (small): magic, version, sampleRate, frames, nStems, channels, per-stem/channel
  base offsets. Lets a reload page straight from OPFS without re-decoding (durable across
  reloads; the current `trackCache` IndexedDB byte cache stays as the *encoded* source of
  truth, OPFS is the *decoded working set*).

## 7. Pack-time write path

Replaces/augments `Deck.loadEnginePcm`:

1. Decode → int16 stems (existing path; the fused base-envelope pass for the LOD pyramid
   stays — it's still needed for the waveform).
2. If `trackBytes ≤ windowBytes` (desktop common case): keep the int16 in a **RAM backing
   buffer**, skip OPFS. The "window" is the whole buffer; pager reads from RAM. Zero new disk
   cost.
3. Else: **write planar int16 to OPFS** (off-thread in the pager Worker; ~0.3–1 s for a long
   track) + build the low-rate floor + `navigator.storage.persist()`.
4. Hand the pager the backing descriptor (RAM ptr or OPFS path) + window policy. Worklet starts
   reading the window.

Mobile always takes branch 3 (tight budget). Desktop takes branch 2 for normal tracks, 3 for
long ones.

## 8. Window sizing + latency

**Window = `[head − back, head + fwd]`**, both scaled by max playback rate:

- `fwd` (lookahead): covers forward consumption between pager service ticks at the max rate
  (pitch-up / fast-forward scrub eats faster). ~8 s at 1×, scaled.
- `back` (lookbehind): reverse/censor/scratch-back + backward loop jumps. ~4 s.
- **Pinned regions**: an active loop `[in,out]` is read repeatedly → pinned resident regardless
  of window. Armed hot cues get a ~1 s pre-paged window each (8 cues ≈ 6 MB) so a cue punch is
  always warm. A loop longer than the window either expands the window (if budget allows) or
  falls to the floor rate for the overflow.

**Latency truth:**
- **Sequential playback = zero paging latency.** The pager runs seconds ahead of the head;
  reads are never on the real-time path. Disk speed is irrelevant to playback by ~50×.
- **Paging latency only exists at a discontinuity** (seek/cue/loop-jump to an un-paged spot).
  Chain: main posts seek → pager Worker reads OPFS range → writes SAB → worklet consumes next
  quantum. Budget: **~5–20 ms desktop, ~10–40 ms mobile.** Bandwidth to fill a 6–9 MB window is
  single-digit ms even on slow phone flash — **the disk is never the bottleneck; the software
  stack is** (which is why: OPFS sync handle not IndexedDB; raw int16 not encoded; Worker+SAB
  not audio-thread).
- **The floor erases the residual in perception:** on a miss, the floor (in RAM) plays *this
  quantum* with zero onset latency; the full-rate page swaps in over the next few quanta
  (a quantum is 2.7 ms). The user hears audio *now*; the only artifact is a ~10–40 ms fade-up of
  high-frequency detail, imperceptible on earbuds/phone speaker.

So: lookahead erases latency in playback, the floor erases it in perception. NVMe/UFS-class
storage means you never approach the bandwidth wall.

## 9. Keeping it one engine (anti-rot)

The trap is "desktop window = ∞": looks unified, but then the paging branch (eviction, miss,
floor, prefetch) only ever fires on phones — a mobile-only path that desktop devs and CI never
run, which drifts until it's quietly broken on the platform that depends on it (exactly how the
`engine/` Rust spine rotted). Two engines wearing one costume.

Counter-measures, both required:
1. **Tiered backing** (RAM-if-fits / OPFS-else) so the *abstraction* is identical everywhere
   and a long track on desktop genuinely pages through the same code.
2. **Dev/CI forced-small-window mode** — an env/flag (`HTL_FORCE_PAGING` or a tiny
   `windowBytes`) that forces the bounded window + OPFS backing on desktop. Every CI run and dev
   session then exercises the paging branch on the developer's machine, not only on a user's
   phone mid-set. Add a bit-exactness assertion: paged playback of a track must equal
   hold-everything playback sample-for-sample (within int16 quantization) — that's the 1:1
   contract as a test, kept from rotting.

## 10. Migration / phasing

- **v0 (proof):** page from **IndexedDB chunked into ~1 s records** (reuse the store
  `trackCache` already has) to prove window mechanics + SAB feed + floor cover, without the OPFS
  plumbing. Slower seeks (IDB overhead) but validates the design.
- **v1:** OPFS hot tier (`createSyncAccessHandle`) for the latency win; pager Worker; planar
  layout; tiered backing.
- **v2:** dev/CI forced-paging mode + the bit-exact assertion; retire
  `DESKTOP_FREE_STEMS_SECONDS`; delete the seconds cap entirely.
- **v3 (optional):** per-stem content-matched rates (bass at ~12 kHz etc.) — bigger memory win
  but breaks the worklet's single-rate read loop (per-group rate scaling in the hot path).
  Defer unless budgets still bite after windowing.

## 11. Edge cases / failure modes

- **OPFS eviction under storage pressure** → `navigator.storage.persist()`; on eviction,
  re-derive from the `trackCache` IndexedDB encoded bytes (re-decode + re-write). Floor stays
  resident so audio never stops.
- **Quota** — ~460 MB/track on OPFS; two tracks ≈ 1 GB, fine vs phone tens-to-hundreds of GB;
  evict on track unload.
- **Page miss during a fast scratch** — scratch can outrun `back`; the floor covers, and the
  pager widens `back` adaptively under sustained reverse motion.
- **First load of an uncached track** — decode+write must complete before paging serves
  full-rate; floor (built first) covers the gap. Same load latency as today otherwise.
- **Session guest materialize-on-divergence** (Deck.ts:862) — a guest reaching for a stem
  triggers the same pack-time write into the pager; the mirror→ownStems transition becomes
  mirror→(floor instant)→(full-rate paged). No "stems unavailable" wall.

## 12. Open questions

- Exact `windowBytes` per platform — measure on real iPhone (small/old) + Android UFS 3.1.
- Floor rate: 24 kHz vs 22.05 vs 16 — perceptual test on earbuds; trade RAM vs fade-up audibility.
- SAB ring sizing + the pager service cadence vs worst-case scrub velocity.
- Does the WSOLA mono search need the floor or the full-rate window as its reference during a
  miss? (Probably floor, to stay click-free — verify.)
- One OPFS file per track vs one per (track,deck) when both decks load the same track.
```
