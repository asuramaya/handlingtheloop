// What a jog / beat-jump arrow does on a deck, decided in ONE place for every surface.
//
// ★ (operator, 2026-11-11: session sync audit) The keyboard and MIDI arrows moved an ACTIVE loop
// (rekordbox beat-jump-with-loop) while the on-screen arrows beat-jumped the head inside it, so the
// same press did two different things depending on which surface the DJ touched. Both now ask this.
//   adjust — a loop boundary is armed (Shift-IN / Shift-OUT): step that edge
//   move   — SHIFT, or a live loop: travel the whole loop
//   jump   — otherwise: beat-jump the playhead
export type JogMode = "adjust" | "move" | "jump";

export function jogMode(p: { adjusting: boolean; shift: boolean; loopActive: boolean }): JogMode {
  if (p.adjusting) return "adjust";
  if (p.shift || p.loopActive) return "move";
  return "jump";
}
