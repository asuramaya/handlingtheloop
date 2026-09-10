// Stem-separation backends the user can pick in Settings. ★ THE LINEUP IS SETTLED
// (operator, 2026-07-15): DEMUCS IS THE ONLY SEPARATOR. Open-Unmix (every tier), the
// demucs-rs Burn/CubeCL wasm engine, and the CPU route are all dead — separation is
// GPU-parallel work, and one engine means one cache namespace and one quality tier
// to reason about. Each model id is also its R2 cache namespace; artifacts separated
// under the pre-rip id "htdemucs-onnx" are still readable via LEGACY_STEM_IDS (the
// manifest probe in index.ts falls back to legacy namespaces on a miss).
//
// `arch` selects the worker pipeline:
//   • "dsp"         — the "Single" no-stems sentinel (plays the plain mix, no separation)
//   • "demucs-core" — the demucs body on ORT (JS STFT/iSTFT), the only real pipeline

export type StemArch = "dsp" | "demucs-core";

// Where a model can RUN:
//   • instant — no model, nothing to run
//   • gpu     — demucs core on WebGPU: desktop GPU only (mobile WebGPU = JSEP crash;
//               the CPU EP was benched and killed — "this is gpu parallel work")
// ANY result is downloadable on ANY device once it's in the shared R2 cache, so a
// phone uses every model — it just never *separates* (cache-only consumer).
export type StemTier = "instant" | "gpu";

export interface StemModel {
  id: string; // also the R2 cache key namespace
  label: string;
  kind: "dsp" | "neural";
  arch: StemArch;
  tier: StemTier;
  sizeMB: number; // approx weights download (0 for DSP); shown in the picker
  note: string; // shown under the picker
  url?: string; // the ONNX graph (demucs-core), hosted on HF, fetched once + browser-cached
}

// Model weights live on HuggingFace (our own repo): fetched cross-origin once
// (CORS-enabled, COEP-credentialless-friendly) and cached by the browser, so they
// sidestep Cloudflare's 25 MiB/asset limit and ship nothing in dist.
const HF = "https://huggingface.co/asuramaya/htl-stems/resolve/main/";

export const STEM_MODELS: StemModel[] = [
  {
    // "Single" — no stem separation; the deck plays the plain mix and the per-stem mixer is
    // hidden. The DEFAULT and the lightest path (no split, no 4× buffers). `deriveStems`
    // special-cases the id "off" (applies NO stems, optionally auto-promoting a cached
    // neural set on desktop).
    id: "off",
    label: "Single",
    kind: "dsp",
    arch: "dsp",
    tier: "instant",
    sizeMB: 0,
    note: "No stem separation — plain mix only (no stem mixer, lightest on memory)",
  },
  {
    // THE separator: the demucs core on onnxruntime-web's WebGPU EP (lean spectrogram-in
    // graph, STFT/iSTFT in JS). ~1s per 7.8s segment on a desktop GPU. fp32 — proven
    // bit-faithful vs PyTorch (maxErr 3e-6, ORT 1.21+).
    // ★ RENAMED from "htdemucs-onnx" in the onnx rip — reads of the old cache namespace
    // still work via LEGACY_STEM_NS in index.ts; writes converge on this id.
    id: "htdemucs",
    label: "Demucs",
    kind: "neural",
    arch: "demucs-core",
    tier: "gpu",
    sizeMB: 170,
    note: "Neural · best quality · needs a WebGPU desktop GPU (phones use the cache)",
    url: `${HF}demucs/htdemucs-core.onnx`,
  },
  // (The fp16 core was removed with the rest of the experiments — every stem in the
  // shared pool is fp32, and it stays that way: one engine, one precision, one
  // namespace. If an on-device mobile future ever materializes, resurrect it from
  // history — the weights are still on HF.)
];

export const DEFAULT_STEM_MODEL = "off";

// Pre-rip model ids → their successors. Consulted at every id lookup (so a stored
// setting, a room snapshot, or a pool row minted before the rename still resolves)
// and by the R2 read-fallback (LEGACY_STEM_NS in index.ts).
export const LEGACY_STEM_IDS: Record<string, string> = {
  "htdemucs-onnx": "htdemucs",
};

export function getStemModel(id: string): StemModel {
  const mapped = LEGACY_STEM_IDS[id] ?? id;
  return STEM_MODELS.find((m) => m.id === mapped) ?? STEM_MODELS[0];
}

// Whether the CURRENT device can actually run WebGPU for demucs.
// `"gpu" in navigator` only says the API EXISTS — an adapter can still be
// unavailable (driver blocklisted, or WebGPU not enabled in the browser, common
// on Linux Chrome even with a real GPU). So we ACTIVELY REQUEST the GPU: ask for
// the high-performance (discrete) adapter — on dual-GPU machines the default can
// return the weak integrated one or none — then confirm a real device is grantable. That device acquisition is
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
      // Android stay cache-only.
      if (isMobileDevice() && !mobileGpuEligible()) return (gpuAdapterOk = false);
      const gpu: any = (navigator as any).gpu;
      if (!gpu) return (gpuAdapterOk = false);
      const adapter =
        (await gpu.requestAdapter({ powerPreference: "high-performance" })) || (await gpu.requestAdapter());
      if (!adapter) return (gpuAdapterOk = false);
      // Record which GPU we got (so Settings can show Intel iGPU vs NVIDIA). `info`
      // is sync in current browsers; older ones expose requestAdapterInfo().
      let architecture = "";
      try {
        const info: any =
          adapter.info ?? (typeof adapter.requestAdapterInfo === "function" ? await adapter.requestAdapterInfo() : null);
        if (info) {
          architecture = info.architecture ?? "";
          gpuAdapterInfo =
            [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ").trim() || null;
        }
      } catch {
        /* adapter info unavailable; ignore */
      }
      // A GRANTED adapter isn't necessarily real hardware — Chrome can (and, on this
      // exact dual-GPU Linux + NVIDIA combo, silently DOES) hand back SwiftShader, its
      // CPU-emulated software WebGPU implementation, even with both #enable-unsafe-webgpu
      // and #ignore-gpu-blocklist on. `requestDevice()` on that still succeeds — nothing
      // throws — so without this check the app declared GPU "usable" and ran separation
      // on it anyway. Not a soft-failure: SwiftShader is roughly 1000x slower on this
      // model (measured earlier this session: ~200s/segment on SwiftShader vs well under
      // 1s on the real GPU) — indistinguishable from "stuck at 0%" from the outside.
      // `isFallbackAdapter` is the spec-correct signal; the architecture-string check is
      // a belt-and-suspenders backstop for browsers that don't set the flag consistently.
      if ((adapter as any).isFallbackAdapter || architecture === "swiftshader") return (gpuAdapterOk = false);
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
// RE-DISABLED (2026-08-26): the 2026-08-23 experiment (re-enabling this on the 1.27
// native WebGPU EP asyncify build, betting the crash was JSEP-specific) is now
// DISPROVEN on real hardware. Real iPhone 17 Pro Max / Safari test confirmed the
// crash-and-reload (WebKit bug #304810, Asyncify + JSC OMG-JIT pathology) still
// fires on the 1.27 asyncify build, for BOTH SCNet_Tran AND htdemucs-core (the
// model actually shipped) — i.e. every real iOS device's first on-device-GPU
// attempt crashes the tab, guard or no guard. This almost certainly explains the
// "no audio at all on iPhone" reports from the same session this was re-enabled in.
// Only the JSPI build variant (needs iOS 27 / Safari 27, currently beta, GA ~Sept
// 2026) removes the trigger by construction — revisit re-enabling THEN, not before.
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

// ─── Mobile stem-DOWNLOAD crash guard ────────────────────────────────────────
//
// ★ REDESIGNED 2026-09-10 (operator: "investigate this on mobile and desktop, redesign it to the
// current shape and make it nice"). What was here guarded a path that no longer exists, and had
// been inert since 2026-07-15 two independent ways: nothing ARMED it (its only two call sites went
// out with 3a5d512's revert of the CPU separation bench), and nothing branched on the level it
// reported — so its Settings notice announced a downgrade that never happened. Its level 1, "DSP
// split only", named a path deleted in f2004f2.
//
// THE INVESTIGATION, because a redesign has to be aimed at where a tab can still die TODAY:
//   • DESKTOP separation is already guarded, correctly, by the GPU crash guard below —
//     armGpu/disarmGpu around the work, and `gpuBlocked` genuinely gates modelSupport(). That is
//     the pattern this one now copies, rather than inventing a second one.
//   • MOBILE never separates at all: mobileGpuEligible() is hardcoded false, so modelSupport
//     returns "needs-gpu" for every phone and loadStems throws before any model runs.
//   • WHICH LEAVES ONE LIVE PATH: a phone DOWNLOADING and decoding a cached set.
//     MOBILE_STEM_BYTE_BUDGET already declines an over-budget load — but it projects the RESIDENT
//     int16 footprint (16 B/sample), and what kills the tab is the DECODE PEAK, which is float32
//     and transient. A set can pass the resident projection and still die on the way in. That gap
//     is what this guard is for, and it is the only thing it is for.
//
// The pattern is the GPU guard's, because that one is proven: ARM in localStorage immediately
// before the download+decode, DISARM once it settles (success OR caught failure — both mean the
// tab survived). A fresh load finding it still armed can only mean the tab went down mid-load.
// Escalating, so the loop terminates:
//   level 0 → fetch cached stems normally
//   level 1 → do not AUTO-fetch; asking for stems explicitly still works   (after 1 crash)
//   level 2 → stay on the plain mix                                        (after 2 crashes)
// Level 1 is deliberately not "no stems": one bad track should not cost the feature, and the
// tracks that trip this are the long ones. The user keeps the door.
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
/** Arm immediately before a mobile stem download+decode. */
export function armStemLoad(): void {
  try {
    localStorage.setItem(STEM_ARM_KEY, "1");
  } catch {
    /* no localStorage — just don't guard */
  }
}
/** Disarm once it settles, success OR caught failure: both mean the tab survived. */
export function disarmStemLoad(): void {
  try {
    localStorage.removeItem(STEM_ARM_KEY);
  } catch {
    /* ignore */
  }
}
/** Should a phone AUTO-fetch a cached stem set? False once a load has taken the tab down. */
export function stemAutoFetchAllowed(): boolean {
  return stemFails < 1;
}
/** Should stems be offered at all? False after two crashes — the terminating rung. */
export function stemsAllowed(): boolean {
  return stemFails < 2;
}
// 0 = fetch normally · 1 = no AUTO-fetch (asking still works) · >=2 = plain mix only.
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
// is built and tested against. Elsewhere there is NO separation at all — no fallback
// bundle, no CPU EP (benched and killed) — so the Safari JSEP memory-leak crash
// (onnxruntime#26827) and Firefox device-losts can't happen: those browsers are
// cache-only consumers, gated by modelSupport/canSeparate before any worker exists.
export function isChromium(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Chrome\/|Chromium\//.test(navigator.userAgent);
}

// Is the WebGPU runtime actually in play for separation? Only on Chromium with a
// usable adapter — everywhere else this device does not separate at all.
export function gpuRuntimeAvailable(): boolean {
  return isChromium() && hasWebGPU();
}

// What this device can do with a given model RIGHT NOW (ignoring the cache):
//   • "instant"     — DSP, runs anywhere with no download
//   • "runs"        — this device can separate it on-device
//   • "needs-gpu"   — needs a WebGPU desktop (phones: use the cache)
//   • "blocked"     — GPU separation disabled after it crashed the tab (re-enable in Settings)
export type ModelSupport = "instant" | "runs" | "needs-gpu" | "blocked";

export function modelSupport(model: StemModel): ModelSupport {
  if (model.tier === "instant") return "instant";
  // gpu — the only real tier, and CHROMIUM-ONLY: the JSEP WebGPU EP is built and
  // tested against Chromium; Safari's JSEP build leaks catastrophically (#26827) and
  // Firefox device-losts under heavy compute. There is NO fallback route — the CPU EP
  // was benched and killed ("this is gpu parallel work") — so a non-Chromium browser
  // is a cache-only consumer, exactly like a phone. Hard-disabled after a prior tab
  // crash until the user re-enables it.
  if (gpuBlocked) return "blocked";
  if (isMobileDevice()) return mobileGpuEligible() ? "runs" : "needs-gpu";
  if (!isChromium()) return "needs-gpu";
  return hasWebGPU() ? "runs" : "needs-gpu";
}

// Can this device separate this model on-device (so loadStems should attempt it)?
export function deviceSupportsModel(model: StemModel): boolean {
  const s = modelSupport(model);
  return s === "instant" || s === "runs";
}
