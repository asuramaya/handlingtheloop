import { WHISPER_MODELS, whisperModel, canTranscribe, isWhisperModel, type LyricsSource } from "@htl/lyrics";
import { isMobileDevice, webGpuAdapterInfo, isChromium, type Settings } from "@htl";

/** What a deck's lyrics ARE right now — the lyric twin of the stem per-deck row. */
export interface LyricDeck {
  id: "A" | "B";
  source: LyricsSource | null; // whisper (this device) · pool (someone else's GPU) · youtube
  lines: number;
  status: string | null; // live progress, when a decode is running ("whisper L ↓42%")
}

// Lyrics settings — self-contained so the (co-edited) SettingsPanel needs one line.
//
// ★ THIS IS A NEURAL JOB, SO IT LOOKS LIKE ONE. It used to be three cramped segment buttons and a
// line of grey text, which told you nothing about what was happening — the operator's words were
// "I can't tell when or if they are firing". It now wears the same clothes as stem separation,
// because it IS the same kind of thing: pick a model, see its real download, watch each deck's
// state, re-run one on demand. Same shapes, same classes, same reading.
//
// ★ AND IT NO LONGER SHIPS IN THE OFF POSITION. Whisper transcribes the isolated vocal stem, so it
// is dead in the water without separation — but separation defaulted to "off" and lyrics defaulted
// to "youtube", two unlinked settings that BOTH had to be flipped by hand. Nobody ever flipped
// both, which is exactly why the lyrics pool had zero rows in it. Choosing a Whisper model now
// turns separation on, and says so.
export function LyricsSettings({
  settings,
  onChange,
  decks = [],
  onRetranscribe,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  decks?: LyricDeck[];
  onRetranscribe?: (deck: "A" | "B") => void;
}) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const mobile = isMobileDevice();
  const canRun = canTranscribe(); // desktop Chromium + WebGPU — the only place a decode happens
  const isYt = settings.lyricsModel === "youtube";
  const sel = whisperModel(settings.lyricsModel);

  // Picking a Whisper tier while separation is off would be a choice with no effect. Turn it on
  // — the neural vocal stem is not a preference here, it is the input.
  const DEFAULT_STEM = "htdemucs-onnx"; // HT-Demucs (GPU) — the only neural splitter we offer
  const pickWhisper = (id: string) =>
    set(settings.stemModel === "off" ? { lyricsModel: id, stemModel: DEFAULT_STEM } : { lyricsModel: id });

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <span className="settings-label">
          Lyrics
          <span className="settings-sub muted"> · transcribed from the isolated vocal stem</span>
        </span>
        <button
          className={`toggle ${settings.lyricsAuto ? "on" : ""}`}
          onClick={() => set({ lyricsAuto: !settings.lyricsAuto })}
          role="switch"
          aria-checked={settings.lyricsAuto}
          title="Transcribe lyrics from the isolated vocal stem (desktop GPU) and pool them; falls back to YouTube captions"
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {settings.lyricsAuto && (
        <>
          {/* The model picker, in the stem-model shape: what it is, what it costs, what it's for. */}
          <div className="stem-models">
            {WHISPER_MODELS.map((m) => (
              <button
                key={m.id}
                className={`stem-model ${settings.lyricsModel === m.id ? "on" : ""}`}
                onClick={() => pickWhisper(m.id)}
              >
                <span className="stem-model-label">
                  {m.label}
                  <span className={`stem-badge ${canRun ? "ok" : "warn"}`}>
                    {canRun ? `Runs here · ${m.sizeMB} MB` : mobile ? "Desktop GPU only" : "Needs Chromium + WebGPU"}
                  </span>
                  {m.best && <span className="stem-badge cached">Best</span>}
                </span>
                <span className="stem-model-note">{m.note}</span>
              </button>
            ))}
            {/* The GPU-free escape hatch: YouTube's own caption track, warts and all. */}
            <button
              className={`stem-model ${isYt ? "on" : ""}`}
              onClick={() => set({ lyricsModel: "youtube" })}
            >
              <span className="stem-model-label">
                YouTube captions
                <span className="stem-badge ok">Instant · no GPU</span>
              </span>
              <span className="stem-model-note">
                The uploader's own captions. Free and works on a phone, but line-level only — no per-word timing — and
                often missing, auto-generated, or plain wrong.
              </span>
            </button>
          </div>

          {/* Separation is the INPUT, not a companion setting — say plainly that it's on and why. */}
          {isWhisperModel(settings.lyricsModel) && !mobile && (
            <p className="settings-hint muted">
              Whisper reads the isolated vocal stem, so stem separation is on above. The words come from Whisper; the{" "}
              <em>timings</em> are measured off the vocal stem's own onsets.
            </p>
          )}

          {/* Per-deck state — the answer to "are they even firing?", which nothing used to give. */}
          {!isYt && !mobile && (
            decks.length === 0 ? (
              <div className="stem-reanalyze-empty">Load a track to transcribe it with {sel.label}.</div>
            ) : (
              <div className="stem-deck-list">
                {decks.map((d) => {
                  const onSel = d.source === "whisper"; // decoded on THIS device, current engine
                  const state = d.status
                    ? d.status // live: downloading the model / decoding / aligning
                    : d.source === "whisper"
                      ? `✓ Whisper · ${d.lines} lines`
                      : d.source === "pool"
                        ? `✓ pooled · ${d.lines} lines`
                        : d.source === "youtube"
                          ? `YouTube captions · ${d.lines} lines`
                          : "no lyrics yet";
                  return (
                    <div className={`stem-deck-row${onSel ? " is-current" : ""}`} key={d.id}>
                      <span className="stem-deck-id">{d.id}</span>
                      <span className="stem-deck-state">{state}</span>
                      <button
                        className="stem-deck-reanalyze"
                        disabled={!canRun || !onRetranscribe || !!d.status}
                        onClick={() => onRetranscribe?.(d.id)}
                        title={
                          !canRun
                            ? "Transcription needs a desktop Chromium GPU"
                            : `Wipe deck ${d.id}'s transcript and re-run ${sel.label} on its vocal stem`
                        }
                      >
                        ↻ {onSel ? "Re-transcribe" : sel.label}
                      </button>
                    </div>
                  );
                })}
              </div>
            )
          )}

          {/* Where the decode actually runs — the same readout the separator gives. */}
          {!isYt && !mobile && (
            <div className={`stem-device ${canRun ? "gpu" : "none"}`}>
              <span className="stem-device-tag">{canRun ? "GPU" : "—"}</span>
              <span className="stem-device-text">
                {canRun
                  ? webGpuAdapterInfo() || "WebGPU"
                  : isChromium()
                    ? "WebGPU not available here — lyrics fall back to the pool, then YouTube captions."
                    : "Chromium + WebGPU only — lyrics fall back to the pool, then YouTube captions."}
              </span>
            </div>
          )}
        </>
      )}

      <p className="settings-hint muted">
        Transcribed once on a desktop GPU and shared to the community pool — so phones and repeat plays get the words
        instantly, with no GPU work of their own.
      </p>
    </div>
  );
}
