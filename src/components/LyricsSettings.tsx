import type { LyricsSource } from "@htl/lyrics";
import { isMobileDevice, type Settings } from "@htl";

/** What a deck's lyrics ARE right now — the lyric twin of the stem per-deck row. */
export interface LyricDeck {
  id: "A" | "B";
  source: LyricsSource | null;
  lines: number;
  status: string | null; // live progress while a lookup/alignment runs
}

// Lyrics settings.
//
// ★ THERE IS NO MODEL PICKER ANY MORE, AND THAT IS THE HEADLINE. This panel used to offer a choice
// between a 586 MB Whisper and a 759 MB Whisper, warn you that neither would run without a GPU, and
// nag you to switch stem separation on before either could do anything. All of that machinery
// existed to support a component that, on real tracks, mostly INVENTED THE WORDS.
//
// The words now come from a lyrics database — a published fact, not a guess — so there is nothing to
// download, nothing to configure, and nothing that can hallucinate. What's left is one honest
// choice: a real lyrics database, or YouTube's captions.
//
// The vocal stem still matters, but it is now an UPGRADE (line-level → word-level), not a
// prerequisite. That is why lyrics finally work by default, on a phone, with nothing switched on.
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
  const isYt = settings.lyricsModel === "youtube";
  const wordLevel = settings.stemModel !== "off"; // a neural vocal stem → per-word timing
  const mobile = isMobileDevice();

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <span className="settings-label">
          Lyrics
          <span className="settings-sub muted"> · real lyrics, timed to the vocal</span>
        </span>
        <button
          className={`toggle ${settings.lyricsAuto ? "on" : ""}`}
          onClick={() => set({ lyricsAuto: !settings.lyricsAuto })}
          role="switch"
          aria-checked={settings.lyricsAuto}
          title="Look up the real lyrics and time them to this track"
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {settings.lyricsAuto && (
        <>
          <div className="stem-models">
            <button
              className={`stem-model ${!isYt ? "on" : ""}`}
              onClick={() => set({ lyricsModel: "lrclib" })}
            >
              <span className="stem-model-label">
                Lyrics database
                <span className="stem-badge ok">Free · no download</span>
                {wordLevel && <span className="stem-badge cached">Word-timed</span>}
              </span>
              <span className="stem-model-note">
                The actual published lyrics, matched to this recording by its acoustic fingerprint — so they're the
                right words, in any language.{" "}
                {wordLevel
                  ? "Stem separation is on, so every word is placed on the vocal's own onsets."
                  : "Turn on stem separation above to time each individual word; without it you get line-by-line."}
              </span>
            </button>
            <button
              className={`stem-model ${isYt ? "on" : ""}`}
              onClick={() => set({ lyricsModel: "youtube" })}
            >
              <span className="stem-model-label">
                YouTube captions
                <span className="stem-badge ok">Instant</span>
              </span>
              <span className="stem-model-note">
                The uploader's own caption track. Line-level only, frequently auto-generated, and often missing or
                wrong — the fallback, not the choice.
              </span>
            </button>
          </div>

          {/* Per-deck state — the answer to "are they even firing?" */}
          {!isYt &&
            (decks.length === 0 ? (
              <div className="stem-reanalyze-empty">Load a track to look up its lyrics.</div>
            ) : (
              <div className="stem-deck-list">
                {decks.map((d) => {
                  const good = d.source === "aligned" || d.source === "pool";
                  const state = d.status
                    ? d.status
                    : d.source === "aligned"
                      ? `✓ word-timed · ${d.lines} lines`
                      : d.source === "pool"
                        ? `✓ word-timed (pooled) · ${d.lines} lines`
                        : d.source === "lrclib"
                          ? `line-synced · ${d.lines} lines`
                          : d.source === "youtube"
                            ? `YouTube captions · ${d.lines} lines`
                            : "no lyrics";
                  return (
                    <div className={`stem-deck-row${good ? " is-current" : ""}`} key={d.id}>
                      <span className="stem-deck-id">{d.id}</span>
                      <span className="stem-deck-state">{state}</span>
                      <button
                        className="stem-deck-reanalyze"
                        disabled={!onRetranscribe || !!d.status}
                        onClick={() => onRetranscribe?.(d.id)}
                        title={`Look deck ${d.id}'s lyrics up again and re-align them to its vocal stem`}
                      >
                        ↻ Re-fetch
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}

          {!isYt && !wordLevel && !mobile && (
            <p className="settings-hint warn">
              Stem separation is off, so lyrics are line-by-line. The words are still correct — only the per-word
              timing needs an isolated vocal to measure against.
            </p>
          )}
        </>
      )}

      <p className="settings-hint muted">
        Words come from the lyrics database; the <em>timings</em> are measured from this track's own isolated vocal —
        so they land on the beat even when the upload has a different intro. Aligned tracks are shared to the
        community pool, so nobody's device has to do it twice.
      </p>
    </div>
  );
}
