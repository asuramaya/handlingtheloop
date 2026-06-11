import { useEffect, useRef } from "react";
import type { Deck } from "@htl/audio";
import type { CaptionCue } from "@htl/media";

// Spacing between caption lines on the strip. Lines are evenly spaced (not by their
// time gaps) so the CURRENT line always sits exactly under the centered playhead and
// slides one slot to the next when it changes — precise, not time-drifting.
const LINE_GAP = 360;

// A thin per-deck caption ribbon. The line playing NOW is held centered under the
// playhead and lit in the deck accent; the previous/next lines flank it, faded. As
// the deck crosses into the next cue the strip slides one slot (CSS-transitioned).
export function CaptionBar({ deck, accent, cues }: { deck: Deck; accent: string; cues: CaptionCue[] }) {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || cues.length === 0) return;
    let last = -2;
    let raf = 0;
    const loop = () => {
      const pos = deck.position();
      // The line currently or most recently started (it holds until the next begins).
      let cur = -1;
      for (let i = 0; i < cues.length; i++) {
        if (cues[i].start <= pos) cur = i;
        else break;
      }
      if (cur !== last) {
        track.style.transform = `translateX(${-Math.max(0, cur) * LINE_GAP}px)`;
        (track.children[last] as HTMLElement | undefined)?.classList.remove("on");
        (track.children[cur] as HTMLElement | undefined)?.classList.add("on");
        last = cur;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [deck, cues]);

  if (cues.length === 0) return null;
  return (
    <div className="caption-bar" style={{ ["--accent" as string]: accent }}>
      <div className="caption-track" ref={trackRef}>
        {cues.map((c, i) => (
          <span key={i} className="caption-cue" style={{ left: `${i * LINE_GAP}px` }}>
            {c.text}
          </span>
        ))}
      </div>
    </div>
  );
}
