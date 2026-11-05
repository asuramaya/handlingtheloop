// What AUTO is doing, in words. Shared by the library header's AUTO button (short) and the Queue
// panel's status strip (full sentence).
//
// ★ WHY. Operator, 2026-11-04: auto mode was "a bit broken and confusing". Half of the confusion
// was that the machine's state never reached the screen: AUTO lit up and then nothing happened,
// with no way to tell "waiting for you to press play" from "waiting for radio" from "about to mix".
// The status carries all of it now (autoMixer.ts AutoMixStatus); this turns it into sentences.
import type { AutoMixStatus } from "@htl/automix";

export interface AutoLine {
  /** Short text for the AUTO button ("0:42", "mixing 45%", "held"…); null = just "AUTO". */
  chip: string | null;
  /** Full sentence for the Queue panel. */
  headline: string;
  /** A second line where there is more to say (the planned transition, what to do). */
  detail: string | null;
  /** Visual tone: "idle" (off), "wait" (needs something), "run" (counting down), "mix" (mixing),
   *  "hold" (held), "manual" (user has the fader). */
  tone: "idle" | "wait" | "run" | "mix" | "hold" | "manual";
}

export const fmtClock = (sec: number): string => {
  const s = Math.max(0, Math.ceil(sec));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
};

/** `nextTitle` is the track AUTO will mix into (queue head), if any. */
export function autoLine(st: AutoMixStatus, nextTitle: string | null): AutoLine {
  const next = nextTitle ? `“${nextTitle}”` : "the next track";
  const plan = st.planLabel ? `${st.planResolved ? "" : "planned: "}${st.planLabel}` : null;
  if (!st.enabled) {
    return {
      chip: null,
      headline: "AUTO is off",
      detail: "The queue waits. With AUTO on, it mixes through it track to track.",
      tone: "idle",
    };
  }
  if (st.manual) {
    return { chip: "yours", headline: "You took the crossfader", detail: "AUTO steps back until one deck is left playing, then carries on.", tone: "manual" };
  }
  if (st.phase === "mixing") {
    const pct = st.mixProgress != null ? Math.round(st.mixProgress * 100) : null;
    return {
      chip: pct != null ? `mixing ${pct}%` : "mixing",
      headline: `Mixing into ${next}${pct != null ? ` · ${pct}%` : ""}`,
      detail: plan,
      tone: "mix",
    };
  }
  if (st.held) {
    return { chip: "held", headline: "Holding on this track", detail: "No mix until you press Hold again or Mix now. If it ends, the next track still starts.", tone: "hold" };
  }
  switch (st.waitReason) {
    case "press-play":
      return { chip: "paused", headline: "Paused", detail: "Press play on a deck and AUTO picks up from there.", tone: "wait" };
    case "queue-empty":
      return { chip: "empty", headline: "The queue is empty", detail: "Add tracks, pick a playlist, or switch Tracks to Suggestions.", tone: "wait" };
    case "radio-filling":
      return { chip: "finding", headline: "Finding suggestions", detail: "Tracks that fit what is playing will appear below.", tone: "wait" };
    case "loading-next":
      return { chip: "loading", headline: `Loading ${next}`, detail: plan, tone: "wait" };
    case "stems":
      return { chip: "stems", headline: `Separating stems for ${next}`, detail: "The mix waits a few seconds for them, then goes without.", tone: "wait" };
    case "playlist-ended":
      return { chip: "suggest", headline: "The playlist ran out, suggestions took over", detail: "They follow what is playing now.", tone: "wait" };
  }
  if (st.countdownSec != null) {
    return {
      chip: st.forced ? "now" : fmtClock(st.countdownSec),
      headline: st.forced ? `Mixing into ${next} now` : `Mixes into ${next} in ${fmtClock(st.countdownSec)}`,
      detail: plan,
      tone: "run",
    };
  }
  // A live deck but no mix point yet: the tick right after a transition settles, before the next
  // exit is chosen. Saying "once a track is playing" there read as if the music had stopped.
  if (st.liveDeck) return { chip: null, headline: "AUTO is on", detail: "Planning the next mix…", tone: "run" };
  return { chip: null, headline: "AUTO is on", detail: "It starts mixing once a track is playing.", tone: "run" };
}
