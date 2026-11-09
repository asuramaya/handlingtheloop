import { useEffect, useState } from "react";
import { InfoDot } from "./InfoDot";
import { OptionRow } from "./OptionRow";
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

  // ★ ONE ROW PER DECK, status and action together. The row's text is the live status while there
  // is one (separating 42%, downloading, failed — coloured by phase), else the steady state (which
  // engine's stems are on the deck). Re-analyze sits on the right whenever the selected engine can
  // run here. Rows exist for a deck that is loaded OR reporting a status, on any device.
  const sel = getStemModel(settings.stemModel);
  const supported = !isMobileDevice() && sel.kind !== "dsp" && modelSupport(sel) === "runs";
  const rowIds = (["A", "B"] as const).filter((id) => loadedDecks.some((d) => d.id === id) || stemStatus?.[id]);
  const deckRows =
    rowIds.length === 0 ? (
      !isMobileDevice() && sel.kind !== "dsp" ? (
        <div className="stem-reanalyze-empty">Load a track to separate or re-analyze it with {sel.label}.</div>
      ) : null
    ) : (
      <div className="stem-deck-list">
        {rowIds.map((id) => {
          const d = loadedDecks.find((x) => x.id === id);
          const st = stemStatus?.[id] ?? null;
          const onSel = !!d && d.neural && d.model === sel.id; // already this exact neural model
          const steady = !d
            ? ""
            : !d.hasStems
              ? "plain mix"
              : d.neural
                ? d.model
                  ? getStemModel(d.model).label
                  : "neural"
                : // UNREACHABLE (every setStems call passes neural=true since the DSP split was
                  // deleted in f2004f2); kept so the ternary is total. Seeing it on screen is the bug.
                  "DSP split";
          const text = st?.detail || (onSel ? `✓ ${steady}` : steady);
          const canRun = supported && !!d && !!onReanalyze;
          return (
            <div className={`stem-deck-row${onSel ? " is-current" : ""}${st ? ` phase-${st.phase}` : ""}`} key={id}>
              <span className="stem-deck-id">{id}</span>
              <span className="stem-deck-state" title={text}>
                {text}
              </span>
              {supported && d && (
                <button
                  className="stem-deck-reanalyze"
                  disabled={!canRun}
                  onClick={() => canRun && onReanalyze?.(sel.id, id)}
                  title={onSel ? `Re-run ${sel.label} on deck ${id}, overwriting its cached stems` : `Separate deck ${id} with ${sel.label}`}
                >
                  ↻ {onSel ? "Re-analyze" : sel.label}
                </button>
              )}
            </div>
          );
        })}
      </div>
    );

  // The device line, as a quiet note in the card head: which GPU separates here, or why nothing does.
  const gpuNote = (() => {
    const gpu = sel.tier === "gpu";
    const sup = modelSupport(sel);
    // Separation is Chromium + WebGPU only — there is no CPU route anywhere.
    const onGpu = gpu && sup === "runs";
    const adapter = webGpuAdapterInfo();
    // probeWebGPU() records the adapter even when it REJECTS a software fallback (SwiftShader).
    const softwareOnly = !onGpu && !!adapter?.includes("swiftshader");
    const text = gpu
      ? onGpu
        ? adapter || "WebGPU"
        : sup === "blocked"
          ? "disabled after a crash"
          : softwareOnly
            ? `software only (${adapter}) — cached stems still load`
            : isChromium()
              ? "no WebGPU here — cached stems still load"
              : "needs Chromium + WebGPU — cached stems still load"
      : // SINGLE IS NOT "NO STEMS" WHILE AUTO-ENHANCE IS ON: cached neural stems still download.
        settings.autoEnhance
        ? "no separation · cached stems still load"
        : "plain mix · no separation";
    return (
      <span className={`settings-head-note stem-device ${onGpu ? "gpu" : "none"}`} title={text}>
        {gpu && <span className="stem-device-tag">GPU</span>}
        <span className="stem-device-text">{text}</span>
      </span>
    );
  })();

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

      {/* ★ ONE CARD (operator, 2026-11-08: "consolidate the stems settings so they're not so
          overwhelming … combine stem status with the last line and move reanalyze to the first
          line"). The separate Stem status card is gone: each deck's live status IS its row, and the
          rows lead the card, Re-analyze on the right. Explanations moved behind ⓘ; what is visible
          is either a control or a report on right now. */}
      <div className="settings-section">
        <div className="settings-section-head">
          <span className="settings-label">{isMobileDevice() ? "Stems" : "Stem separation"}</span>
          {!isMobileDevice() && gpuNote}
        </div>

        {deckRows}

        {isMobileDevice() ? (
          <>
          {/* ★ A PHONE NEVER SEPARATES. `canSeparate()` returns false for every mobile UA before
              it looks at anything else, and the pipeline's own mobile branch is labelled FETCH +
              RENDER ONLY: it probes the shared cache and, finding nothing, stays on the plain mix.
              It is a DOWNLOAD switch, so it says so. */}
          <div className="settings-row">
            <span className="settings-label">
              Use shared stems
              <InfoDot
                text="Phones never separate a track themselves: the neural model needs a desktop GPU, and loading it here would crash the tab. What a phone can do is download a set someone's desktop already made and shared. On, a loaded deck checks the shared cache and takes the stems if they are there. Off, it stays on the plain mix, which is the lightest thing to play. Auto-DJ turns this on while it runs, because a stem transition needs both decks. A track only has stems once someone has separated it on a desktop with Demucs; until then the deck plays the mix."
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
          {/* The crash guard says WHICH rung you are on — a report on right now, so it stays visible. */}
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
          <div className="stem-models" role="radiogroup" aria-label="Stem engine">
            {/* This whole branch is the `!isMobileDevice()` side: a phone gets the switch above. */}
            {STEM_MODELS.map((m) => {
              const sup = modelSupport(m);
              const badge = supportBadge(m);
              const cached = cachedModels[m.id];
              const blocked = sup === "blocked" && !cached;
              // ONE badge: "cached for the loaded track" is the most useful fact when true;
              // otherwise what this device can do with it. The other goes behind the ⓘ.
              const shown = cached ? { text: "✓ cached", cls: "cached" } : m.kind !== "dsp" ? badge : null;
              // Single + Auto-enhance still loads a track's cached stems, so say what actually happens.
              const note =
                m.id === "off" && settings.autoEnhance
                  ? "Never separates here, lightest on memory. A track with stems in the shared cache still gets them (Auto-enhance)."
                  : m.note;
              const info = m.kind === "dsp" ? note : `${note} · On this device: ${badge.text}${cached ? " · cached for the loaded track" : ""}.`;
              return (
                <OptionRow
                  key={m.id}
                  on={settings.stemModel === m.id}
                  disabled={blocked}
                  onPick={() => set({ stemModel: m.id })}
                  label={m.label}
                  badge={shown ? <span className={`stem-badge ${shown.cls}`}>{shown.text}</span> : undefined}
                  info={info}
                />
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
          <div className="stem-quality settings-row">
            <span className="settings-label">
              Quality
              {/* The chosen preset's blurb used to sit as a sentence under the control; it rides in
                  the ⓘ now, after the general explanation, so it still changes with the choice. */}
              <InfoDot
                text={`How hard the GPU works on each split. Higher settings run the model more times over the track and overlap the windows further, which cleans up bleed between stems at a proportional cost in time. The figure is the compute multiplier against the fastest setting. ${STEM_PRESETS[settings.stemQuality].label}: ${STEM_PRESETS[settings.stemQuality].blurb}`}
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
        )}
      </div>
    </>
  );
}
