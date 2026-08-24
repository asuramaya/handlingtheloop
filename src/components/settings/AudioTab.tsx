// Settings ▸ Audio — output/cue device pickers, time-stretch engine + quality, and stem
// separation (model picker, GPU/CPU device readout, re-analyze, lyrics). Owns the
// device-enumeration, per-model R2-cache, and WebGPU-probe state; it mounts only while
// the Audio tab is open, so those probes run exactly when the UI that uses them is shown.
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
  isGpuBlocked,
  unblockGpu,
  stemFailLevel,
  resetStemGuard,
  type StemModel,
} from "@htl";
import type { StemStatus } from "../../App";
import { LyricsSettings, type LyricDeck } from "../LyricsSettings";
import { Slider } from "./Slider";

// What each model can do on THIS device, as a short badge for the picker.
function supportBadge(m: StemModel): { text: string; cls: string } {
  switch (modelSupport(m)) {
    case "instant":
      return { text: "Instant", cls: "ok" };
    case "runs":
      return { text: `Runs here · ${m.sizeMB} MB`, cls: "ok" };
    case "blocked":
      return { text: "Disabled — crashed here", cls: "warn" };
    default:
      // needs-gpu: on a phone that's by design (cache-only consumer); on desktop it
      // just needs WebGPU enabled.
      return { text: isMobileDevice() ? "Cached only · a desktop separates" : "Enable WebGPU to run here", cls: "warn" };
  }
}

export function AudioTab({
  settings,
  set,
  onChange,
  outputSupported,
  loadedVideoIds,
  loadedDecks = [],
  stemStatus,
  onReanalyze,
  lyricDecks = [],
  onRetranscribe,
  onGpuReenable,
}: {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  onChange: (next: Settings) => void;
  outputSupported: boolean;
  loadedVideoIds: string[];
  loadedDecks?: { id: "A" | "B"; neural: boolean; hasStems: boolean; model: string | null }[];
  stemStatus?: Record<"A" | "B", StemStatus | null>;
  onReanalyze?: (modelId: string, deck?: "A" | "B") => void;
  lyricDecks?: LyricDeck[];
  onRetranscribe?: (deck: "A" | "B") => void;
  onGpuReenable?: () => void;
}) {
  // Audio OUTPUT devices (speaker select). enumerateDevices only fills in `label`
  // once the page has been granted mic permission at least once; until then the OS
  // hides device names. `outputNeedsPerm` tracks that so we can offer a one-tap
  // "Show device names" that asks for (and immediately drops) a mic stream. Listed
  // only when the browser supports setSinkId.
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [outputNeedsPerm, setOutputNeedsPerm] = useState(false);
  const [outputPermErr, setOutputPermErr] = useState(""); // why a reveal failed (blocked / no device)
  useEffect(() => {
    if (!outputSupported || !navigator.mediaDevices?.enumerateDevices) return;
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
  }, [outputSupported]);

  // Microphone INPUT devices (for the mic talkover + sampling source). Same label-permission
  // quirk as outputs; gated on getUserMedia. The "Show device names" reveal fills both.
  const micSupported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!micSupported || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        if (!cancelled) setInputs(devs);
      } catch {
        /* ignore */
      }
    };
    void refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, [micSupported]);

  // One-shot: ask for mic permission so enumerateDevices reveals output labels,
  // then immediately stop the stream (we never record — we only want the names).
  const revealOutputNames = async () => {
    setOutputPermErr("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      const devs = all.filter((d) => d.kind === "audiooutput");
      setOutputs(devs);
      setInputs(all.filter((d) => d.kind === "audioinput")); // the same grant reveals mic names
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
  // has its four stems in R2.
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
    <>
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Output device (PA)</span>
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
            <p className="settings-hint muted">Your PA / house output. Carries the main mix and the mic. Headphone cue is set separately below.</p>
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
            This browser can’t switch outputs. Choose a speaker in your system sound settings, or use Chrome or Edge.
          </p>
        )}
      </div>

      {isMobileDevice() && (
        <div className="settings-section">
          <div className="settings-row">
            <span className="settings-label">Force wireless buffering</span>
            <button
              className={`toggle ${settings.wirelessOutput ? "on" : ""}`}
              onClick={() => set({ wirelessOutput: !settings.wirelessOutput })}
              role="switch"
              aria-checked={settings.wirelessOutput}
            >
              <span className="toggle-knob" />
            </button>
          </div>
          <p className="settings-hint muted">
            Bluetooth and car-stereo skips are already fixed <strong>automatically</strong>: dropouts are detected,
            buffering goes up, and it backs off once playback is clean. Turn this on to pin the full ~120&nbsp;ms buffer
            from the start. Costs a little latency on wired output.
          </p>
        </div>
      )}

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
            {/* Exclude the main PA device — cueing to the SAME physical output double-plays the
                master to it (the cue's master-tap + the main path), phasing/doubling the mix. */}
            {outputs
              .filter((d) => !settings.audioOutputId || d.deviceId !== settings.audioOutputId)
              .map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Output ${i + 1}`}
                </option>
              ))}
          </select>
          {/* Bluetooth/wireless cue device → warn: A2DP adds large latency and can shift pitch
              (the cue routes through a MediaStream <audio> sink, unlike the native master). The
              fix is a wired/USB output — no code makes a Bluetooth cue accurate. (#13) */}
          {(() => {
            const cueLabel = outputs.find((d) => d.deviceId === settings.audioCueOutputId)?.label ?? "";
            return /\b(bluetooth|airpods?|wireless|bt|beats|buds|jabra)\b/i.test(cueLabel) ? (
              <p className="settings-hint" style={{ color: "#ffd250" }}>
                ⚠ “{cueLabel}” looks like a Bluetooth output. Wireless adds ~150–300&nbsp;ms of latency and can shift
                the cue’s pitch. Use a <strong>wired / USB</strong> output to cue accurately.
              </p>
            ) : null;
          })()}
          <p className="settings-hint muted">
            Pick headphones to pre-listen each deck like a DJ board. The deck’s <strong>CUE</strong> button becomes a
            fader: tap sets or jumps the cue point, drag or scroll sets its headphone level. It taps pre-fader, so a
            deck that’s faded out can still be cued.
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

      {micSupported && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">Microphone</span>
          </div>
          <select className="settings-select" value={settings.audioInputId} onChange={(e) => set({ audioInputId: e.target.value })}>
            <option value="">System default mic</option>
            {inputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
          <p className="settings-hint muted">
            Input for talkover and sampling (the 🎙 on the sampler strip). Switching while the mic is live re-acquires it.
            {inputs.length > 0 && inputs.every((d) => !d.label) && (
              <>
                {" "}Names are hidden until you grant audio access once.{" "}
                <button className="link-btn" onClick={revealOutputNames}>
                  Show device names
                </button>
              </>
            )}
          </p>
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
            ? "Phase-locked vocoder. Cleanest on full mixes, no metallic edge. More CPU."
            : "Time-domain WSOLA. Lightest CPU, crisp transients. Can sound metallic on dense mixes."}
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
          Keeps attacks crisp under big tempo stretch and removes fizz on key-ups.
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
              // GPU/demucs is hidden on phones (WebGPU OOM-crashes Safari); phones are
              // cache-only consumers, so the picker shows just Single there.
              .filter((m) => !(isMobileDevice() && m.tier === "gpu"))
              .map((m) => {
                const sup = modelSupport(m);
                const badge = supportBadge(m);
                const cached = cachedModels[m.id];
                const blocked = sup === "blocked" && !cached;
                return (
                  <button
                    key={m.id}
                    className={`stem-model ${settings.stemModel === m.id ? "on" : ""} ${blocked ? "blocked" : ""}`}
                    disabled={blocked}
                    onClick={() => !blocked && set({ stemModel: m.id })}
                  >
                    <span className="stem-model-label">
                      {m.label}
                      {m.kind !== "dsp" && <span className={`stem-badge ${badge.cls}`}>{badge.text}</span>}
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
          const supported = modelSupport(sel) === "runs";
          if (loadedDecks.length === 0) {
            return <div className="stem-reanalyze-empty">Load a track to separate or re-analyze it with {sel.label}.</div>;
          }
          return (
            <div className="stem-deck-list">
              {loadedDecks.map((d) => {
                // Steady per-deck stem state: which engine is on this deck right now.
                const onSel = d.neural && d.model === sel.id; // already this exact neural model
                const state = !d.hasStems
                  ? "plain mix"
                  : d.neural
                    ? d.model
                      ? getStemModel(d.model).label
                      : "neural"
                    : "DSP split";
                const canRun = supported && !!onReanalyze;
                return (
                  <div className={`stem-deck-row${onSel ? " is-current" : ""}`} key={d.id}>
                    <span className="stem-deck-id">{d.id}</span>
                    <span className="stem-deck-state">{onSel ? `✓ ${state}` : state}</span>
                    <button
                      className="stem-deck-reanalyze"
                      disabled={!canRun}
                      onClick={() => canRun && onReanalyze?.(sel.id, d.id)}
                      title={
                        !supported
                          ? `${sel.label} can't be separated on this device`
                          : onSel
                            ? `Re-run ${sel.label} on deck ${d.id}, overwriting its cached stems`
                            : `Separate deck ${d.id} with ${sel.label}`
                      }
                    >
                      ↻ {onSel ? "Re-analyze" : sel.label}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })()}
        {!isMobileDevice() && (() => {
          const sel = getStemModel(settings.stemModel);
          const gpu = sel.tier === "gpu";
          const sup = modelSupport(sel);
          // Separation is Chromium + WebGPU only — there is no CPU route anywhere.
          // Everything else (Safari/Firefox, phones) consumes the shared cache.
          const onGpu = gpu && sup === "runs";
          const adapter = webGpuAdapterInfo();
          // probeWebGPU() still records the adapter string even when it REJECTS that
          // adapter for being a software fallback (SwiftShader) — surface that instead
          // of the generic "not available" message, since it's a genuinely different,
          // more actionable situation: WebGPU works, hardware acceleration doesn't.
          const softwareOnly = !onGpu && !!adapter?.includes("swiftshader");
          const text = gpu
            ? onGpu
              ? adapter || "WebGPU"
              : sup === "blocked"
                ? "Disabled after a crash — re-enable above, or use a cached result"
                : softwareOnly
                  ? `Only software rendering available (${adapter}) — cached stems still load here`
                  : isChromium()
                    ? "WebGPU not available here — cached stems still load"
                    : "Separation needs a Chromium WebGPU browser — cached stems still load here"
            : "Plain mix · no stem separation";
          return (
            <div className={`stem-device ${onGpu ? "gpu" : "none"}`}>
              <span className="stem-device-tag">GPU</span>
              <span className="stem-device-text">{text}</span>
            </div>
          );
        })()}
      </div>

      <LyricsSettings settings={settings} onChange={onChange} decks={lyricDecks} onRetranscribe={onRetranscribe} />
    </>
  );
}
