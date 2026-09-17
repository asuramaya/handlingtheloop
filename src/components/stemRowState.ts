// What the deck's stem-mixer row shows.
//
// ★ THREE STATES THAT USED TO BE TWO. The row either held the four stem cells or a dashed
// "Stems loading…" placeholder, and the placeholder had two unrelated jobs: say THIS deck's stems
// are coming, and hold the row's height so two SIDE-BY-SIDE decks stay aligned when only the other
// one has stems. Sharing one element for both made two visible bugs on a phone:
//  • GHOST: a deck with no stems at all said "Stems loading…" forever whenever the other deck had
//    stems — a false label, and 50px taken from the buttons. On a phone the other deck isn't even
//    on screen (the focused deck owns the surface), so the alignment bought nothing.
//  • BLANK: a deck mirroring a host's stems (marked loaded, envelopes not landed yet) has no status
//    phase, so neither branch matched and the row was empty while its stems were on the way.
// So "loading" is only ever about THIS deck, and "reserve" is a silent spacer the CSS collapses on
// a phone.

export type StemRowState = "cells" | "loading" | "reserve" | "none";

export interface StemRowInput {
  /** Cells can render: local stems, or a mirror whose envelopes arrived. */
  ready: boolean;
  /** This deck is marked as holding stems (includes a mirror still waiting for envelopes). */
  marked: boolean;
  /** This deck's own stems are being fetched / separated / requested. */
  pending: boolean;
  /** The other deck shows a stem row (ready or loading). */
  otherShowsRow: boolean;
}

export function stemRowState(s: StemRowInput): StemRowState {
  if (s.ready) return "cells";
  if (s.pending || s.marked) return "loading";
  if (s.otherShowsRow) return "reserve";
  return "none";
}
