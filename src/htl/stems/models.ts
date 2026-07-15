// Stem-separation backends the user can pick in Settings. The menu grows over
// time — each model id is also its R2 cache namespace, so a track's stems cache
// per model and switching never clobbers another model's results.
//
// `arch` selects the worker pipeline:
//   • "dsp"       — the "Single" no-stems sentinel (kind/arch typed dsp to satisfy the union;
//                   plays the plain mix, no separation — there is NO band/centre DSP split)
//   • "openunmix" — spectrogram magnitude nets + softmask (separator.worker.ts)
//   • "demucs"    — waveform-domain (reserved; pending an ONNX export)
import type { StemName } from "./index";

export type StemArch = "dsp" | "openunmix" | "demucs" | "demucs-core";

// How heavy a model is to RUN on-device, which decides where it can separate:
//   • instant — DSP, no model, everywhere
//   • light   — small int8 net (CPU wasm): desktop AND modern phones
//   • heavy   — fp32 net: desktop only (too much RAM for a phone tab)
//   • gpu     — demucs core on WebGPU: desktop GPU only (mobile WebGPU = JSEP crash)
//   • cpu     — demucs core on the wasm/CPU backend: runs ON-DEVICE anywhere with
//               ≥2 cores (incl. iPhone — the stable backend that doesn't crash),
//               just slow; it's the no-GPU fallback / iPhone on-device path
// ANY tier's RESULT is downloadable on ANY device once it's in the shared R2 cache,
// so a phone can use every model — it just can't *separate* the heavy/gpu ones itself.
export type StemTier = "instant" | "light" | "heavy" | "gpu" | "cpu";

export interface StemModel {
  id: string; // also the R2 cache key namespace
  label: string;
  kind: "dsp" | "onnx";
  arch: StemArch;
  tier: StemTier;
  sizeMB: number; // approx weights download (0 for DSP); shown in the picker
  note: string; // shown under the picker
  urls?: Record<StemName, string>; // per-target onnx (openunmix arch)
  url?: string; // single weights file (demucs arch): safetensors
  refUrl?: string; // fp32 reference model (demucs-core fp16 self-check compares against this)
  needsShaderF16?: boolean; // fp16 model: only offer it when the adapter exposes the shader-f16 feature
  wasmModel?: string; // (legacy demucs-rs model id — no longer used by any model)
  eps?: string[]; // ORT execution providers (demucs-core): GPU → default, CPU → ["wasm"]
}

// Open-Unmix ONNX exports live on HuggingFace (our own repo) — same pattern:
// fetched cross-origin once (CORS-enabled, COEP-credentialless-friendly) and cached
// by the browser, so they sidestep Cloudflare's 25 MiB/asset limit and ship nothing
// in dist. To add a tier, upload its .onnx and point a registry entry's urls here.
const UMX_HF = "https://huggingface.co/asuramaya/htl-stems/resolve/main/";

const UMX = (file: (t: StemName) => string): Record<StemName, string> => ({
  vocals: file("vocals"),
  drums: file("drums"),
  bass: file("bass"),
  other: file("other"),
});

export const STEM_MODELS: StemModel[] = [
  {
    // "Single" — no stem separation; the deck plays the plain mix and the per-stem mixer is
    // hidden. The DEFAULT and the lightest path (no split, no 4× buffers). Typed `dsp`/
    // `instant` to satisfy the unions; `deriveStems` special-cases the id "off" (applies NO
    // stems, optionally auto-promoting a cached neural set on desktop). The old "DSP split"
    // entry was dropped — its band/centre approximation was poor, so it's single OR neural.
    id: "off",
    label: "Single",
    kind: "dsp",
    arch: "dsp",
    tier: "instant",
    sizeMB: 0,
    note: "No stem separation — plain mix only (no stem mixer, lightest on memory)",
  },
  {
    // The ONLY Open-Unmix tier we ship. By ear, int8 "L" is the best Open-Unmix —
    // the fp32 difference is negligible — and it's light enough to separate
    // on-device on a phone CPU (ORT wasm, no WebGPU), so it's the default neural
    // splitter on iPhone. The HQ + fp32 variants were dropped (all platforms).
    id: "umxl-int8",
    label: "Open-Unmix",
    kind: "onnx",
    arch: "openunmix",
    tier: "light",
    sizeMB: 112,
    note: "Neural · runs on desktop & phones, then cached for everyone",
    urls: UMX((t) => `${UMX_HF}openunmix-l/${t}.int8.onnx`),
  },
  {
    // The demucs CORE on onnxruntime-web's WebGPU EP (lean spectrogram-in graph,
    // STFT/iSTFT in JS). ~1s per 7.8s segment on a desktop GPU — no autotune, no
    // wasm OOM. This is the fast path; the Burn/CubeCL "htdemucs" above is legacy.
    // Hosted on HF (asuramaya/htl-stems), fetched once + browser-cached like the others.
    id: "htdemucs-onnx",
    label: "HT-Demucs (GPU)",
    kind: "onnx",
    arch: "demucs-core",
    tier: "gpu",
    sizeMB: 170,
    // fp32 core. We tried the fp16 core (86 MB) but ORT-web's WebGPU EP MISCOMPUTES
    // it → corrupted/noisy stems on desktop (the CPU EP runs fp16 fine, but the
    // WebGPU f16 shader path is wrong, like the older 1.20 fp32 freq-branch bug). So
    // GPU demucs stays fp32 (proven correct on WebGPU). It's desktop-only anyway —
    // demucs-GPU is hidden on mobile (iOS WebGPU crashes), so the 170 MB / 128 MiB
    // iOS buffer-binding limit is moot here.
    note: "Neural · best quality · needs a WebGPU desktop GPU (phones use the cache)",
    url: `${UMX_HF}demucs/htdemucs-core.onnx`,
  },
  {
    // EXPERIMENTAL fp16 demucs core (86 MB, half of fp32). A past attempt saw the ORT-web
    // WebGPU EP miscompute f16 → noisy stems, but that was never root-caused and ORT is now
    // 1.22 (which already FIXED the 1.20 fp32 freq-branch miscompute — same bug class). The
    // export is mixed-precision (explicit Cast around each InstanceNorm, the f16-sensitive op),
    // so it's carefully built. fp16 is the one speedup that LOWERS GPU contention (half the
    // compute → the compositor gets more paint windows → smoother UI, not worse), so it's worth
    // re-verifying on 1.22 + a modern GPU. Non-default — pick it to A/B. On the first segment the
    // worker self-checks fp16 vs the fp32 ref and logs the max error (open devtools console).
    id: "htdemucs-onnx-f16",
    label: "HT-Demucs fp16 (test)",
    kind: "onnx",
    arch: "demucs-core",
    tier: "gpu",
    sizeMB: 86,
    note: "Experimental fp16 — faster IF WebGPU computes it right; self-checks vs fp32 (see console)",
    url: `${UMX_HF}demucs/htdemucs-core-fp16.onnx`,
    refUrl: `${UMX_HF}demucs/htdemucs-core.onnx`,
    needsShaderF16: true, // hidden from the picker until the adapter exposes shader-f16 (else f16 shaders → noise)
  },
  // (HT-Demucs CPU removed — demucs only runs on the GPU. The CPU/wasm path is too
  // memory-heavy for a phone, and on a desktop the GPU path is strictly better.
  // Lineup: Single (no stems) everywhere, Open-Unmix (CPU) desktop+mobile, HT-Demucs
  // (GPU) desktop. The old DSP band/centre split was dropped — single OR neural.)
];

export const DEFAULT_STEM_MODEL = "off";

export function getStemModel(id: string): StemModel {
  return STEM_MODELS.find((m) => m.id === id) ?? STEM_MODELS[0];
}

// Whether the CURRENT device can actually run WebGPU for the demucs-rs path.
// `"gpu" in navigator` only says the API EXISTS — an adapter can still be
// unavailable (driver blocklisted, or WebGPU not enabled in the browser, common
// on Linux Chrome even with a real GPU). So we ACTIVELY REQUEST the GPU: ask for
// the high-performance (discrete) adapter — on dual-GPU machines the default can
// return the weak integrated one or none, and this matches what wgpu/demucs-rs
// requests — then confirm a real device is grantable. That device acquisition is
// the actual WebGPU "permission/access". The result is cached and the badge/gating
// reflect what genuinely runs, flipping to usable the moment WebGPU is enabled.
/* eslint-disable @typescript-eslint/no-explicit-any */
let gpuAdapterOk: boolean | null = null;
let gpuProbe: Promise<boolean> | null = null;
let gpuAdapterInfo: string | null = null;
let gpuShaderF16 = false; // does the acquired adapter expose the WGSL `shader-f16` feature?

// Human-readable description of the WebGPU adapter we acquired (vendor/arch/device),
// once probed — so the UI can show WHICH GPU is in use (e.g. Intel iGPU vs NVIDIA).
// Browsers often blank vendor/device for privacy; we show whatever is populated.
export function webGpuAdapterInfo(): string | null {
  return gpuAdapterInfo;
}
// Does the acquired WebGPU adapter expose the WGSL `shader-f16` feature? (Gates the fp16
// demucs model — without it, f16 shaders fail to compile → garbage stems, so we hide it.)
export function webGpuShaderF16(): boolean {
  return gpuShaderF16;
}
export function probeWebGPU(): Promise<boolean> {
  if (gpuProbe) return gpuProbe;
  gpuProbe = (async () => {
    try {
      // Mobile generally doesn't run the GPU path on-device — EXCEPT iOS 26+,
      // which ships WebGPU (compute shaders) default-on. There we DO acquire a
      // device and let HT-Demucs attempt separation (experimental). Older iOS and
      // Android stay cache-only (the Burn wasm OOMs them).
      if (isMobileDevice() && !mobileGpuEligible()) return (gpuAdapterOk = false);
      const gpu: any = (navigator as any).gpu;
      if (!gpu) return (gpuAdapterOk = false);
      const adapter =
        (await gpu.requestAdapter({ powerPreference: "high-performance" })) || (await gpu.requestAdapter());
      if (!adapter) return (gpuAdapterOk = false);
      // Whether f16 WGSL shaders can run at all (gates the fp16 demucs model's visibility).
      // Brand-new on the Linux+NVIDIA WebGPU path (Chrome 147–148 enabled WebGPU there; the
      // shader-f16 feature lags) — so this is false on that stack today, true on most macOS/
      // Windows. The fp16 model auto-appears in the picker the day this flips true.
      gpuShaderF16 = !!adapter.features?.has?.("shader-f16");
      // Record which GPU we got (so Settings can show Intel iGPU vs NVIDIA). `info`
      // is sync in current browsers; older ones expose requestAdapterInfo().
      try {
        const info: any =
          adapter.info ?? (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : null);
        if (info) {
          gpuAdapterInfo =
            [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ").trim() || null;
        }
      } catch {
        /* adapter info unavailable; ignore */
      }
      // Adapter present ≠ usable — confirm a device is actually grantable.
      const device = await adapter.requestDevice();
      if (!device) return (gpuAdapterOk = false);
      try {
        device.destroy?.();
      } catch {
        /* probe-only device; ignore */
      }
      return (gpuAdapterOk = true);
    } catch {
      return (gpuAdapterOk = false);
    }
  })();
  return gpuProbe;
}
if (typeof navigator !== "undefined") void probeWebGPU(); // request GPU access at load

function hasWebGPU(): boolean {
  // Use the probed adapter result once known; before then, fall back to API presence.
  return gpuAdapterOk ?? (typeof navigator !== "undefined" && "gpu" in navigator);
}

// Is this device a phone/tablet? (iPadOS ≥13 reports a desktop UA, so also catch
// touch-capable "Macintosh".)
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iPadOS = navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOS;
}

// Is this an iOS/iPadOS device? (iPadOS ≥13 reports a desktop "Macintosh" UA, so
// also catch touch-capable Mac.)
export function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

// Phones allowed to ATTEMPT on-device WebGPU separation (experimental): iOS only,
// gated on WebGPU API PRESENCE — NOT on the iOS version number (Safari freezes its
// UA string, so an iOS-26 phone can report an older "OS 18_0", which made a
// version check spuriously deny a capable device) and NOT on the async probe
// (which can fail at page-load before a user gesture). iOS 26 is the first WebKit
// to ship WebGPU default-on, so `"gpu" in navigator` on iOS already implies ≥26.
//
// DISABLED (2026-06-10): the iPhone experiment confirmed on-device demucs via
// ORT-web's WebGPU EP HARD-crashes Safari 26 — the documented JSEP memory leak
// (onnxruntime#26827: runaway memory, tab killed), not a soft failure a try/catch
// can catch. So phones do NOT attempt on-device GPU separation; they use the R2
// cache for demucs results (desktop separates once → every phone downloads it).
// The fp16 core is ready for the day we move to a NON-JSEP WebGPU runtime
// (transformers.js v4 / ORT per-segment device recycling); flip this back then.
export function mobileGpuEligible(): boolean {
  return false;
}

// ─── WebGPU crash-loop guard ──────────────────────────────────────────────────
// A GPU separation can HARD-crash the whole tab (Firefox-Linux "device lost" kills
// the process), so a caught-error fallback isn't enough: on reload the app would
// re-attempt the same model and crash again — a loop. Guard pattern: ARM a flag in
// localStorage right before GPU work and DISARM it after (success OR a caught
// error — both mean the tab survived). If a fresh page load finds the flag still
// armed, the previous attempt took the tab down → BLOCK GPU separation until the
// user explicitly re-enables it. Safe across reloads, self-healing on opt-in.
const GPU_ARM_KEY = "htl:gpuArm";
const GPU_BLOCK_KEY = "htl:gpuBlocked";
let gpuBlocked = false;

// Call once at startup. Returns true if the last GPU attempt crashed the tab.
export function initGpuCrashGuard(): boolean {
  try {
    if (localStorage.getItem(GPU_BLOCK_KEY) === "1") gpuBlocked = true;
    if (localStorage.getItem(GPU_ARM_KEY)) {
      localStorage.removeItem(GPU_ARM_KEY);
      localStorage.setItem(GPU_BLOCK_KEY, "1");
      gpuBlocked = true;
      return true; // armed-but-never-disarmed ⇒ the tab crashed mid-separation
    }
  } catch {
    /* no localStorage (private mode / blocked) — just don't guard */
  }
  return false;
}
export function armGpu(modelId: string): void {
  try {
    localStorage.setItem(GPU_ARM_KEY, modelId);
  } catch {
    /* ignore */
  }
}
export function disarmGpu(): void {
  try {
    localStorage.removeItem(GPU_ARM_KEY);
  } catch {
    /* ignore */
  }
}
export function isGpuBlocked(): boolean {
  return gpuBlocked;
}
// User opt-in to try GPU again after a crash auto-disabled it.
export function unblockGpu(): void {
  gpuBlocked = false;
  try {
    localStorage.removeItem(GPU_BLOCK_KEY);
    localStorage.removeItem(GPU_ARM_KEY);
  } catch {
    /* ignore */
  }
}

// ─── Mobile stem-load crash-loop guard (ESCALATING) ─────────────────────────────
// Loading stems on a phone decodes ~424 MB per set; doing it for BOTH decks on the
// first-run seed blew the iOS tab budget → OOM → Safari auto-reloads → the seed
// re-runs → crash again = a REFRESH LOOP. A boolean block can't break it: once
// neural is blocked, both decks fall to the DSP split, which ALSO decodes ~424 MB
// and OOMs — and DSP can't be "blocked" or there'd be nothing to show.
//
// So the guard ESCALATES, guaranteeing the loop terminates:
//   level 0 → try best cached neural, else DSP
//   level 1 → DSP split only (skip neural)            (after 1 crash)
//   level 2 → NO stems — play the plain mix           (after 2 crashes; can't OOM)
// Arm in localStorage right before ANY stem work, disarm after (success or caught
// error). A fresh load that finds it still armed ⇒ the tab crashed → bump the level.
const STEM_ARM_KEY = "htl:stemArm";
const STEM_FAILS_KEY = "htl:stemFails";
let stemFails = 0;

// Call once at startup. Returns the current fail level (0/1/2+).
export function initStemCrashGuard(): number {
  try {
    stemFails = parseInt(localStorage.getItem(STEM_FAILS_KEY) || "0", 10) || 0;
    if (localStorage.getItem(STEM_ARM_KEY)) {
      localStorage.removeItem(STEM_ARM_KEY);
      stemFails += 1; // armed-but-never-disarmed ⇒ a stem load took the tab down
      localStorage.setItem(STEM_FAILS_KEY, String(stemFails));
    }
  } catch {
    /* no localStorage — just don't guard */
  }
  return stemFails;
}
export function armStemLoad(): void {
  try {
    localStorage.setItem(STEM_ARM_KEY, "1");
  } catch {
    /* ignore */
  }
}
export function disarmStemLoad(): void {
  try {
    localStorage.removeItem(STEM_ARM_KEY);
  } catch {
    /* ignore */
  }
}
// 0 = neural+DSP ok · 1 = DSP only · ≥2 = no stems (plain mix).
export function stemFailLevel(): number {
  return stemFails;
}
// User opt-in to retry full-quality stems after a crash downgraded them.
export function resetStemGuard(): void {
  stemFails = 0;
  try {
    localStorage.removeItem(STEM_FAILS_KEY);
    localStorage.removeItem(STEM_ARM_KEY);
  } catch {
    /* ignore */
  }
}

// ─── Clean-unload disarm: a user REFRESH must not look like a crash ──────────────
// Both guards above arm a localStorage flag right before the heavy job and disarm it
// after (in a finally). A voluntary refresh/close unloads the page BEFORE that finally
// runs, so the flag would survive and the next load would wrongly read it as "the tab
// crashed mid-job" → block GPU / escalate the stem guard, even though nothing crashed.
// KEY ASYMMETRY: a real GPU-induced renderer crash (the Aw-Snap this guard exists for)
// does NOT fire pagehide, whereas a deliberate refresh/close DOES. So clearing the ARM
// flags on pagehide makes ONLY a genuine crash leave them set — a refresh mid-separation
// no longer disables GPU. (BLOCK/FAIL keys are untouched: a tab already auto-disabled
// stays disabled until the user re-enables it.) The reload then just re-runs the
// separation from scratch — the practical "resume", since the worker/GPU job state is
// gone on unload and can't be continued mid-segment.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    try {
      localStorage.removeItem(GPU_ARM_KEY);
      localStorage.removeItem(STEM_ARM_KEY);
    } catch {
      /* no localStorage (private mode) — nothing to clear */
    }
  });
}

// Chromium family (Chrome / Edge / Brave / Opera / Chromium). This is the ONLY place
// we drive the ORT WebGPU (JSEP) execution provider: it's the engine the JSEP backend
// is built and tested against. Elsewhere the separator worker loads the plain-wasm ORT
// bundle and runs demucs on the CPU EP instead (see separator.worker.ts ORT_CDN) — so
// the Safari JSEP memory-leak crash (onnxruntime#26827) and Firefox device-losts can't
// happen. The worker's own UA check (`USE_WEBGPU`) mirrors this exactly.
export function isChromium(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Chrome\/|Chromium\//.test(navigator.userAgent);
}

// Is the FAST WebGPU runtime actually in play for separation? Only on Chromium with a
// usable adapter — everywhere else demucs runs on the stable (slower) wasm CPU EP. The
// UI uses this to label the device as GPU vs CPU and set the speed expectation.
export function gpuRuntimeAvailable(): boolean {
  return isChromium() && hasWebGPU();
}

// Browsers where on-device GPU separation would be UNTESTED / known-flaky. Now that
// non-Chromium falls back to the stable wasm bundle (the JSEP/WebGPU path runs ONLY on
// Chromium, where it's proven), no platform attempts an untested GPU path — so there's
// nothing left to warn about. Kept exported (callers reference it) but always false.
export function isUntestedGpuPlatform(): boolean {
  return false;
}

// What this device can do with a given model RIGHT NOW (ignoring the cache):
//   • "instant"     — DSP, runs anywhere with no download
//   • "runs"        — this device can separate it on-device
//   • "desktop"     — too heavy here; a desktop must separate it (then it caches)
//   • "needs-gpu"   — needs a WebGPU desktop
//   • "blocked"     — GPU separation disabled after it crashed the tab (re-enable in Settings)
export type ModelSupport = "instant" | "runs" | "desktop" | "needs-gpu" | "blocked";

export function modelSupport(model: StemModel): ModelSupport {
  if (model.tier === "instant") return "instant";
  const mobile = isMobileDevice();
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2;
  if (model.tier === "gpu") {
    // Hard-disabled after a prior tab crash, until the user re-enables it.
    if (gpuBlocked) return "blocked";
    // demucs-rs (Burn wasm + WebGPU). Decouple the two paths so the mobile gate
    // never gets vetoed by the desktop probe:
    //   • mobile → iOS-with-WebGPU (experimental); the wasm + DSP fallback handle
    //     the actual capability, so don't also require the async probe to pass.
    //   • desktop → require a probed, grantable device (hasWebGPU).
    if (mobile) return mobileGpuEligible() ? "runs" : "needs-gpu";
    return hasWebGPU() ? "runs" : "needs-gpu";
  }
  if (model.tier === "light") {
    // small int8 nets (CPU wasm). PHONES DO NOT SEPARATE — even the int8 Open-Unmix
    // OOM-crashes iOS Safari mid-job, and since nothing is persisted until it
    // finishes, the still-selected model re-separates on reload → crash LOOP (there's
    // no crash-guard on the CPU/wasm path like there is for GPU). Phones are
    // cache-first → DSP fallback; a desktop separates once and shares via R2.
    if (mobile) return "desktop";
    return cores >= 2 ? "runs" : "desktop";
  }
  if (model.tier === "cpu") {
    // demucs core on the wasm/CPU backend. Desktop only, same reason as "light":
    // on-device neural separation on a phone OOM-crash-loops Safari.
    if (mobile) return "desktop";
    return cores >= 2 ? "runs" : "desktop";
  }
  // heavy fp32 — desktop only.
  return !mobile && cores >= 4 ? "runs" : "desktop";
}

// Can this device separate this model on-device (so loadStems should attempt it)?
export function deviceSupportsModel(model: StemModel): boolean {
  const s = modelSupport(model);
  return s === "instant" || s === "runs";
}
