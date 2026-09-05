import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
export function Menu({ x, y, head, acts, onClose, wide, innerRef, layer, chin, children }: { x: number; y: number; head?: React.ReactNode; acts?: MenuAct[]; onClose: () => void; wide?: boolean; innerRef?: React.Ref<HTMLDivElement>; /** Stacking tier. Omit for a menu opened from the page; 3 for one opened from INSIDE another menu or its flyout — those sit at 41 and 43, so a row menu spawned from them has to clear both or it opens underneath what spawned it. */ layer?: 3 | 4; /** ★ THE CHIN — pinned under the scroll, not carried by it. See MENU_CHIN below. */ chin?: React.ReactNode; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; flipped: boolean } | null>(null);
  // ★ FLIP, THEN CLAMP. A menu opens at the cursor, and a cursor near the right edge of a deck
  // column (or near the bottom of the viewport) puts most of the menu somewhere it cannot be
  // read — the COMP bank ran off the screen with half its presets past the edge. So: measure
  // after layout, flip to the other side of the cursor if that side has room, and clamp to the
  // viewport either way. Position is applied in one pass before paint (useLayoutEffect), so the
  // menu never appears in the wrong place first.
  // ★ THE PRESS THAT OPENED THE MENU MUST NOT ALSO ACT ON IT.
  // A touch long-press opens this menu at 460ms with the finger STILL DOWN, so the menu and its
  // full-screen backdrop mount underneath a live press. Everything that press emits afterwards
  // then lands on a target that did not exist when it started:
  //   · finger up -> a synthesised `click` on the backdrop -> onClose. The menu flickers and dies.
  //   · Android also fires its OWN `contextmenu` at ~500ms — either onto the backdrop (the same
  //     instant close) or back onto the opener, which re-opens the menu at a new position.
  // A timer would only guess at how long to stay deaf. The precise test is CAUSAL, not temporal:
  // the opening press went down before this menu existed, so anything it emits arrives with no
  // pointerdown seen since mount. One real pointerdown — a fresh tap, on an item or outside —
  // disarms the guard for good, so a fast right-click-then-click on desktop is never eaten (its
  // click is preceded by its own pointerdown) and dismissal is not delayed by a millisecond.
  const settled = useRef(false);
  useEffect(() => {
    const onDown = () => { settled.current = true; };
    const swallow = (e: Event) => {
      if (settled.current) return;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", swallow, true);
    window.addEventListener("contextmenu", swallow, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", swallow, true);
      window.removeEventListener("contextmenu", swallow, true);
    };
  }, []);

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
      <div className={`fx-menu-backdrop ${layer ? `layer-${layer}` : ""}`} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={(n) => {
          box.current = n;
          if (typeof innerRef === "function") innerRef(n);
          else if (innerRef) (innerRef as React.MutableRefObject<HTMLDivElement | null>).current = n;
        }}
        className={`fx-palette fx-preset-menu ${wide ? "fx-chain-menu" : ""} ${layer ? `layer-${layer}` : ""} ${pos?.flipped ? "flip-left" : ""}`}
        role="menu"
        // Hidden for the one frame between mount and measurement — an unplaced menu flashing at
        // the cursor before jumping is the same flicker this is meant to remove.
        style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: "hidden" }}
      >
        {/* ★ THE HEAD IS THE VERBS, NOT A CAPTION. "EQ PRESETS" over a list of EQ presets you
            opened by right-clicking EQ restates three things you already knew; "CHAIN 2" names the
            chip you just clicked, which is lit. So the title is optional and mostly absent — the
            glyph row is the head. It survives where it carries something you cannot see anywhere
            else (the flyout names the preset it is previewing). */}
        {(head || (acts && acts.length > 0)) && (
        <div className={`fx-preset-head ${head ? "" : "no-title"}`}>
          {head && <span className="fx-preset-title">{head}</span>}
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
        )}
        {chin == null ? children : <div className="fx-menu-body">{children}</div>}
        {chin != null && <div className="fx-menu-chin">{chin}</div>}
      </div>
    </>
  );
}

// ★ THE CHIN. A menu that scrolls carries EVERYTHING away, including the one row that is not part
// of the list — DEFAULT is the device's own reset state, not a preset, and it was stranded at the
// bottom of a 240px scroll behind twenty rows of bank. The way out of a list must not be inside it.
// So a menu with a chin stops being the scroller: the BODY scrolls and the chin is pinned under it,
// which is also why `chin` is a prop rather than one more child — a child cannot opt out of the box
// that clips it.


// THE SECOND WINDOW — the flyout that opens beside a menu row (effect presets on the add picker,
// a chain's contents on the chain menu). It was a bespoke box before: its own width, its own
// chrome, and — because it never said `flex-direction: column` — its own LAYOUT, which let the
// preset names flow inline and wrap into a ragged second column that looked like a bug because it
// was one. It is the menu panel now. Same chrome, same column, same scroll, and it takes the
// opening menu's measured width so the pair reads as one object rather than two guesses.
export function MenuFly({
  anchor,
  head,
  onEnter,
  onLeave,
  inert,
  layer,
  chin,
  children,
}: {
  /** The row that opened it, in viewport coordinates. */
  anchor: { left: number; right: number; top: number };

  head: React.ReactNode;
  onEnter?: () => void;
  onLeave?: () => void;
  /** ★ TRANSPARENT TO THE POINTER — set while a drag is running. The drop hit-test is
   *  elementFromPoint, which returns whatever is ON TOP, and this window flips to the LEFT of its
   *  menu whenever the right side has no room (a right-hand deck, always). It then sits directly
   *  over the list being dragged in, and every hit-test reads the flyout instead of the row
   *  underneath — the drag simply stops landing anywhere. Its own drag keeps working: that runs on
   *  window listeners, and insertion inside it is decided from snapshotted centres, not from
   *  what the pointer is over. */
  inert?: boolean;
  /** Stacking tier, same meaning as Menu's: 3 for a flyout opened from INSIDE another flyout. The
   *  first window sits at 41 and its flyout at 43, so a THIRD has to clear both. */
  layer?: 3 | 4;
  /** Pinned under the scroll — the same chin the first window has, for the same reason. */
  chin?: React.ReactNode;
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
  }, [anchor.left, anchor.right, anchor.top, children]);
  return (
    <div
      ref={box}
      className={`fx-palette fx-preset-menu fx-menu-fly ${layer ? `layer-${layer}` : ""} ${inert ? "inert" : ""}`}
      role="menu"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={
        // ★ IT SIZES TO ITS OWN CONTENT. It used to carry `minWidth: <the opening menu's measured
        // width>` so the pair "read as one object at two sizes" — but a window of three short chain
        // names forced to the width of a menu of long ones is not one object, it is one object and
        // a gap. `.fx-preset-menu`'s max-width still caps it, so a long name truncates exactly as
        // it did; what changes is that a short list stops paying for a long one.
        pos ? { left: pos.left, top: pos.top } : { left: anchor.right + 4, top: anchor.top, visibility: "hidden" }
      }
    >
      <div className="fx-preset-head">
        <span className="fx-preset-title">{head}</span>
      </div>
      {chin == null ? children : <div className="fx-menu-body">{children}</div>}
      {chin != null && <div className="fx-menu-chin">{chin}</div>}
    </div>
  );
}
