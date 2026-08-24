import type { StemName } from "@htl/stems";

// THE ONE STEM PICKER. Two surfaces were asking the same question in two different visual
// languages: the sampler pad menu ("full / drums / bass / vocals / inst" as plain text toggles)
// and the FX chain menu (four coloured squares). They ask WHICH PARTS OF THE TRACK — so they are
// the same control now, in the colours the stem cells and the chain chips already use.
//
// The callers differ in MEANING, not in shape, and the difference is one prop:
//   • the sampler's set is a FILTER — any subset, and empty means the full mix
//   • a chain's set is a PARTITION — a stem has exactly one owner, so taking one takes it from
//     whoever held it (enforced in the engine, not here)
export const STEMS: { name: StemName; label: string; bit: number; color: string }[] = [
  { name: "drums", label: "DRUM", bit: 1, color: "#ff5d73" },
  { name: "bass", label: "BASS", bit: 2, color: "#b06bff" },
  { name: "vocals", label: "VOICE", bit: 4, color: "#5dff9e" },
  { name: "other", label: "INST", bit: 8, color: "#36c2ff" },
];
export const ALL_STEM_BITS = 0b1111;

export function stemsToMask(names: readonly StemName[] | undefined): number {
  if (!names?.length) return 0;
  return STEMS.reduce((m, s) => (names.includes(s.name) ? m | s.bit : m), 0);
}
export function maskToStems(mask: number): StemName[] {
  return STEMS.filter((s) => mask & s.bit).map((s) => s.name);
}

export function StemPicker({
  mask,
  onToggle,
  hasStems,
  full,
  onFull,
  note,
}: {
  mask: number;
  onToggle: (bit: number) => void;
  hasStems: boolean;
  /** Show a leading FULL cell (the sampler's "no filter"). Chains have no such state — a chain
   *  holding every stem IS the full signal, so the four cells already say it. */
  full?: boolean;
  onFull?: () => void;
  /** What to say when the deck has no stems yet, instead of four dead squares and no reason. */
  note?: string;
}) {
  return (
    <div className={`stem-pick ${hasStems ? "" : "cold"}`}>
      {full && (
        <button className={`stem-cell wide ${mask === 0 ? "on" : ""}`} disabled={!hasStems} onClick={onFull} title="The full mix — no stem filter">
          FULL
        </button>
      )}
      {STEMS.map((s) => (
        <button
          key={s.name}
          className={`stem-cell ${mask & s.bit ? "on" : ""}`}
          style={{ ["--lane" as string]: s.color }}
          // Visible and inert rather than hidden: the control still teaches what it does, and the
          // reason it cannot act right now is written underneath it.
          disabled={!hasStems}
          title={hasStems ? s.label : `${s.label} — no stems on this deck yet`}
          aria-label={s.label}
          onClick={() => onToggle(s.bit)}
        >
          {s.label[0]}
        </button>
      ))}
      {!hasStems && note && <span className="stem-pick-note">{note}</span>}
    </div>
  );
}
