import { useRef, useState } from "react";
import type { StemName } from "@htl/stems";

// THE ONE STEM PICKER. Two surfaces were asking the same question in two different visual
// languages: the sampler pad menu ("full / drums / bass / vocals / inst" as plain text toggles)
// and the FX chain menu (four coloured squares). They ask WHICH PARTS OF THE TRACK — so they are
// the same control now, in the colours the stem cells and the chain chips already use.
//
// The callers differ in MEANING, not in shape:
//   • the sampler's set is a FILTER — any subset, and empty means the full mix
//   • a chain's set is a PARTITION — a stem has exactly one owner, so taking one takes it from
//     whoever held it (enforced in FxRack.setChainStems, not here)
//
// ★ FOUR CELLS, NOT FIVE. There used to be a leading "A" for everything, and it was the widest
// thing any menu had to hold: --fx-menu-w's own derivation was "five cells at 34px, four 4px gaps
// and the row's padding ≈ 198", which then set the width of every context menu in the rack
// whatever was actually in it. It also meant two different things on the two surfaces (a chain
// CLAIMS all four; the sampler CLEARS its filter back to the full mix) — one button, two verbs.
// The gestures below cover both, and every partial selection A could never express:
//
//   click            toggle one
//   drag across      PAINT — the press picks the target state (the inverse of the cell you
//                    pressed) and every cell you sweep adopts it. All four = the old "A", in
//                    either direction.
//   right-click      SOLO — this stem alone. The verb the rest of the app already uses, and the
//   / long-press     shortest path to "just the drums".
//
// ★ THE DRAG COMMITS ONCE, ON RELEASE. It paints into a local mask and calls onCommit a single
// time. For a chain that matters: stems are a partition, so a sweep can take stems from up to
// four other chains, and committing per cell would fire four separate re-partitions, four
// rebuilds and four session emits for one gesture.
//
// ★ IT IS CONTEXTUAL, AND THE CALLER OWNS THAT. With no stems on the deck there is nothing to
// pick, so the CALLER omits this whole section, label and all, rather than drawing four dead
// squares — a control that cannot mean anything yet is not a disabled control, it is a control
// that does not apply.
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

const LONG_PRESS_MS = 460; // the same dwell ValueCell uses for its own touch context menu

/** `disabled` = this deck has no separated stems yet. The cells stay VISIBLE and go inert rather
 *  than disappearing: a control that vanishes teaches nothing, and the chain you are looking at is
 *  still a real chain — it just has no sources to hand it until the stems land. (That was ruled
 *  once, in 2493dfc, and then quietly lost when the menu was rebuilt; this is it restored.) */
export function StemPicker({ mask, onCommit, disabled = false }: { mask: number; onCommit: (mask: number) => void; disabled?: boolean }) {
  // What the cells show WHILE a sweep is in progress. The paint has to be visible as it happens —
  // cells that stay dark until you let go read as a control that ignored you — but it must not
  // reach the engine yet, so it is local state, not a stream of commits.
  const [preview, setPreview] = useState<number | null>(null);
  const shown = preview ?? mask;
  // The paint in progress. `on` is decided by the first cell and never re-decided, so sweeping
  // back over a cell you already painted does not flip it again — the checkbox-drag law.
  const paint = useRef<{ on: boolean; mask: number } | null>(null);
  const longPress = useRef(0);
  const rowRef = useRef<HTMLDivElement>(null);

  const clearLong = () => {
    if (longPress.current) window.clearTimeout(longPress.current);
    longPress.current = 0;
  };

  const paintTo = (bit: number) => {
    const p = paint.current;
    if (!p) return;
    const next = p.on ? p.mask | bit : p.mask & ~bit;
    if (next === p.mask) return;
    p.mask = next;
    setPreview(next);
  };

  const onDown = (bit: number) => (e: React.PointerEvent) => {
    if (e.button === 2) return; // the context menu owns the right button
    e.preventDefault();
    rowRef.current?.setPointerCapture(e.pointerId);
    paint.current = { on: !(mask & bit), mask };
    setPreview(mask);
    paintTo(bit);
    clearLong();
    if (e.pointerType === "touch") {
      longPress.current = window.setTimeout(() => {
        navigator.vibrate?.(8);
        paint.current = null; // swallow the tap that was in progress
        setPreview(null);
        onCommit(bit); // solo
      }, LONG_PRESS_MS);
    }
  };

  // Which cell is under the pointer — read from the DOM rather than from arithmetic, so the row's
  // own flex sizing (26–34 px cells, gaps, padding) stays the single source of truth for where a
  // cell actually is.
  const onMove = (e: React.PointerEvent) => {
    if (!paint.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const bit = Number((el as HTMLElement | null)?.closest<HTMLElement>("[data-bit]")?.dataset.bit ?? 0);
    if (!bit) return;
    clearLong(); // a real sweep is not a long-press
    paintTo(bit);
  };

  const onUp = (e: React.PointerEvent) => {
    clearLong();
    const p = paint.current;
    paint.current = null;
    try {
      rowRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setPreview(null);
    if (p) onCommit(p.mask); // ONE act, whatever the sweep touched
  };

  return (
    <>
      <div ref={rowRef} className={`stem-pick ${disabled ? "cold" : ""}`} onPointerMove={disabled ? undefined : onMove} onPointerUp={disabled ? undefined : onUp} onPointerCancel={disabled ? undefined : onUp}>
        {STEMS.map((s) => (
          <button
            key={s.name}
            data-bit={s.bit}
            className={`stem-cell ${shown & s.bit ? "on" : ""}`}
            style={{ ["--lane" as string]: s.color }}
            disabled={disabled}
            title={disabled ? `${s.label} — no stems on this deck yet` : `${s.label} — drag to paint, right-click to solo`}
            aria-label={s.label}
            aria-pressed={!!(shown & s.bit)}
            onPointerDown={disabled ? undefined : onDown(s.bit)}
            onContextMenu={(e) => {
              if (disabled) return void e.preventDefault();
              e.preventDefault();
              clearLong();
              paint.current = null;
              setPreview(null);
              onCommit(s.bit); // solo
            }}
          >
            {s.label[0]}
          </button>
        ))}
      </div>
      {/* A gesture nobody is told about is a gesture nobody uses — and "A" at least explained
          itself. This is a menu, not a live surface, so one muted line is affordable here where it
          would be clutter on the deck. */}
      <div className="stem-hint">{disabled ? "no stems on this deck yet — separate to route them" : "drag to paint · right-click to solo"}</div>
    </>
  );
}
