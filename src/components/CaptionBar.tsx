import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";
import type { LyricsSource, LyricsLine } from "@htl/lyrics";

// The four sources are NOT interchangeable and the badge must not pretend they are — you should be
// able to tell at a glance whether these words are GROUND TRUTH aligned to this track's own vocal,
// or a caption file somebody typed. That distinction is most of "can I trust what I'm reading".
const SOURCE_TAG: Record<LyricsSource, { icon: string; label: string }> = {
  aligned: { icon: "🎯", label: "every word placed on this track's own vocal onsets" },
  lrclib: { icon: "📖", label: "line-synced lyrics — turn on stem separation for word-level timing" },
  estimated: { icon: "〜", label: "right words, but no synced file existed — timing derived from the vocal alone" },
  pool: { icon: "☁", label: "aligned by someone else's device, shared to the community pool" },
  youtube: { icon: "▶", label: "YouTube captions (no word timing, and only as good as the uploader)" },
};

// A word marker shows its label once it has at least this many px to the next word; the song's
// own median word spacing × px-per-second decides the global word↔phrase LOD switch.
const WORD_LABEL_PX = 34;

// A per-deck LYRIC TIMELINE on the SAME time axis as the waveform above. Every WORD is a tick
// at its EXACT time (the musical cheat — see precisely when each word lands vs the beats);
// LOD collapses them into phrases as you zoom:
//   • zoomed in  → word labels at each tick; the sung word lights the deck accent.
//   • zoomed out → labels collapse; the line/phrase text shows, ticks fade to a vocal-rhythm
//                  comb, and the line being sung stays readable as a chip.
// Past/future words are normal text colour — only the current word is deck-coloured. Tap a
// word (or phrase) to jump to that exact moment.
export function CaptionBar({
  deck,
  accent,
  cues,
  source,
  status,
  windowSec,
  onSeek,
  onReprocess,
}: {
  deck: Deck;
  accent: string;
  cues: LyricsLine[];
  source?: LyricsSource | null;
  status?: string | null; // live lyric state — model download, decode %, waiting for the vocal stem
  windowSec: number;
  onSeek?: (position: number) => void;
  onReprocess?: (engine: "lrclib" | "youtube") => void; // wrong lyrics → re-resolve from scratch
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const phrasesRef = useRef<HTMLDivElement>(null);
  const wordsRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(0);
  const windowRef = useRef(windowSec);
  windowRef.current = windowSec;

  // Flat word list (chronological) — built in render so JSX + the rAF index identically.
  const words: { t: number; w: string; d?: number }[] = [];
  for (const c of cues) if (c.words) for (const wd of c.words) words.push(wd);

  useEffect(() => {
    const wrap = wrapRef.current;
    const track = trackRef.current;
    const phrasesEl = phrasesRef.current;
    const wordsEl = wordsRef.current;
    if (!wrap || !track || !phrasesEl || !wordsEl || cues.length === 0) return;

    // Measure HERE (re-runs when cues land) — a mount-only observer would attach before the
    // null-until-lyrics node exists and width would stay 0.
    const measure = () => (widthRef.current = wrap.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    track.classList.toggle("has-words", words.length > 0); // youtube fallback (no words) lights whole lines

    const wordT: number[] = words.map((w) => w.t);
    const wordD: number[] = words.map((w) => w.d ?? 0); // held duration → bar length

    let raf = 0;
    let laidPps = -1;
    let laidW = -1;
    let activeWord = -2;
    let activePhrase = -2;

    const loop = () => {
      let w = widthRef.current;
      if (w <= 0) w = widthRef.current = wrap.clientWidth;
      if (w > 0) {
        const rate = Math.max(deck.rate, 0.01);
        const window = Math.max(0.1, windowRef.current * rate);
        const pps = w / window; // px per second — identical scale to the waveform's toX
        const pos = deck.visualPosition();

        // Layout (positions + LOD) only when the scale changes — not per frame.
        if (Math.abs(pps - laidPps) > 1e-4 || w !== laidW) {
          // Word ticks + duration BARS at EXACT times — the marker style is identical at EVERY
          // zoom. Only the LABEL is LOD'd, PER WORD: it shows when the gap to the next word has
          // room, so dense passages thin to a clean tick comb while sparse ones keep their words
          // (no global word↔phrase style switch — that mismatch was the "incongruent" part).
          for (let i = 0; i < wordT.length; i++) {
            const el = wordsEl.children[i] as HTMLElement | undefined;
            if (!el) continue;
            el.style.left = `${wordT[i] * pps}px`;
            const bar = el.children[1] as HTMLElement | undefined;
            if (bar) bar.style.width = `${wordD[i] * pps}px`;
            const gap = (i + 1 < wordT.length ? wordT[i + 1] - wordT[i] : 1) * pps;
            el.classList.toggle("no-label", gap < WORD_LABEL_PX);
          }
          // Phrase line text at line start. With per-word data only the ACTIVE line shows (CSS) as
          // a readable chip when zoomed out; the YouTube segment-only path (no words) shows all.
          for (let i = 0; i < cues.length; i++) {
            const el = phrasesEl.children[i] as HTMLElement | undefined;
            if (!el) continue;
            const left = cues[i].start * pps;
            const right = i + 1 < cues.length ? cues[i + 1].start * pps : left + pps * 4;
            el.style.left = `${left}px`;
            el.style.maxWidth = `${Math.max(24, right - left - 6)}px`;
          }
          laidPps = pps;
          laidW = w;
        }

        // Scroll so NOW sits at centre — one transform write per frame.
        track.style.transform = `translateX(${w / 2 - pos * pps}px)`;

        // Current WORD (exact times) → deck-accent tick + label, and its duration bar FILLS
        // as the playhead sweeps it: a long word takes a long time to fill (the "long word"
        // cue), a quick word snaps full.
        let wi = -1;
        for (let i = 0; i < wordT.length; i++) {
          if (wordT[i] <= pos) wi = i;
          else break;
        }
        if (wi !== activeWord) {
          const old = wordsEl.children[activeWord] as HTMLElement | undefined;
          old?.classList.remove("cw-on");
          const oldFill = old?.children[1]?.children[0] as HTMLElement | undefined;
          if (oldFill) oldFill.style.width = "0%"; // reset the previous word's fill
          (wordsEl.children[wi] as HTMLElement | undefined)?.classList.add("cw-on");
          activeWord = wi;
        }
        if (activeWord >= 0) {
          const d = wordD[activeWord];
          const pct = d > 0 ? Math.max(0, Math.min(1, (pos - wordT[activeWord]) / d)) : 1;
          const fill = (wordsEl.children[activeWord] as HTMLElement | undefined)?.children[1]?.children[0] as HTMLElement | undefined;
          if (fill) fill.style.width = `${pct * 100}%`;
        }
        // Current PHRASE → readable chip (the zoom-out grace).
        let pi = -1;
        for (let i = 0; i < cues.length; i++) {
          if (cues[i].start <= pos) pi = i;
          else break;
        }
        if (pi !== activePhrase) {
          (phrasesEl.children[activePhrase] as HTMLElement | undefined)?.classList.remove("on");
          (phrasesEl.children[pi] as HTMLElement | undefined)?.classList.add("on");
          activePhrase = pi;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, cues]);

  const tag = source ? SOURCE_TAG[source] : null;
  const tools = (
    <span className="caption-tools">
      {tag && (
        <span className="caption-source" title={tag.label} aria-label={tag.label}>
          {tag.icon}
        </span>
      )}
      {onReprocess && (
        <span className="caption-reprocess">
          <button
            className="caption-redo"
            title="Wrong lyrics? Look them up again and re-align to the vocal stem"
            aria-label="Re-fetch and re-align lyrics"
            onClick={() => onReprocess("lrclib")}
          >
            📖↻
          </button>
          <button
            className="caption-redo"
            title="Wrong lyrics? Reload YouTube captions instead"
            aria-label="Reload YouTube captions"
            onClick={() => onReprocess("youtube")}
          >
            ▶↻
          </button>
        </span>
      )}
    </span>
  );

  // ★ THE BAR MUST EXIST WHILE IT IS WORKING. It used to `return null` on zero cues, so for the
  // entire time Whisper was downloading a model, waiting for the vocal stem, decoding, or failing,
  // there was NOTHING ON SCREEN AT ALL — which is precisely why "I can't tell when or if they're
  // firing". Now: no cues + no state → genuinely idle, render nothing. No cues but something IS
  // happening → render the state, with the retry buttons in reach.
  if (cues.length === 0) {
    if (!status) return null;
    return (
      <div className="caption-bar caption-idle" ref={wrapRef} style={{ ["--accent" as string]: accent }}>
        <span className="caption-state" aria-live="polite">
          <span className="lane-proc-dot" />
          {status}
        </span>
        {tools}
      </div>
    );
  }

  return (
    <div className="caption-bar beatlock" ref={wrapRef} style={{ ["--accent" as string]: accent }}>
      {/* Keep the state visible even once lyrics ARE showing — a re-decode (🎤↻) or a Whisper pass
          upgrading a stale pooled transcript is otherwise completely invisible. */}
      {status && (
        <span className="caption-state over" aria-live="polite">
          <span className="lane-proc-dot" />
          {status}
        </span>
      )}
      <div className="caption-track" ref={trackRef}>
        <div className="caption-phrases" ref={phrasesRef}>
          {cues.map((c, i) => (
            <button key={i} className="caption-phrase" title={c.text} onClick={() => onSeek?.(c.start)}>
              <span className="cp-text">{c.text}</span>
            </button>
          ))}
        </div>
        <div className="caption-words" ref={wordsRef}>
          {words.map((wd, i) => (
            <button key={i} className="caption-word" title={wd.w} onClick={() => onSeek?.(wd.t)}>
              <span className="cw-tick" />
              <span className="cw-bar">
                <span className="cw-fill" />
              </span>
              <span className="cw-label">{wd.w}</span>
            </button>
          ))}
        </div>
      </div>
      {tools}
    </div>
  );
}
