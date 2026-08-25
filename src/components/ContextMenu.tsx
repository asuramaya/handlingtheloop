import { useLayoutEffect, useRef, useState } from "react";

// ONE MENU, for every surface that opens one at a cursor. The FX preset menu, the chain menu, the
// add-a-device picker and the SAMPLER pad menu are the same widget with different contents: a head
// naming what you are editing, a row of glyph ACTS, then the body.
//
// The sampler's menu used to be a second implementation with its own backdrop, its own label
// style, its acts spelled out as sentences at the BOTTOM, and — the part that mattered — its own
// positioning: a hard-coded `Math.min(x, innerWidth - 200)` guess that neither measured nor
// flipped, so a tall menu near an edge was cut off exactly the way the FX menus used to be. Two
// implementations meant fixing that twice, and it only ever got fixed once.
//
// The acts are GLYPHS with tooltips, not sentences: they are the same three verbs everywhere —
// ＋ save this as a preset, ✎ rename, ✕ delete/remove — so the row is read once and known after.
// "✕ Remove from VOCAL AIR" spelled out was wider than the menu it sat in.
export interface MenuAct {
  glyph: string;
  title: string;
  danger?: boolean;
  onClick: () => void;
}
export function Menu({ x, y, head, acts, onClose, wide, innerRef, children }: { x: number; y: number; head: React.ReactNode; acts?: MenuAct[]; onClose: () => void; wide?: boolean; innerRef?: React.Ref<HTMLDivElement>; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; flipped: boolean } | null>(null);
  // ★ FLIP, THEN CLAMP. A menu opens at the cursor, and a cursor near the right edge of a deck
  // column (or near the bottom of the viewport) puts most of the menu somewhere it cannot be
  // read — the COMP bank ran off the screen with half its presets past the edge. So: measure
  // after layout, flip to the other side of the cursor if that side has room, and clamp to the
  // viewport either way. Position is applied in one pass before paint (useLayoutEffect), so the
  // menu never appears in the wrong place first.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const M = 6; // never touch the edge
    let left = x;
    const flipped = x + r.width > vw - M;
    if (flipped) left = x - r.width; // flip to the cursor's left
    left = Math.max(M, Math.min(left, vw - r.width - M));
    let top = y;
    if (y + r.height > vh - M) top = y - r.height; // flip above the cursor
    top = Math.max(M, Math.min(top, vh - r.height - M));
    setPos({ left, top, flipped });
  }, [x, y, children]);
  return (
    <>
      <div className="fx-menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={(n) => {
          box.current = n;
          if (typeof innerRef === "function") innerRef(n);
          else if (innerRef) (innerRef as React.MutableRefObject<HTMLDivElement | null>).current = n;
        }}
        className={`fx-palette fx-preset-menu ${wide ? "fx-chain-menu" : ""} ${pos?.flipped ? "flip-left" : ""}`}
        role="menu"
        // Hidden for the one frame between mount and measurement — an unplaced menu flashing at
        // the cursor before jumping is the same flicker this is meant to remove.
        style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: "hidden" }}
      >
        <div className="fx-preset-head">
          <span className="fx-preset-title">{head}</span>
          {acts && acts.length > 0 && (
            <span className="fx-menu-acts">
              {acts.map((a) => (
                <button key={a.glyph + a.title} className={`fx-act ${a.danger ? "danger" : ""}`} title={a.title} aria-label={a.title} role="menuitem" onClick={a.onClick}>
                  {a.glyph}
                </button>
              ))}
            </span>
          )}
        </div>
        {children}
      </div>
    </>
  );
}


// THE SECOND WINDOW — the flyout that opens beside a menu row (effect presets on the add picker,
// a chain's contents on the chain menu). It was a bespoke box before: its own width, its own
// chrome, and — because it never said `flex-direction: column` — its own LAYOUT, which let the
// preset names flow inline and wrap into a ragged second column that looked like a bug because it
// was one. It is the menu panel now. Same chrome, same column, same scroll, and it takes the
// opening menu's measured width so the pair reads as one object rather than two guesses.
export function MenuFly({
  anchor,
  width,
  head,
  onEnter,
  onLeave,
  children,
}: {
  /** The row that opened it, in viewport coordinates. */
  anchor: { left: number; right: number; top: number };
  /** The opening menu's measured width — the pair matches by construction, not by a constant. */
  width: number;
  head: React.ReactNode;
  onEnter?: () => void;
  onLeave?: () => void;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Same flip-then-clamp as Menu, for the same reason: a deck column is ~450 px and there are two
  // of them, so the side with room is frequently the LEFT one.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const M = 6, GAP = 4;
    let left = anchor.right + GAP;
    if (left + r.width > vw - M) left = anchor.left - r.width - GAP;
    left = Math.max(M, Math.min(left, vw - r.width - M));
    const top = Math.max(M, Math.min(anchor.top - 6, vh - r.height - M));
    setPos({ left, top });
  }, [anchor.left, anchor.right, anchor.top, width, children]);
  return (
    <div
      ref={box}
      className="fx-palette fx-preset-menu fx-menu-fly"
      role="menu"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={
        pos
          ? { left: pos.left, top: pos.top, minWidth: width }
          : { left: anchor.right + 4, top: anchor.top, minWidth: width, visibility: "hidden" }
      }
    >
      <div className="fx-preset-head">
        <span className="fx-preset-title">{head}</span>
      </div>
      {children}
    </div>
  );
}
