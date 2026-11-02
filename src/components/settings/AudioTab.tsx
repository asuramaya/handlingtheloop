// Settings ▸ Audio — output/cue device pickers, time-stretch engine + quality, and stem
// separation (model picker, GPU/CPU device readout, re-analyze, lyrics). Owns the
// device-enumeration, per-model R2-cache, and WebGPU-probe state; it mounts only while
// the Audio tab is open, so those probes run exactly when the UI that uses them is shown.
import { useEffect, useState } from "react";
import { FxBankSettings } from "./FxBankSettings";
import { InfoDot } from "./InfoDot";
import {
  type Settings,
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
  MIC_NONE,
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
          <InfoDot
            text="Your PA or house output: the speakers the room hears. It carries the main mix and the microphone. Headphones are chosen separately under Cue, so you can pre-listen to one deck while the room hears another."
            label="Output device"
          />
        </div>
        {outputSupported ? (
          <>
            <select
              className="settings-select"
              value={settings.audioOutputId}
              onChange={(e) => set({ audioOutputId: e.target.value })}
              aria-label="Output device"
            >
              <option value="">System default</option>
              {outputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Output ${i + 1}`}
                </option>
              ))}
            </select>
            {outputNeedsPerm && (
              <p className="settings-note">
                Device names stay hidden until you grant audio permission once.{" "}
                <button className="link-btn" onClick={revealOutputNames}>
                  Show device names
                </button>
              </p>
            )}
            {outputPermErr && <p className="settings-note warn">{outputPermErr}</p>}
          </>
        ) : (
          <p className="settings-note warn">
            This browser cannot switch outputs. Pick a speaker in your system sound settings, or use Chrome or Edge.
          </p>
        )}
      </div>

      {isMobileDevice() && (
        <div className="settings-section">
          <div className="settings-row">
            <span className="settings-label">
              Force wireless buffering
              <InfoDot
                text="Bluetooth and car-stereo skips are already handled on their own: dropouts are detected, buffering goes up, and it backs off once playback is clean. This pins the full buffer, about 120 milliseconds, from the start instead of waiting for the first skip. It costs a little latency on a wired output."
                label="Force wireless buffering"
              />
            </span>
            <button
              className={`toggle ${settings.wirelessOutput ? "on" : ""}`}
              onClick={() => set({ wirelessOutput: !settings.wirelessOutput })}
              role="switch"
              aria-checked={settings.wirelessOutput}
              aria-label="Force wireless buffering"
            >
              <span className="toggle-knob" />
            </button>
          </div>
        </div>
      )}

      {outputSupported && (
        <div className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">Cue / Headphone</span>
            <InfoDot
              text="Headphones for pre-listening a deck before the room hears it, like a DJ board. The deck's CUE button becomes a fader: tap to set or jump to the cue point, drag or scroll to set its headphone level. It taps before the channel fader, so a deck faded all the way out can still be cued."
              label="Cue / Headphone"
            />
          </div>
          <select
            className="settings-select"
            value={settings.audioCueOutputId}
            onChange={(e) => set({ audioCueOutputId: e.target.value })}
            aria-label="Cue output device"
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
              <p className="settings-note warn">
                <strong>{cueLabel}</strong> looks like a Bluetooth output. Wireless adds 150 to 300 milliseconds of
                latency and can shift the cue's pitch. Use a wired or USB output to cue accurately.
              </p>
            ) : null;
          })()}
          {outputNeedsPerm && (
            <p className="settings-note">
              Device names stay hidden until you grant audio permission once.{" "}
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
            <InfoDot
              text="A microphone for talkover and sampling. None is a real choice and the default: with None picked, the MIC, DUCK and MON controls are absent from the board entirely rather than sitting there unused. Switching device while the mic is live re-acquires it."
              label="Microphone"
            />
          </div>
          {/* ★ SAME SHAPE AS THE CUE OUTPUT ABOVE: "None" is a real, default choice, and choosing a
              device is what turns the feature on. The mic section of the board follows this select —
              pick None and MIC / DUCK / MON are gone from the board entirely, rather than sitting
              there forever for the (many) people who never use a microphone. */}
          <select className="settings-select" value={settings.audioInputId} onChange={(e) => set({ audioInputId: e.target.value })} aria-label="Microphone device">
            <option value={MIC_NONE}>None — no microphone</option>
            <option value="">System default mic</option>
            {inputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
          {/* A REPORT on the current state, not an explanation of the control — the explanation
              is behind the head's ⓘ. That is the whole split: `.settings-note` states a fact
              about right now, InfoDot answers "what is this". */}
          {settings.audioInputId === MIC_NONE && (
            <p className="settings-note">No microphone selected, so talkover, ducking and monitoring are off the board.</p>
          )}
          {inputs.length > 0 && inputs.every((d) => !d.label) && (
            <p className="settings-note">
              Device names stay hidden until you grant audio access once.{" "}
              <button className="link-btn" onClick={revealOutputNames}>
                Show device names
              </button>
            </p>
          )}
        </div>
      )}

      {/* The stretch engine and sync pull moved to Settings ▸ Turntable ▸ Tempo (how a deck moves
          and how its tempo sounds, in one place). What stayed is the master bus. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">Master</span>
          <InfoDot
            text="The summed output of both decks: how much room it leaves before the limiter, and whether each deck is limited on its own first."
            label="Master"
          />
        </div>
        {/* ★ MASTER HEADROOM — the gain-staging answer to "the compressor punches from the other
            deck". Measured on the live FX harness (fxlab --master-duck): two decks summing past the
            master limiter's ceiling let a kick on one deck pull the OTHER down 1.88 dB for 130 ms,
            and no per-deck control can reach it, because the limiter sees the decks already summed.
            3 dB of trim here took it to 0.02 dB. It defaults to 0 — the fix costs output level, so
            it is offered, not imposed. */}
        <div className="settings-row">
          <span className="settings-label">
            Limit each deck
            <InfoDot label="Limit each deck" text="The master limiter hears BOTH decks at once, so one deck's kick asks it for gain reduction that lands on the other — that is the 'one deck pumps the other' effect, measured at 1.88 dB on a hot mix and 0.00 dB at a moderate one. Master headroom only moves the level where that starts; limiting each deck BEFORE they are summed can remove that shared stage, but measured it only works when each deck is held about 7 dB down: a limiter caps a signal rather than lowering it, so two decks sitting at the master's own ceiling still sum over it and the master reduces HARDER than before. This is therefore not a free alternative to headroom, it IS headroom taken per deck. Expect it quieter, and expect it to sound different, because two independent limiters do not sound like one bus limiter. Off by default — try it on a mix that pumps and keep it only if you prefer how it sounds." />
          </span>
          <button
            className={`toggle ${settings.perDeckLimiter ? "on" : ""}`}
            onClick={() => set({ perDeckLimiter: !settings.perDeckLimiter })}
            role="switch"
            aria-checked={settings.perDeckLimiter}
            aria-label="Limit each deck"
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <Slider
          label="Master headroom"
          info="How far the master is pulled down before the limiter. At 0 a loud two-deck mix runs into the ceiling, and the limiter — which hears both decks at once — ducks the whole mix on every kick, so one deck appears to pump the other. Measured: 3 dB of headroom removes that almost entirely. The cost is output level; every dB here is a dB quieter, so turn the amp up instead."
          hint={settings.masterHeadroomDb === 0 ? "none — loudest, may pump" : `${-settings.masterHeadroomDb} dB quieter`}
          value={settings.masterHeadroomDb}
          onChange={(v) => set({ masterHeadroomDb: v })}
          min={-12}
          max={0}
          step={1}
        />
      </div>

      {isGpuBlocked() && (
        <div className="stem-blocked-banner">
          {/* No "CPU models still work": CPU separation was removed, so a blocked GPU means no
              on-device separation at all. Cached stems still download. */}
          <span>GPU stem separation is paused after it crashed the page. Cached stems still load; nothing new separates until you re-enable it.</span>
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
          {/* ★ A PHONE NEVER SEPARATES. `canSeparate()` returns false for every mobile UA before
              it looks at anything else, and the pipeline's own mobile branch is labelled FETCH +
              RENDER ONLY: it probes the shared cache and, finding nothing, stays on the plain mix.
              This control was nevertheless called "Split tracks into stems · on-device", which
              promised the one thing the device cannot do — and when a phone then sat on the mix,
              nothing in the wording could explain why. It is a DOWNLOAD switch, so it says so. */}
          <div className="settings-row">
            <span className="settings-label">
              Use shared stems
              <InfoDot
                text="Phones never separate a track themselves: the neural model needs a desktop GPU, and loading it here would crash the tab. What a phone can do is download a set someone's desktop already made and shared. On, a loaded deck checks the shared cache and takes the stems if they are there. Off, it stays on the plain mix, which is the lightest thing to play. Auto-DJ turns this on while it runs, because a stem transition needs both decks."
                label="Use shared stems"
              />
            </span>
            <button
              className={`toggle ${settings.mobileStems ? "on" : ""}`}
              onClick={() => set({ mobileStems: !settings.mobileStems })}
              role="switch"
              aria-checked={settings.mobileStems}
              aria-label="Use shared stems"
            >
              <span className="toggle-knob" />
            </button>
          </div>
          {/* The dependency, stated once and up front. A phone that silently plays the mix looks
              broken; a phone that told you a desktop has to go first does not. */}
          {settings.mobileStems && (
            <p className="settings-note">
              A track only has stems once someone has separated it on a desktop with Demucs. Until then this
              deck plays the mix.
            </p>
          )}
          {/* ★ THIS NOTICE USED TO BE A LIE, and a vague one. It read "Downgraded after a crash"
              and offered to "Retry full quality" — for a guard that nothing armed and a level that
              nothing acted on, so no downgrade had happened and there was nothing to retry. Both
              halves are true now (2026-09-10 redesign): the level really does gate the mobile stem
              download, and it says WHICH rung you are on, because "downgraded" without naming what
              you lost is not something a user can act on. */}
          {stemFailLevel() > 0 && (
            <p className="settings-note warn">
              {stemFailLevel() >= 2
                ? "Stems are off — loading them crashed this tab twice, so tracks play as the plain mix."
                : "Stems no longer download automatically — loading one crashed this tab. Turning the switch above on still fetches them."}{" "}
              <button
                className="link-btn"
                onClick={() => {
                  resetStemGuard();
                  location.reload();
                }}
              >
                Try again
              </button>
            </p>
          )}
          </>
        ) : (
          <div className="stem-models">
            {/* No mobile filter here: this whole branch is the `!isMobileDevice()` side. A phone
                never reaches the model picker at all — it gets the "Use shared stems" switch and
                nothing else. The filter that used to sit here implied otherwise. */}
            {STEM_MODELS
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
              <InfoDot
                text="When a track already has a neural stem set in the shared cache, use it instead of separating again. Costs a download rather than a GPU run, and the result is identical because it is the same model. Turn it off to stay on whatever model you picked above."
                label="Auto-enhance"
              />
            </span>
            <button
              className={`toggle ${settings.autoEnhance ? "on" : ""}`}
              onClick={() => set({ autoEnhance: !settings.autoEnhance })}
              role="switch"
              aria-checked={settings.autoEnhance}
              aria-label="Auto-enhance"
            >
              <span className="toggle-knob" />
            </button>
          </div>
        )}

        {!isMobileDevice() && getStemModel(settings.stemModel).tier === "gpu" && (
          <>
          {/* The chosen preset's blurb is the ONE piece of prose kept as prose on this tab, and
              deliberately: it changes with the control, so it is a readout of the current choice
              rather than an explanation of the control. Explanation goes behind the ⓘ; state
              stays visible. */}
          <div className="stem-quality settings-row">
            <span className="settings-label">
              Separation quality
              <InfoDot
                text="How hard the GPU works on each split. Higher settings run the model more times over the track and overlap the windows further, which cleans up bleed between stems at a proportional cost in time. The compute figure is the multiplier against the fastest setting."
                label="Separation quality"
              />
            </span>
            <span className="settings-control">
              <span className="settings-value">{STEM_PRESETS[settings.stemQuality].mult}</span>
              <span className="seg-group">
                {(Object.keys(STEM_PRESETS) as StemQuality[]).map((q) => (
                  <button
                    key={q}
                    className={`hw-btn small ${settings.stemQuality === q ? "on" : ""}`}
                    onClick={() => set({ stemQuality: q })}
                  >
                    {STEM_PRESETS[q].label}
                  </button>
                ))}
              </span>
            </span>
          </div>
          <p className="settings-note">{STEM_PRESETS[settings.stemQuality].blurb}</p>
        </>
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
                    // UNREACHABLE, and kept only so the ternary is total. A deck cannot hold
                    // stems that are not neural: every setStems/loadPackedStems call site in the
                    // app passes neural=true (the param DEFAULTS to false, which is why this is
                    // worth stating), and the DSP split that could once produce non-neural stems
                    // was deleted in f2004f2, 2026-07-01. If this string ever appears on screen,
                    // something has started setting stems without the flag — that is the bug,
                    // not this label.
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

      <FxBankSettings />

      <LyricsSettings settings={settings} onChange={onChange} decks={lyricDecks} onRetranscribe={onRetranscribe} />
    </>
  );
}
