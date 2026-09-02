# Analysis — the beatgrid, and everything that inherits it

The most consequential subsystem with the least written about it. **Every timing
feature in the app is downstream of this**: SYNC, quantize, beat loops, beat jump,
the on-screen grid, auto-mix phrase anchors, Smart Fader, the sampler's four-beat
grab, and NOISE/GATE's bar-locked landing. An error here is an error in all of
them, which is why "the grid is off" is the most-reported class of bug.

**Source of truth is the code, and it is written to be read** —
`src/htl/analysis/beats.ts` opens with the full pipeline rationale, and
`analyze.ts` documents the `Beatgrid` shape field by field. This document is the
connective tissue: what feeds it, what consumes it, what has been tried, and what
is next.

## What it produces

```ts
Beatgrid {
  bpm, firstBeat, interval   // a best-fit CONSTANT grid — every legacy consumer
  beats?: Float32Array       // the DYNAMIC grid: actual tracked beat times
  downbeat?, beatsPerBar?    // which beat is a musical "1"
}
```

Two grids on purpose. The dynamic one flexes with the music; the constant one is a
linear regression over it, so anything written before dynamic tracking existed
still gets a sensible `bpm`/`firstBeat`/`interval`. **Read it through the helpers**
(`beatPhase`, `nearestBeat`, `beatTimeOffset`, `barAnchor`, `barPhase`), never by
indexing `beats[]` directly — the helpers are what handle the fallback.

## The pipeline

Offline, single pass, O(n), in a worker (`analysis.worker.ts` → `analyzeTrackAsync`)
so loading a track never stalls the main thread.

1. **Onset envelope** — STFT at 1024/512, decimated to ~22 kHz first (onsets live
   below ~11 kHz; halves the cost for nothing lost). Then a **percussive-emphasis**
   pass: each bin carries a slow EMA of its *sustained* level, and the flux is
   computed on the transient excess over that baseline. Pads, held vocals,
   strings, vibrato and gated synths stop faking onsets; drum hits that tower over
   their own baseline stay crisp.
2. **Tempo** — autocorrelation over 60–180 BPM with a gentle log-normal prior
   around ~125 BPM, so octave errors do not win. Parabolic peak interpolation for
   sub-BPM precision.
3. **Beats** — Ellis (2007) dynamic programming: the globally optimal beat
   sequence that both lands on onsets *and* keeps a near-constant period.
4. **Downbeat** — a low-band onset envelope drives 4/4 bar detection.
5. **Constant fit** — linear regression over the tracked beats.

### Why the grid used to drift

The original detector fit **one** tempo and **one** phase to the whole track. Any
error in `interval` walks a uniform comb off the beats over time — and worse at
higher playback rate, where more beats pass per real second. "The grid is off on
load" and "the grid drifts when I move the tempo" were **the same bug**, and the
fix was to track the beat sequence rather than assume one.

### Why the percussive pass is not a stem

It was re-scoped from "stem-cleaned onsets" deliberately. Making grid quality
depend on a neural drum stem would silently degrade every device that does not run
the heavy lane — phones, cache misses — so the grid would differ per device for the
same track. The percussive pass lives entirely in the light metadata lane:
universal, cheap, **the same grid everywhere**. No audio is reconstructed, nothing
is cached or played; it is born and dies inside the analysis call.

Honest about its scope: it strips harmonic *wash*, not pitched *attacks*. A piano
stab is a transient too. Removing those is a neural stem's job, or Tier 2's.

## Sharing the work

Analysis is cached in D1 by `videoId` and carries **`ANALYSIS_VERSION`** (now 2).
The second person to load a track skips the analysis entirely. The version travels
*with* the data, so the rule is: **reuse iff the stored version ≥ yours, else
recompute and upgrade** — a v1 grid is re-derived to v2 on next touch and the pool
climbs. Never downgrade on upsert. That contract applies to every pooled artifact
(grids, palettes, lyrics), not just this one.

## What consumes it

| Consumer | Uses |
|---|---|
| `Deck` snap / `beatJump` / `setBeatLoop` | the dynamic grid + helpers |
| `Deck.barGridCtx()` | **the one primitive for "land on the beat"** — derived from `barAnchor`, converts track seconds to context time by the sounding rate. GATE, NOISE's SNAP and every bar-locked effect go through it |
| `AudioEngine.sync` | bar-aligns when both decks have a downbeat (minimal move), else per-beat |
| `WaveformViewport` | beat → bar → phrase grid, bar numbers |
| auto-mix / Smart Fader | phrase-anchored mix points (first-sound / last-sound trim) |

## Where it goes next

A tiered plan, from a survey of current beat-tracking practice. Tier 1 shipped as
the percussive front-end above.

- **Tier 0** — sync-side fixes that do not touch detection. Done.
- **Tier 1** — a better onset front-end. **Done** (percussive emphasis).
- **Tier 2** — port a modern neural tracker (*Beat This!*) to run in the browser.
  This is where pitched-attack confusion actually gets solved.
- **Tier 3** — a particle filter for tempo/phase, for material that genuinely
  changes tempo.

Known-weak material: half/double-tempo confusion survives the log-normal prior on
some genres, and SYNC inherits whatever the grid believes. A manual grid nudge has
never been built and would be the cheapest real improvement for a DJ.
