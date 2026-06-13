import { WHISPER_MODELS } from "@htl/lyrics";
import type { Settings } from "@htl";

// Lyrics settings — self-contained so the (co-edited) SettingsPanel needs one line.
// Whisper transcribes the isolated vocal stem (better-synced than YouTube's captions) on a
// desktop GPU and pools the result, so phones + repeat plays get accurate, track-timed
// lyrics instantly. The toggle gates the on-device decode; pooled transcripts always show.
export function LyricsSettings({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const active = WHISPER_MODELS.find((m) => m.id === settings.lyricsModel) ?? WHISPER_MODELS[0];
  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <span className="settings-label">
          Lyrics
          <span className="settings-sub muted"> · Whisper from the vocal stem · YouTube fallback</span>
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
          <div className="seg">
            {WHISPER_MODELS.map((m) => (
              <button
                key={m.id}
                className={`seg-btn ${settings.lyricsModel === m.id ? "on" : ""}`}
                onClick={() => set({ lyricsModel: m.id })}
                title={m.blurb}
              >
                {m.label}
              </button>
            ))}
            {/* Explicit YouTube engine: skip the GPU entirely and use YouTube's own captions. */}
            <button
              className={`seg-btn ${settings.lyricsModel === "youtube" ? "on" : ""}`}
              onClick={() => set({ lyricsModel: "youtube" })}
              title="Use YouTube's caption track directly — instant, no GPU, works on phones (less tightly synced than Whisper)"
            >
              YouTube
            </button>
          </div>
          <p className="settings-hint muted">
            {settings.lyricsModel === "youtube"
              ? "YouTube captions directly — instant and GPU-free, but only as accurate as the uploader's captions and looser on timing."
              : active.blurb}
          </p>
        </>
      )}
      <p className="settings-hint muted">
        Transcribed on a desktop GPU from the neural vocal stem and shared to the community pool — so phones and repeat
        plays get them instantly, with no GPU work. YouTube captions are the fallback.
      </p>
    </div>
  );
}
