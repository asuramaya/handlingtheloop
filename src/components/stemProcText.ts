// The deck header's stem-work label: what the deck is doing to get its stems, in a few words.
//
// ★ IT USED TO BE DERIVED FROM THE PHASE ALONE, and a fresh separation has three stages that phase
// cannot tell apart: a one-time model download (~170 MB), the GPU session setup, then the actual
// inference windows. Only the last reports a percentage, so the first two both rendered
// "Separating 0%" — for several seconds when healthy, and forever when session setup hung on the
// self-signed dev server (decision 7b5a5bfd). A user cannot tell "downloading", "warming up" and
// "stuck" apart from one frozen number, which is the whole job of a progress label. `step` names
// the stage; this function is where it becomes words, so the rule is testable without a deck.
import type { StemStatus } from "../App";

/** True while the lane should show stem work at all: on-device separation (every stage), or a
 *  shared/neural fetch (`downloading` with a source). Other phases are chips, not progress. */
export function isStemBusy(s: StemStatus | null | undefined): s is StemStatus {
  return s != null && (s.phase === "separating" || (s.phase === "downloading" && !!s.src));
}

const pctText = (pct: number | undefined) => (pct != null ? ` ${Math.round(pct)}%` : "…");

export function stemProcText(s: StemStatus | null | undefined): string | null {
  if (!isStemBusy(s)) return null;
  if (s.step === "model") return `Downloading model${pctText(s.pct)}`;
  if (s.step === "prep") return "Preparing GPU…";
  return `${s.phase === "separating" ? "Separating" : "Fetching stems"}${pctText(s.pct)}`;
}
