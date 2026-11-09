import type { CSSProperties, ReactNode } from "react";

// ★ ONE CHIP FOR A TRACK'S NUMBERS (operator, 2026-11-08: "the text and key etc chips need flare
// and consistency across the interface"). BPM, KEY and TIME were four different things in four
// places — plain muted digits in the track rows, an accent "BPM" word and a grey key in the deck
// header, a stacked dt/dd in the queue cards. Now every one of them is this chip: tabular digits
// in a soft pill, the KEY tinted by where it sits on the Camelot wheel, so two keys that mix
// (same number, or ±1) read as neighbouring colours before you have parsed a single digit.

// Musical names → Camelot, for keys stored as "C#m" / "Eb" rather than "12A".
const MUSICAL: Record<string, string> = {
  B: "1B", "F#": "2B", Gb: "2B", Db: "3B", "C#": "3B", Ab: "4B", "G#": "4B", Eb: "5B", "D#": "5B", Bb: "6B", "A#": "6B",
  F: "7B", C: "8B", G: "9B", D: "10B", A: "11B", E: "12B",
  "G#m": "1A", Abm: "1A", "D#m": "2A", Ebm: "2A", "A#m": "3A", Bbm: "3A", Fm: "4A", Cm: "5A", Gm: "6A", Dm: "7A",
  Am: "8A", Em: "9A", Bm: "10A", "F#m": "11A", Gbm: "11A", "C#m": "12A", Dbm: "12A",
};

/** A key's position on the Camelot wheel, or null if it is not a key we can read. */
export function camelotOf(key: string | null | undefined): { num: number; minor: boolean } | null {
  if (!key) return null;
  const k = key.trim();
  const m = /^(\d{1,2})\s*([AB])$/i.exec(k) ?? /^(\d{1,2})\s*([AB])$/i.exec(MUSICAL[k.replace(/\s*(maj(or)?)$/i, "").replace(/\s*min(or)?$/i, "m")] ?? "");
  if (!m) return null;
  const num = parseInt(m[1], 10);
  if (num < 1 || num > 12) return null;
  return { num, minor: m[2].toUpperCase() === "A" };
}

/** The hue (0–360) for a key: 30° per wheel step, so neighbours on the wheel are neighbours in
 *  colour, and the relative major/minor (same number) share a hue. */
export function keyHue(key: string | null | undefined): number | null {
  const c = camelotOf(key);
  return c ? ((c.num - 1) * 30 + 165) % 360 : null;
}

export function MetaChip({
  kind,
  children,
  title,
  className,
  style,
  keyName,
}: {
  kind: "bpm" | "key" | "time";
  children: ReactNode;
  title?: string;
  className?: string;
  style?: CSSProperties;
  /** For kind="key": the key to colour by, when the children are not just the key itself. */
  keyName?: string | null;
}) {
  const empty = children == null || children === "" || children === "—";
  const c = kind === "key" && !empty ? camelotOf(keyName ?? (typeof children === "string" ? children : null)) : null;
  const hue = c ? ((c.num - 1) * 30 + 165) % 360 : null;
  const st: CSSProperties | undefined =
    hue != null ? ({ ...style, ["--kh" as string]: String(hue), ["--kl" as string]: c!.minor ? "58%" : "68%" } as CSSProperties) : style;
  return (
    <span className={`mchip mchip-${kind}${hue != null ? " keyed" : ""}${empty ? " empty" : ""}${className ? ` ${className}` : ""}`} style={st} title={title}>
      {empty ? "—" : children}
    </span>
  );
}
