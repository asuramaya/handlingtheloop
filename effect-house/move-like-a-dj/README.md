# Move Like a DJ — TikTok Effect House rhythm game (htl promo)

A body-tracking rhythm game for TikTok Effect House. Falling prompts hit with DJ
gestures on the game's own beat, scored on **Timing** (honest, forgiving) +
**Style** (generous, shareable). Skinned in htl's identity; promotes
handlingtheloop.com via brand-burn (the in-effect CTA link is prohibited — see
Constraints).

## Why it's structured this way
Effect House is a GUI-assembled effect, but the game logic is real TypeScript
(APJS). So:
- **`core/`** — pure, engine-free, unit-testable game logic (clock, gesture
  peak-detection, judging, scoring). Runs in Node today.
- **`components/`** — thin APJS adapters that read tracking and drive the HUD.
- **`tools/sim.ts`** — headless harness that tunes feel using the shipping code.
- **`ASSEMBLY.md`** — the human GUI steps inside Effect House.

```
npx tsx tools/sim.ts            # the core, running, no Effect House needed
npx tsx tools/sim.ts --sloppy
```

## Validated against current Effect House docs (mid-2026)
- ✅ Tracking is script-readable per frame via `APJS.AlgorithmManager.getResult()`.
  **Head pitch (`getFaceBaseInfo(0).pitch`) is the cleanest gesture signal** — so
  v1 leads with head-bop, not hand gestures.
- ✅ Custom clock/scoring in TypeScript (`onUpdate(deltaTime)`, no node graph).
- ✅ Custom 2D HUD (Screen Image + Text + ScreenTransform), recycled sprite pool.
- ✅ User-picked TikTok track plays during capture (Sound Library → Speaker) and
  is swapped on upload.

## Constraints that shaped the design (also docs-confirmed)
- ❌ **Beat-sync to the song is dead.** Beats Detection has a ~2s delay + coarse
  1-2-3-4 index → unusable for hit-timing. Game is **music-agnostic**: you move to
  the visual clock; the song is backing vibe. (This deletes the spec's §3 beat
  engine, §5 audio-BPM seeding.)
- ❌ **No in-effect CTA link / QR / external URL** for Community Effects. The
  funnel is: effect name + look → creator-attribution watermark → htl's TikTok
  profile → bio link → site. **The htl TikTok account is required infrastructure.**
- ⚠️ **8 MB package cap**, frame-rate gate at publish. Forgiving windows absorb
  the modest frame rate.

## Status
- [x] Pure core: clock, gesture peak-detector, judge, score (runs in Node)
- [x] APJS component for the head-bop lane + HUD
- [x] Sim harness
- [ ] Assemble in Effect House + on-device tune (see ASSEMBLY.md)
- [ ] Crossfader-swipe lane (hand `rect` centre X crossing midline)
- [ ] End screen (rank + htl identity) — text only, no link
- [ ] Harsher sim error model (current ±90ms is inside the PERFECT window)

See `move-like-a-dj_spec.md` (original handoff) for the full design rationale.
Open unknowns worth resolving before scaling up: face-tracking head-bop
reliability under fast motion, and whether **branded/partner** effects unlock a
CTA route that Community Effects don't.
