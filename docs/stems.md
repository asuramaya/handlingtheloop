# Stems — the shipped pipeline

Separating a track into **drums / bass / vocals / instruments** in the browser, and
sharing the result so nobody pays for it twice.

> Not to be confused with [engine-stem-paging.md](./engine-stem-paging.md), which is
> a **design for something not built** (a sliding-window OPFS pager). Verified
> 2026-09-01: there is no pager and no SAB ring in `src/htl/stems`. This file
> describes what actually runs.

## The economics, which drive every decision

Separation is expensive and its output is **identical for everyone**. So:

```
want stems?  →  R2 has them?  ── yes ──▶ download (any device, including phones)
                    │ no
                    ▼
             canSeparate()?  ── no ──▶ you don't get stems here, and that is fine
                    │ yes
                    ▼
             separate locally → upload to R2 → everyone after you downloads
```

**Phones never separate.** `canSeparate()` gates every entry point: separation is
Chromium + WebGPU only. A phone is a *consumer* of the pool, never a producer, and
the UI never offers it a button it cannot honour.

## What runs where

| | |
|---|---|
| `index.ts` | the cache-first flow, `canSeparate()`, the R2 round trip |
| `separate.ts` | main-thread orchestrator: resample the mix to the model's 44.1 kHz, ship PCM to the worker, resample the returned stems back to the deck's rate so they line up **sample-for-sample** with the mix buffer |
| `separator.worker.ts` | the heavy lane — JS STFT → the Demucs core on onnxruntime-web → JS iSTFT |
| `models.ts` | the model registry (`htdemucs`, `htdemucs-f16`), with `LEGACY_STEM_IDS` read-fallback so older cached ids still resolve |
| `gpuQueue.ts` | app-wide GPU serializer |
| `opus.ts` | encode for upload |
| `fft.ts` | the shared FFT (the analysis chain uses it too) |

**Demucs is the sole engine.** An ONNX/Open-Unmix alternative existed and was
removed (−2260 lines); the ids were renamed at that point, which is what
`LEGACY_STEM_IDS` exists to survive.

## Three constraints worth knowing before you touch it

**① The GPU is shared with the compositor.** Two heavy WebGPU jobs at once — two
decks separating, or a StrictMode double-fire — thrash occupancy and starve the
browser's own painting, so the deck and waveform stutter. Everything funnels
through **one queue, one heavy job at a time**: jobs finish faster in aggregate
*and* the UI stays smooth. The CPU STFT that builds the waveform pyramid and the
beatgrid is deliberately **not** on this queue — it is a different resource.

**② Leave cores for audio.** The wasm SIMD thread count is capped below the core
count on purpose, so a separation never saturates the CPU and stutters playback.
Playback and controls stay primary; the separation just takes a little longer.
Threads need cross-origin isolation (`SharedArrayBuffer`) — without COI, ORT is
single-threaded anyway, which is why separation is off over plain-HTTP LAN dev
while everything else still works.

**③ iOS on-device GPU is disabled, and the reason is not ours to fix.** Real
iPhone 17 Pro Max / Safari crash-and-reloads the tab on the ORT 1.27 asyncify
build, for both models (WebKit #304810 — Asyncify + JSC OMG-JIT). A 2026-08-23
experiment betting the crash was JSEP-specific was disproven on hardware. Only the
**JSPI** build removes the trigger by construction, and that needs iOS 27. Revisit
then, not before. iOS still plays stems separated elsewhere — which is the design,
not a workaround.

## After separation

The deck runs **four synced sources** instead of one. Every device renders its own
stems (a phone does its own DSP on downloaded PCM), and each stem can be claimed by
a different FX **chain** — see [fx-rack.md](./fx-rack.md). Mobile keeps memory down
with int16 PCM and a shared-offset WSOLA rather than four independent stretchers.

## Pooling and versions

Stems are cached in R2 and indexed in D1, the same shape as analysis and lyrics.
The rule for any pooled artifact: **the version travels with the data — reuse iff
the stored version ≥ yours, else recompute and upgrade; never downgrade on
upsert.** See [analysis.md](./analysis.md), which spells the contract out.
