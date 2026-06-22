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

The constraint is **bytes**, so ration bytes — and the byte ceiling is much lower than "jetsam"
(see §4a).

## 1a. Verified platform limits (researched 2026-06, cited)

The number that kills an iPhone is **not** system Jetsam (~1.5 GB) — it's the **WebKit per-page
limit, which bites first**, silently, no catchable error (the WebContent process is killed and
the tab reloads):

| platform | hard ceiling that kills | binding budget (leave margin) | live memory API |
|----------|-------------------------|-------------------------------|-----------------|
| iPhone SE-class | **~100 MB** page | ~80 MB | **none** (no measure*, no performance.memory) |
| iPhone 13/14 | **~400–450 MB** page | **~300 MB** | **none** |
| iPhone 15+ | **~1 GB** page (estimate) | ~700 MB | **none** |
| iPhone 17 Pro Max (12 GB) | **≥2 GB MEASURED** (survived 2 GB touched, didn't die; 2026-06) | generous — holds 2 full stem sets (~920 MB) w/o paging | **none** |
| Android Chrome (4 GB) | renderer OOM-kill ~0.5–1.5 GB + 4 GB V8 cage | tier by `deviceMemory` | `measureUserAgentSpecificMemory()` ✓ |
| desktop Chromium/FF/Safari | multi-GB | generous | Chromium ✓, FF/Safari ✗ |

- iOS also has a **~2 GB Gigacage single-allocation cap** (RAM-independent; an 8 GB iPad gives
  only ~1.88 GB to one typed array) — never make one giant SAB/WASM heap; partition.
- **A single 10-min full-rate int16 stem set is ~460 MB — that alone exceeds the iPhone-13/14
  page limit.** So paging is *mandatory to play even one long track* on iOS, not an optimization.
  (The current code survives only short tracks: a 5-min set ~230 MB squeaks under.)
- Sources: lapcatsoftware.com/articles/2026/1/7.html (measured kill floors), WebKit bug 268816
  (Gigacage), caniuse measureUserAgentSpecificMemory (Chromium-only), WebKit blog 14403 (storage).

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

| platform | windowBytes/deck | floor/deck | backing | total resident (2 decks) vs ceiling |
|----------|------------------|-----------|---------|-------------------------------------|
| desktop | whole track ≤ ~256 MB | none (window=track) | RAM if ≤budget else OPFS | well under multi-GB |
| iPhone 15+ | ~24 MB ≈ 30 s | ~25 MB mix | OPFS | ~100 MB + app vs ~700 MB ✓ |
| iPhone 13/14 | ~12 MB ≈ 16 s | ~25 MB mix | OPFS | ~75 MB + app(~150) vs ~300 MB ✓ |
| iPhone SE-class | ~8 MB ≈ 10 s | ~20 MB mix, **1 deck only** | OPFS | degrade: deck B mix-paged (§11) |
| Android (tier by deviceMemory) | ~24 MB low / larger high | ~25 MB mix | OPFS | live-checked via measure API |
| dev/CI forced | ~6 MB ≈ 8 s | ~20 MB | OPFS | forces the paging branch (§9) |

Numbers are starting points; tune against real device measurement — **but only Android/desktop
have a live API (`measureUserAgentSpecificMemory()`); iOS has none, so iOS budgets are enforced
by self-accounting (§9).** The SE-class can't hold two full stem decks under ~100 MB by any
design — it degrades honestly (§11), it doesn't pretend.

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
                  low-rate FLOOR (always-resident ~16–24 kHz full-track MIX, ~20–25 MB) — miss cover
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
- **Floor:** a low-rate (~16–24 kHz) full-track **MIX** (1 group, **not** 4 stems — a miss is a
  *seek*, which needs the mix at that point, not independent stem gains; you're rarely mid-stem-
  gesture *and* wild-seeking). ~20–25 MB/track (4× smaller than a 4-stem floor — this is what
  fits the ~300 MB iPhone budget). Always resident; covers a page miss with *zero onset latency*
  while the full-rate page loads (§8). A miss that lands during an active stem gesture briefly
  falls to the mix for the few-ms page load — acceptable, and rare.

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

### The seatbelt — platform-split, because iOS has no memory API

The seatbelt (predict-before-you-crash → degrade gracefully) **cannot be one mechanism**, because
the platform that actually crashes — iOS — has **no live memory API** (`measureUserAgentSpecific
Memory()` is Chromium-only; `performance.memory` likewise absent on Safari):

- **iOS: self-accounting.** Maintain a running byte tally of everything the engine allocates
  (OPFS pages resident + SAB rings + floor buffers + decoded LOD). Trip against the §1a budget
  (~300 MB iPhone 13/14, ~80 MB SE-class) BEFORE allocating. You will never get a real reading —
  the budget is a number *you* enforce, conservatively, with margin for the app's own ~100–150 MB.
- **Android / desktop Chromium: real API.** Use `measureUserAgentSpecificMemory()` (needs COI —
  already satisfied) as a live check; `navigator.deviceMemory` for tiering only (caps at 8 on
  Android — a 6 GB and 12 GB phone both report 8, so it's a low/high *tier*, not a budget).

Degradation when the budget would be exceeded is **never a crash and never a capability loss
mid-gesture** — it's: don't promote the second deck to full stems (mix-paged), surface a visible
one-liner ("deck B: host mix — phone memory"), and keep the floor so audio never stops.

## 10. Migration / phasing

**Order by RISK, not by layer — the storage tier is mechanical; the iOS real-time ring is the
keystone. Build the cheap crash-stopper first, prove the keystone, then go straight to OPFS (no
throwaway IDB step).**

- **Step 0 (now, shippable, no new infra): the iOS self-accounting seatbelt.** Convert the crash
  into graceful degradation (second deck → mix-only when the byte tally would exceed the §1a
  budget). No ring, no OPFS, no Worker — pure accounting + the existing demote path. Stops the
  bleeding independent of everything below.
- **Step 1 (keystone spike, ~1 day, GO/NO-GO): RAM-fed pager → SAB ring → AudioWorklet, on a
  PHYSICAL iPhone.** Proves the one fact the whole architecture rests on (glitch-free cross-thread
  audio on iOS 18/26 — the owed smoke test in §12) plus the window/seek/floor orchestration. No
  storage backend yet. If this glitches, stop and rethink before any OPFS work. **This replaces
  the old IDB v0** — a RAM-fed pager proves the mechanics faster and cleaner than IDB (whose
  per-txn overhead would inject glitches that aren't the architecture's fault), and IDB would be
  thrown away for OPFS regardless.
- **Step 2 (the real thing): OPFS hot tier** (`createSyncAccessHandle`, Worker-only, one
  long-lived handle); planar int16 layout; pack-time decode+write; tiered backing (RAM-if-fits /
  OPFS-else). The storage backend slots in behind the Step-1 pager interface.
- **Step 3: dev/CI forced-paging mode + bit-exact assertion** (paged == hold-everything); retire
  `DESKTOP_FREE_STEMS_SECONDS`; delete the seconds cap entirely.
- **Step 4 (optional): per-stem content-matched rates** (bass ~12 kHz etc.) — bigger memory win
  but breaks the worklet's single-rate read loop (per-group rate scaling in the hot path). Defer
  unless budgets still bite after windowing.

## 11. Edge cases / failure modes

- **SE-class (~100 MB budget) — honest hard limit.** Two full stem decks cannot fit under ~100 MB
  by any design. Documented degradation: one deck holds full stems, the other is **mix-paged**
  (window of the mix, no 4-group materialize), re-promotable only if the first demotes. Visible,
  not silent. This is the one device where the 1:1 promise yields — stated upfront as a rule, not
  sprung mid-set.
- **OPFS rules (Safari/iOS):** **Worker-only**; open **one long-lived `SyncAccessHandle` per
  file** and never churn it (iPad re-invoke bug + exclusive-lock cost); **no `createWritable()`
  on Safari** — write via the sync handle. Range read `read(view,{at})` is first-class. (Shipped
  iOS 15.4 — min-iOS floor can be 15.4 / SAB 15.2, lower than first assumed.)
- **OPFS eviction under storage pressure** → `navigator.storage.persist()` — but on iOS it's
  **honored only for an installed Home-Screen PWA**; in a plain Safari tab, OPFS is evicted after
  7 idle days or under disk pressure. So OPFS is always a **rebuildable cache**, never source of
  truth: on eviction, re-derive from the `trackCache` IndexedDB encoded bytes (re-decode +
  re-write). Floor stays resident so audio never stops. (Lever: shipping as an installable PWA
  extends OPFS durability on iOS.)
- **Gigacage ~2 GB single-allocation cap (iOS)** — never one giant SAB/WASM buffer; partition
  rings/backing per deck (our sizes are far below this, but it's a hard rule).
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

- Exact `windowBytes` per platform — the §1a/§4 numbers are researched estimates EXCEPT the
  17 Pro Max (measured ≥2 GB, 2026-06, engine/test/iphone-mem-probe.html). Flagship end is roomy;
  still need a real **SE/base-model/3–4 GB** measurement — that's where the budget actually binds
  and where paging earns its keep.
- **WHICH DEVICE did the original 2-deadmau5 crash happen on?** Decides the whole diagnosis: an
  older phone → steady-state OOM, paging is the fix (proceed). The 17 Pro Max itself → ~920 MB
  resident can't kill a phone that survived 2 GB, so it's a **transient pack-time spike** (float32
  ~460 MB + int16 ~230 MB coexisting per track during the int16 pack) or a single >2 GB Gigacage
  allocation — a different bug with a different fix than windowing. Resolve via Run B (load 2
  tracks on the crashing device + the probe, watch the PEAK, not steady state).
- Floor rate: 24 kHz vs 22.05 vs 16 — perceptual test on earbuds; trade RAM vs fade-up audibility.
  (Floor is the MIX, so it's cheap either way.)
- App baseline footprint on iOS (React + stem WASM + canvas + LOD) — measure it, because it eats
  ~100–150 MB of the ~300 MB budget before the engine allocates anything.
- SAB ring sizing + the pager service cadence vs worst-case scrub velocity.
- Does the WSOLA mono search need the floor or the full-rate window as its reference during a
  miss? (Probably floor, to stay click-free — verify.)
- One OPFS file per track vs one per (track,deck) when both decks load the same track.
- **OWED: physical-iPhone smoke test of the SAB→AudioWorklet ring on iOS 18/26** — the old
  WebKit bugs (237144/220038) are years-fixed and `ringbuf.js` lists Safari supported, but no
  2025–26 retest exists. Verify before relying on the cross-thread ring.
```
