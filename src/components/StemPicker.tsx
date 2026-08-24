import type { StemName } from "@htl/stems";

// THE ONE STEM PICKER. Two surfaces were asking the same question in two different visual
// languages: the sampler pad menu ("full / drums / bass / vocals / inst" as plain text toggles)
// and the FX chain menu (four coloured squares). They ask WHICH PARTS OF THE TRACK — so they are
// the same control now, in the colours the stem cells and the chain chips already use.
//
// The callers differ in MEANING, not in shape:
//   • the sampler's set is a FILTER — any subset, and empty means the full mix
//   • a chain's set is a PARTITION — a stem has exactly one owner, so taking one takes it from
//     whoever held it (enforced in the engine, not here)
// Five cells: A for everything, then D B V I. "A" reads the same on both and does the right thing
// on each — the sampler clears its filter, the chain claims all four.
//
// ★ IT IS CONTEXTUAL, AND THE CALLER OWNS THAT. With no stems on the deck there is nothing to
// pick: a sample cannot be a stem slice and a chain cannot hear a stem. So the CALLER omits this
// whole section, label and all, rather than drawing five dead squares — a control that cannot
// mean anything yet is not a disabled control, it is a control that does not apply.
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
  onAll,
  allOn,
}: {
  mask: number;
  onToggle: (bit: number) => void;
  /** "A" — everything. It means the same thing on both surfaces and is implemented differently on
   *  each: the sampler clears its filter back to the full mix, a chain claims all four stems. */
  onAll: () => void;
  allOn: boolean;
}) {
  return (
    <div className="stem-pick">
      <button className={`stem-cell ${allOn ? "on" : ""}`} onClick={onAll} title="Everything">
        A
      </button>
      {STEMS.map((s) => (
        <button
          key={s.name}
          className={`stem-cell ${mask & s.bit ? "on" : ""}`}
          style={{ ["--lane" as string]: s.color }}
          title={s.label}
          aria-label={s.label}
          onClick={() => onToggle(s.bit)}
        >
          {s.label[0]}
        </button>
      ))}
    </div>
  );
}
