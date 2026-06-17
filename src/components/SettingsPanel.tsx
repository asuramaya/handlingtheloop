import { useEffect, useState } from "react";
import {
  type Settings,
  type StretchQuality,
  type StretchEngine,
  STRETCH_PRESETS,
  type StemQuality,
  STEM_PRESETS,
  STEM_MODELS,
  getStemModel,
  modelSupport,
  isMobileDevice,
  isChromium,
  fetchStemManifest,
  hasStemsLocal,
  probeWebGPU,
  webGpuAdapterInfo,
  webGpuShaderF16,
  isGpuBlocked,
  unblockGpu,
  stemFailLevel,
  resetStemGuard,
  isUntestedGpuPlatform,
  type StemModel,
} from "@htl";
import type { StemStatus, DebugSection } from "../App";
import { type UseMidi } from "@htl/midi";
import { MidiPanel } from "./MidiPanel";
import { LyricsSettings } from "./LyricsSettings";
import { DockResizer } from "./DockResizer";
import { AboutTab } from "./settings/AboutTab";
import { ColorTab } from "./settings/ColorTab";
import { ControlsTab } from "./settings/ControlsTab";
import { DebugTab } from "./settings/DebugTab";
import { Slider } from "./settings/Slider";
// Account & connections moved to the full-screen Profile (see ProfileScreen).

interface SettingsPanelProps {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
  loadedVideoIds?: string[]; // tracks currently on the decks (for per-model cache state)
  stemStatus?: Record<"A" | "B", StemStatus | null>; // live per-deck separation status/errors
  onReanalyze?: (modelId: string) => void; // force a fresh separation of the loaded track(s)
  onGpuReenable?: () => void; // user opted to re-enable GPU after a crash auto-disabled it
  outputSupported?: boolean; // browser can route to a chosen output device (AudioContext.setSinkId)
  debug?: () => DebugSection[]; // live engine/session/device diagnostics (Debug tab)
  midi?: UseMidi; // USB-MIDI controller status + learn (MIDI tab)
}

// What each model can do on THIS device, as a short badge for the picker.
function supportBadge(m: StemModel): { text: string; cls: string } {
  switch (modelSupport(m)) {
    case "instant":
      return { text: "Instant", cls: "ok" };
    case "runs":
      // demucs on the CPU backend runs everywhere but is SLOW — set the expectation.
      if (m.tier === "cpu")
        return { text: `Runs here (slow) · ${m.sizeMB} MB`, cls: "warn" };
      return { text: isMobileDevice() ? `Runs on phone · ${m.sizeMB} MB` : `Runs here · ${m.sizeMB} MB`, cls: "ok" };
    case "needs-gpu":
      // On a phone it's gated for memory; on desktop it just needs WebGPU enabled.
      return { text: isMobileDevice() ? "Desktop GPU only" : "Enable WebGPU to run here", cls: "warn" };
    case "blocked":
      return { text: "Disabled — crashed here", cls: "warn" };
    default:
      // Mobile can't separate neural on-device (OOM-crashes Safari) — it's
      // download-only: adopt the stems once a desktop has separated that track.
      return { text: isMobileDevice() ? "Cached only · a desktop separates" : "Desktop separates", cls: "warn" };
  }
}

type Tab = "color" | "controls" | "midi" | "audio" | "debug" | "about";
const TABS: { key: Tab; label: string }[] = [
  { key: "color", label: "Color" },
  { key: "controls", label: "Controls" },
  { key: "midi", label: "MIDI" },
  { key: "audio", label: "Audio" },
  { key: "debug", label: "Debug" },
  { key: "about", label: "About" },
];

// Settings modal, organised into tabs: Color (theme), Deck (feel), Accounts
// (sign-in + streaming cookie), Info (about), FAQ (how it works & privacy).
export function SettingsPanel({
  settings,
  onChange,
  onClose,
  loadedVideoIds = [],
  stemStatus,
  onReanalyze,
  onGpuReenable,
  outputSupported = false,
  debug,
  midi,
}: SettingsPanelProps) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const [tab, setTab] = useState<Tab>("color");

  // Audio OUTPUT devices (speaker select). enumerateDevices only fills in `label`
  // once the page has been granted mic permission at least once; until then the OS
  // hides device names. `outputNeedsPerm` tracks that so we can offer a one-tap
  // "Show device names" that asks for (and immediately drops) a mic stream. Listed
  // only when the Audio tab is open and the browser supports setSinkId.
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [outputNeedsPerm, setOutputNeedsPerm] = useState(false);
  const [outputPermErr, setOutputPermErr] = useState(""); // why a reveal failed (blocked / no device)
  useEffect(() => {
    if (tab !== "audio" || !outputSupported || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
        if (cancelled) return;
        setOutputs(devs);
        // labels blank = permission not yet granted (names hidden by the OS)
        setOutputNeedsPerm(devs.length > 0 && devs.every((d) => !d.label));
      } catch {
        /* enumerate can throw in locked-down contexts; just show none */
      }
    };
    void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [tab, outputSupported]);

  // One-shot: ask for mic permission so enumerateDevices reveals output labels,
  // then immediately stop the stream (we never record — we only want the names).
  const revealOutputNames = async () => {
    setOutputPermErr("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
      setOutputs(devs);
      setOutputNeedsPerm(devs.length > 0 && devs.every((d) => !d.label));
    } catch (e) {
      // Surface WHY instead of silently no-op'ing (the old behaviour looked like the
      // button did nothing). NotAllowedError = blocked by the user OR by a restrictive
      // Permissions-Policy (microphone=()); NotFoundError = no input device.
      const name = e instanceof DOMException ? e.name : "";
      setOutputPermErr(
        name === "NotAllowedError"
          ? "Microphone access is blocked — allow it for this site (it's only used to read device names; nothing is recorded). On the deployed site this needs the latest build."
          : name === "NotFoundError"
            ? "No audio input device found — your OS hides output names until some audio device is available."
            : "Couldn't read device names on this browser.",
      );
    }
  };

  // Per-model cache state for the tracks currently on the decks: a model is
  // "cached" (usable on ANY device, incl. phones) if every loaded track already
  // has its four stems in R2. Probed when the Stems tab is open.
  const [cachedModels, setCachedModels] = useState<Record<string, boolean>>({});
  const loadedKey = loadedVideoIds.join(",");
  // Refresh badges once the real WebGPU-adapter probe resolves (so GPU models flip
  // to "Runs here" the moment WebGPU is actually available).
  const [, setGpuProbed] = useState(false);
  useEffect(() => {
    probeWebGPU().then(() => setGpuProbed(true));
  }, []);
  // A model is "cached for the loaded track(s)" if EVERY loaded track has its stems
  // either on local disk (instant) OR complete in the shared R2 cache. We check
  // local FIRST (cheap, and it's what the "loaded from disk" status reflects) and
  // only hit the network when local misses. The result is NOT blanked on tab/track
  // switches — it persists and is overwritten when the fresh probe resolves, so the
  // badge doesn't flicker. Re-probes when the loaded tracks change OR a separation
  // finishes (a deck reaching a terminal cached/ready/promoted state).
  const doneKey = (["A", "B"] as const)
    .map((d) => {
      const p = stemStatus?.[d]?.phase;
      return p === "ready" || p === "cached" || p === "promoted" ? `${d}:${stemStatus?.[d]?.src ?? ""}` : "";
    })
    .join("|");
  useEffect(() => {
    if (loadedVideoIds.length === 0) {
      setCachedModels({});
      return;
    }
    let cancelled = false;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const m of STEM_MODELS) {
        if (m.kind === "dsp") continue;
        const checks = await Promise.all(
          loadedVideoIds.map(async (v) => {
            if (await hasStemsLocal(v, m.id)) return true;
            const man = await fetchStemManifest(v, m.id).catch(() => null);
            return !!man?.complete;
          }),
        );
        out[m.id] = checks.length > 0 && checks.every(Boolean);
      }
      if (!cancelled) setCachedModels(out);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey, doneKey]);


  return (
    <div className="modal-backdrop dock-right" onPointerDown={onClose}>
      <DockResizer varName="--dock-w-right" measure="parent" />
      <div className="panel settings-panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
        </div>

        <div className="settings-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`settings-tab ${tab === t.key ? "on" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
          {tab === "color" && <ColorTab settings={settings} set={set} onChange={onChange} />}

          {tab === "controls" && <ControlsTab settings={settings} set={set} />}

          {tab === "midi" && midi && <MidiPanel midi={midi} settings={settings} onChange={onChange} />}

          {tab === "audio" && (
            <>
              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Output device</span>
                </div>
                {outputSupported ? (
                  <>
                    <select
                      className="settings-select"
                      value={settings.audioOutputId}
                      onChange={(e) => set({ audioOutputId: e.target.value })}
                    >
                      <option value="">System default</option>
                      {outputs.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `Output ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    {outputNeedsPerm && (
                      <p className="settings-hint muted">
                        Device names are hidden until you grant audio permission once.{" "}
                        <button className="link-btn" onClick={revealOutputNames}>
                          Show device names
                        </button>
                      </p>
                    )}
                    {outputPermErr && <p className="settings-hint" style={{ color: "#ffd250" }}>{outputPermErr}</p>}
                  </>
                ) : (
                  <p className="settings-hint muted">
                    This browser can’t switch the output device (Chrome or Edge can). Use your system sound settings to
                    choose a speaker.
                  </p>
                )}
              </div>

              {outputSupported && (
                <div className="settings-section">
                  <div className="settings-section-head">
                    <span className="settings-label">Cue / Headphone</span>
                  </div>
                  <select
                    className="settings-select"
                    value={settings.audioCueOutputId}
                    onChange={(e) => set({ audioCueOutputId: e.target.value })}
                  >
                    <option value="">None — single output</option>
                    {outputs.map((d, i) => (
                      <option key={d.deviceId || i} value={d.deviceId}>
                        {d.label || `Output ${i + 1}`}
                      </option>
                    ))}
                  </select>
                  <p className="settings-hint muted">
                    Pick a second device (headphones) to pre-listen each deck like a DJ board. The deck’s <strong>CUE</strong>{" "}
                    button becomes a fader — tap still sets / jumps the cue point, drag or scroll sets its headphone level.
                    Tapped pre-fader, so you can cue a deck that’s faded out.
                  </p>
                  {outputNeedsPerm && (
                    <p className="settings-hint muted">
                      Device names are hidden until you grant audio permission once.{" "}
                      <button className="link-btn" onClick={revealOutputNames}>
                        Show device names
                      </button>
                    </p>
                  )}
                </div>
              )}

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">Stretch engine</span>
                </div>
                <div className="seg">
                  {([
                    ["wsola", "WSOLA"],
                    ["pv", "Phase-locked"],
                  ] as [StretchEngine, string][]).map(([e, label]) => (
                    <button
                      key={e}
                      className={`seg-btn ${settings.stretchEngine === e ? "on" : ""}`}
                      onClick={() => set({ stretchEngine: e })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="settings-hint muted">
                  {settings.stretchEngine === "pv"
                    ? "Phase-locked vocoder — cleanest on full mixes (kills the metallic edge), more CPU."
                    : "Time-domain WSOLA — lightest CPU, crisp transients; can sound metallic on dense mixes."}
                </p>
                <div className="seg">
                  {(Object.keys(STRETCH_PRESETS) as StretchQuality[]).map((q) => (
                    <button
                      key={q}
                      className={`seg-btn ${settings.stretchQuality === q ? "on" : ""}`}
                      onClick={() => set({ stretchQuality: q })}
                    >
                      {STRETCH_PRESETS[q].label}
                    </button>
                  ))}
                </div>
                <p className="settings-hint muted">
                  ~{STRETCH_PRESETS[settings.stretchQuality].latencyMs} ms latency · grain{" "}
                  {STRETCH_PRESETS[settings.stretchQuality].frame}
                </p>
                <div className="settings-row">
                  <span className="settings-label">Transient preservation</span>
                  <button
                    className={`toggle ${settings.stretchTransient ? "on" : ""}`}
                    onClick={() => set({ stretchTransient: !settings.stretchTransient })}
                    role="switch"
                    aria-checked={settings.stretchTransient}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
                {settings.stretchTransient && (
                  <Slider
                    label="Transient threshold"
                    hint={settings.stretchTThresh <= 1.7 ? "sensitive" : settings.stretchTThresh >= 3 ? "strict" : "balanced"}
                    value={settings.stretchTThresh}
                    onChange={(v) => set({ stretchTThresh: v })}
                    min={1.3}
                    max={4}
                    step={0.1}
                  />
                )}
                <div className="settings-row">
                  <span className="settings-label">Anti-alias pitch-up</span>
                  <button
                    className={`toggle ${settings.stretchAa ? "on" : ""}`}
                    onClick={() => set({ stretchAa: !settings.stretchAa })}
                    role="switch"
                    aria-checked={settings.stretchAa}
                  >
                    <span className="toggle-knob" />
                  </button>
                </div>
                <p className="settings-hint muted">
                  Keep attacks crisp under big tempo stretch; remove fizz on key-ups.
                </p>
              </div>

              {isGpuBlocked() && (
                <div className="stem-blocked-banner">
                  <span>GPU stem separation crashed and was disabled. CPU models and cached results still work.</span>
                  <button
                    className="link-btn"
                    onClick={() => {
                      unblockGpu();
                      onGpuReenable?.();
                    }}
                  >
                    Re-enable GPU
                  </button>
                </div>
              )}

              {(stemStatus?.A || stemStatus?.B) && (
                <div className="settings-section">
                  <div className="settings-section-head">
                    <span className="settings-label">Stem status</span>
                  </div>
                  {(["A", "B"] as const).map((d) => {
                    const st = stemStatus?.[d];
                    if (!st) return null;
                    return (
                      <div key={d} className={`stem-status-row ${st.phase}`}>
                        <span className="stem-status-deck">{d}</span>
                        <span className="stem-status-detail">{st.detail}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">{isMobileDevice() ? "Stems" : "Stem separation"}</span>
                </div>
                {isMobileDevice() ? (
                  <>
                  <div className="settings-row">
                    <span className="settings-label">
                      Split tracks into stems
                      <span className="settings-sub muted"> · on-device · per-stem mixer + colours</span>
                    </span>
                    <button
                      className={`toggle ${settings.mobileStems ? "on" : ""}`}
                      onClick={() => set({ mobileStems: !settings.mobileStems })}
                      role="switch"
                      aria-checked={settings.mobileStems}
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>
                  <div className="stem-mobile-note">
                    Off keeps the lightest plain mix. On splits every loaded deck on-device (or adopts the shared
                    cache when a desktop already made them). Auto-DJ turns this on while it runs.
                    {stemFailLevel() > 0 && (
                      <>
                        {" "}
                        Downgraded after a crash —{" "}
                        <button
                          className="link-btn"
                          onClick={() => {
                            resetStemGuard();
                            location.reload();
                          }}
                        >
                          retry full quality
                        </button>
                        .
                      </>
                    )}
                  </div>
                  </>
                ) : (
                  <div className="stem-models">
                    {STEM_MODELS
                      // Open-Unmix is retired from the picker — HT-Demucs (GPU) is the only
                      // neural splitter we offer now. The registry entry stays so already-
                      // cached umx stems still resolve; it's just no longer selectable.
                      .filter((m) => m.arch !== "openunmix")
                      // GPU/demucs is hidden on phones (WebGPU OOM-crashes Safari); the
                      // rest stay, shown as download-only on mobile.
                      .filter((m) => !(isMobileDevice() && m.tier === "gpu"))
                      // The fp16 demucs model only works where the adapter exposes shader-f16
                      // (absent on today's Linux+NVIDIA WebGPU → its f16 shaders → noise). Hide
                      // it until the feature appears, then it auto-shows.
                      .filter((m) => !m.needsShaderF16 || webGpuShaderF16())
                      .map((m) => {
                        const sup = modelSupport(m);
                        const badge = supportBadge(m);
                        const cached = cachedModels[m.id];
                        const blocked = sup === "blocked" && !cached;
                        const untested = m.tier === "gpu" && sup === "runs" && isUntestedGpuPlatform();
                        return (
                          <button
                            key={m.id}
                            className={`stem-model ${settings.stemModel === m.id ? "on" : ""} ${blocked ? "blocked" : ""} ${
                              untested ? "untested" : ""
                            }`}
                            disabled={blocked}
                            onClick={() => !blocked && set({ stemModel: m.id })}
                          >
                            <span className="stem-model-label">
                              {m.label}
                              {m.kind !== "dsp" && <span className={`stem-badge ${badge.cls}`}>{badge.text}</span>}
                              {untested && <span className="stem-badge warn">Untested here — may crash</span>}
                              {cached && <span className="stem-badge cached">✓ cached for loaded track</span>}
                            </span>
                            <span className="stem-model-note">{m.note}</span>
                          </button>
                        );
                      })}
                  </div>
                )}

                {!isMobileDevice() && (
                  <div className="settings-row stem-autoenhance">
                    <span className="settings-label">
                      Auto-enhance
                      <span className="settings-sub muted"> · use cached neural stems when a track has them</span>
                    </span>
                    <button
                      className={`toggle ${settings.autoEnhance ? "on" : ""}`}
                      onClick={() => set({ autoEnhance: !settings.autoEnhance })}
                      role="switch"
                      aria-checked={settings.autoEnhance}
                      title="When a track already has cached neural stems, use them automatically instead of the plain mix"
                    >
                      <span className="toggle-knob" />
                    </button>
                  </div>
                )}

                {!isMobileDevice() && getStemModel(settings.stemModel).tier === "gpu" && (
                  <div className="stem-quality">
                    <div className="settings-section-head">
                      <span className="settings-label">Separation quality</span>
                      <span className="settings-sub muted">{STEM_PRESETS[settings.stemQuality].mult} compute</span>
                    </div>
                    <div className="seg">
                      {(Object.keys(STEM_PRESETS) as StemQuality[]).map((q) => (
                        <button
                          key={q}
                          className={`seg-btn ${settings.stemQuality === q ? "on" : ""}`}
                          onClick={() => set({ stemQuality: q })}
                        >
                          {STEM_PRESETS[q].label}
                        </button>
                      ))}
                    </div>
                    <p className="settings-hint muted">{STEM_PRESETS[settings.stemQuality].blurb}</p>
                  </div>
                )}

                {(() => {
                  const sel = getStemModel(settings.stemModel);
                  if (sel.kind === "dsp" || isMobileDevice()) return null;
                  const canReanalyze = modelSupport(sel) === "runs" && loadedVideoIds.length > 0 && !!onReanalyze;
                  return (
                    <button
                      className="stem-reanalyze"
                      disabled={!canReanalyze}
                      onClick={() => canReanalyze && onReanalyze?.(sel.id)}
                      title={
                        loadedVideoIds.length === 0
                          ? "Load a track first"
                          : modelSupport(sel) !== "runs"
                            ? `${sel.label} can't be separated on this device`
                            : `Re-run ${sel.label} on the loaded track(s), overwriting the cached stems`
                      }
                    >
                      ↻ Re-analyze loaded track{loadedVideoIds.length > 1 ? "s" : ""} with {sel.label}
                    </button>
                  );
                })()}
                {!isMobileDevice() && (() => {
                  const sel = getStemModel(settings.stemModel);
                  const gpu = sel.tier === "gpu";
                  const sup = modelSupport(sel);
                  const chromium = isChromium();
                  // A GPU-tier model only runs on the GPU under CHROMIUM; on Safari/
                  // Firefox the worker runs this same model on the stable wasm CPU EP
                  // (the JSEP/WebGPU path is Chromium-only — see isChromium). Show what's
                  // actually in play so the speed expectation is honest.
                  const onGpu = gpu && chromium && sup === "runs";
                  const adapter = webGpuAdapterInfo();
                  const kind = gpu ? (chromium ? (sup === "runs" ? "gpu" : "none") : "cpu") : "cpu";
                  const text = gpu
                    ? chromium
                      ? onGpu
                        ? adapter || "WebGPU"
                        : sup === "blocked"
                          ? "Disabled after a crash — re-enable above, or use a CPU model / cached result"
                          : "WebGPU not available here — pick a CPU model, or use a cached result"
                      : "Runs on CPU here (wasm SIMD) — slower than a Chromium GPU, but stable. The result caches for everyone."
                    : sel.kind === "dsp"
                      ? "Plain mix · no stem separation"
                      : "Neural · ORT WebAssembly";
                  return (
                    <div className={`stem-device ${kind}`}>
                      <span className="stem-device-tag">{gpu && chromium ? "GPU" : "CPU"}</span>
                      <span className="stem-device-text">{text}</span>
                    </div>
                  );
                })()}
              </div>

              <LyricsSettings settings={settings} onChange={onChange} />
            </>
          )}


          {tab === "debug" && <DebugTab midi={midi} debug={debug} />}

          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </div>
  );
}


