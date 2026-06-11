// Stem-separation backends the user can pick in Settings. The menu grows over
// time — each model id is also its R2 cache namespace, so a track's stems cache
// per model and switching never clobbers another model's results.
//
// `arch` selects the worker pipeline:
//   • "dsp"       — no model, instant band/centre split (src/htl/stems dspStems)
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
    id: "dsp",
    label: "DSP split",
    kind: "dsp",
    arch: "dsp",
    tier: "instant",
    sizeMB: 0,
    note: "Instant · no download · band/centre isolator (drums approximate)",
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
  // (HT-Demucs CPU removed — demucs only runs on the GPU. The CPU/wasm path is too
  // memory-heavy for a phone, and on a desktop the GPU path is strictly better.
  // Lineup: DSP everywhere, Open-Unmix (CPU) desktop+mobile, HT-Demucs (GPU) desktop.)
];

export const DEFAULT_STEM_MODEL = "dsp";

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

// Human-readable description of the WebGPU adapter we acquired (vendor/arch/device),
// once probed — so the UI can show WHICH GPU is in use (e.g. Intel iGPU vs NVIDIA).
// Browsers often blank vendor/device for privacy; we show whatever is populated.
export function webGpuAdapterInfo(): string | null {
  return gpuAdapterInfo;
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

// Browsers where on-device WebGPU separation is UNTESTED / known-flaky and should
// be dimmed with a warning (still selectable — the crash guard protects the user).
// Firefox's Linux WebGPU device-losts on heavy compute; Safari desktop is unproven.
export function isUntestedGpuPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return true;
  // Desktop Safari (not Chromium-based, not mobile): WebGPU compute unproven for this.
  if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua) && !isMobileDevice()) return true;
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
    // small int8 nets (CPU wasm) run on desktop and reasonably modern phones.
    return cores >= 2 ? "runs" : "desktop";
  }
  if (model.tier === "cpu") {
    // demucs core on the wasm/CPU backend. Runs on desktop AND phones — on mobile it
    // separates WINDOWED (separateDemucsWindowed) so the worker holds one window's
    // output, not the whole-track 424 MB that OOM-crashed Safari. Slow, but stable.
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
