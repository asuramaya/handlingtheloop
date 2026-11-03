import { useEffect, useState } from "react";
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
} from "@htl";
import type { StemStatus } from "../../App";

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

// Settings ▸ Stems — split out of Audio (operator, 2026-11-02: "make stems and lyrics their own
// panel, keep audio cleaner"). The separation engine, its cache state for the loaded tracks, live
// per-deck status, and the GPU crash-guard banner. Moved verbatim; only the home changed.
export function StemsTab({
  settings,
  set,
  loadedVideoIds,
  loadedDecks = [],
  stemStatus,
  onReanalyze,
  onGpuReenable,
}: {
  settings: Settings;
  set: (patch: Partial<Settings>) => void;
  loadedVideoIds: string[];
  loadedDecks?: { id: "A" | "B"; neural: boolean; hasStems: boolean; model: string | null }[];
  stemStatus?: Record<"A" | "B", StemStatus | null>;
  onReanalyze?: (modelId: string, deck?: "A" | "B") => void;
  onGpuReenable?: () => void;
}) {
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
            : // ★ SINGLE IS NOT "NO STEMS" WHILE AUTO-ENHANCE IS ON: a track whose neural stems are in the
              // shared cache downloads them anyway (that is what Auto-enhance means), so the old
              // "no stem separation" sat directly under a status row reading "Enhancing with Demucs 75%".
              settings.autoEnhance
              ? "No separation here · cached stems still load"
              : "Plain mix · no stem separation";
          return (
            <div className={`stem-device ${onGpu ? "gpu" : "none"}`}>
              <span className="stem-device-tag">GPU</span>
              <span className="stem-device-text">{text}</span>
            </div>
          );
        })()}
      </div>

    </>
  );
}
