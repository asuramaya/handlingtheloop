import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";
import type { LyricsSource, LyricsLine } from "@htl/lyrics";

const SOURCE_TAG: Record<LyricsSource, { icon: string; label: string }> = {
  whisper: { icon: "🎤", label: "auto lyrics (word-timed)" },
  pool: { icon: "🎤", label: "auto lyrics (word-timed)" },
  youtube: { icon: "▶", label: "YouTube captions" },
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
  windowSec,
  status,
  onSeek,
}: {
  deck: Deck;
  accent: string;
  cues: LyricsLine[];
  source?: LyricsSource | null;
  windowSec: number;
  status?: string | null;
  onSeek?: (position: number) => void;
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

    // Median word spacing → the zoom at which per-word labels get room (rap is denser, so it
    // needs more zoom before labels appear). Computed once per cue set.
    const wordT: number[] = words.map((w) => w.t);
    const wordD: number[] = words.map((w) => w.d ?? 0); // held duration → bar length
    let medianGap = Infinity;
    if (wordT.length > 2) {
      const gaps: number[] = [];
      for (let i = 1; i < wordT.length; i++) gaps.push(wordT[i] - wordT[i - 1]);
      gaps.sort((a, b) => a - b);
      medianGap = gaps[gaps.length >> 1] || 0.3;
    }

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
          // Word ticks/labels at their EXACT times; the duration BAR spans how long the word
          // is held (so a sustained word reads long, a clipped one short).
          for (let i = 0; i < wordT.length; i++) {
            const el = wordsEl.children[i] as HTMLElement | undefined;
            if (!el) continue;
            el.style.left = `${wordT[i] * pps}px`;
            const bar = el.children[1] as HTMLElement | undefined;
            if (bar) bar.style.width = `${wordD[i] * pps}px`;
          }
          // Phrase labels at line start, clipped to the gap before the next line.
          for (let i = 0; i < cues.length; i++) {
            const el = phrasesEl.children[i] as HTMLElement | undefined;
            if (!el) continue;
            const left = cues[i].start * pps;
            const right = i + 1 < cues.length ? cues[i + 1].start * pps : left + pps * 4;
            el.style.left = `${left}px`;
            el.style.maxWidth = `${Math.max(24, right - left - 6)}px`;
          }
          // Global LOD: word labels only when the median word has room; else phrase text.
          const wordMode = wordT.length > 0 && medianGap * pps >= WORD_LABEL_PX;
          track.classList.toggle("word-lod", wordMode);
          track.classList.toggle("phrase-lod", !wordMode);
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

  if (cues.length === 0 && !status) return null;
  const tag = source ? SOURCE_TAG[source] : null;
  return (
    <div className="caption-bar beatlock" ref={wrapRef} style={{ ["--accent" as string]: accent }}>
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
      {status && (
        <span className="caption-status" aria-live="polite">
          <span className="caption-spin" />
          {status}
        </span>
      )}
      {tag && (
        <span className="caption-source" title={tag.label} aria-label={tag.label}>
          {tag.icon}
        </span>
      )}
    </div>
  );
}
