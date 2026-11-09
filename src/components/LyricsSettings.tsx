import type { LyricsSource } from "@htl/lyrics";
import { isMobileDevice, type Settings } from "@htl";
import { InfoDot } from "./settings/InfoDot";
import { OptionRow } from "./settings/OptionRow";

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
        <span className="settings-label">Lyrics</span>
        <InfoDot
          text="Lyrics for each loaded track, timed to the vocal. Word-by-word timing needs the track's vocal stem; without one they still show, line by line."
          label="Lyrics"
        />
        <button
          className={`toggle ${settings.lyricsAuto ? "on" : ""}`}
          onClick={() => set({ lyricsAuto: !settings.lyricsAuto })}
          role="switch"
          aria-checked={settings.lyricsAuto}
          aria-label="Lyrics"
        >
          <span className="toggle-knob" />
        </button>
      </div>

      {settings.lyricsAuto && (
        <>
          {/* Compact source picker (operator, 2026-11-08: "clean up the lyrics database"): one line
              per source, one badge, the explanation behind the ⓘ. */}
          <div className="stem-models" role="radiogroup" aria-label="Lyrics source">
            <OptionRow
              on={!isYt}
              onPick={() => set({ lyricsModel: "lrclib" })}
              label="Lyrics database"
              badge={<span className={`stem-badge ${wordLevel ? "cached" : "ok"}`}>{wordLevel ? "Word-timed" : "Line-timed"}</span>}
              info={`Published lyrics, matched by acoustic fingerprint, in any language. Free, nothing to download. ${wordLevel ? "Every word is timed to the vocal stem." : "Line by line until stems are on; with a vocal stem every word is timed."}`}
            />
            <OptionRow
              on={isYt}
              onPick={() => set({ lyricsModel: "youtube" })}
              label="YouTube captions"
              badge={<span className="stem-badge ok">Instant</span>}
              info="The uploader's own captions. Line-level, often auto-generated, and sometimes missing."
            />
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

          {/* With Auto-enhance on, a track whose stems are in the shared cache still gets its vocal
              stem (and so word timing) even with separation off, so "stems are off" was only true
              for the tracks nobody had separated yet. */}
          {!isYt && !wordLevel && !mobile && (
            <p className="settings-note warn">
              {settings.autoEnhance
                ? "Separation is off: word timing only for tracks with cached stems, line-by-line otherwise."
                : "Stems are off — right words, line-by-line timing."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
