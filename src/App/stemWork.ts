// Is THIS status stem work in progress? It drives the stem row's "loading" state on the deck and
// the auto-mixer's wait-for-incoming-stems, so a false yes shows a phantom loader or holds a mix.
//
// ★ A DECK HAS ONE STATUS SLOT, SHARED WITH THE TRACK LOAD. "Matching…", "Downloading… <pct>" and
// "Decoding…" are written into it with phase "downloading", the same phase a stem fetch uses. So
// judging by phase alone, a plain track load read as "stems loading" and the row showed the
// TRACK's download percent as a stem percent, then vanished on a device with stems off. Track-load
// writes carry `of: "track"`, and those never count.
export interface StemWorkStatus {
  phase: string;
  of?: "track";
}

export function isStemWork(s: StemWorkStatus | null | undefined): boolean {
  return !!s && s.of !== "track" && (s.phase === "downloading" || s.phase === "separating");
}
