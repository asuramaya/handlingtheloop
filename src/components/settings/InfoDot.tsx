import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** ONE place for "what does this do?", so the panel can be read at a glance.
 *
 *  The colour tab used to explain itself three different ways at once: a paragraph under every
 *  section heading, a "· like this" clause inside every control's label, and a `title=` attribute
 *  repeating one of the two. Nothing was WRONG, but the settings you actually came to change were
 *  a minority of the pixels, and a wall of muted grey reads as unfinished however carefully it is
 *  written. The text is worth keeping — it is just not worth showing until it is asked for.
 *
 *  Hover opens it on a mouse; a tap opens it on touch (where hover does not exist); Escape and an
 *  outside press close it. The opening press cannot close it, because the listener is attached in
 *  an effect — i.e. after that pointerdown has already been and gone. */
export function InfoDot({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  // dx = horizontal shift; above = flipped to open upward; cap = a max-height when even the
  // flipped side can't fit the whole bubble (it scrolls rather than being cut off).
  // dx = horizontal shift; above = flipped upward; cap = max-height when neither side fits
  // whole; mw = max-width, because the bubble must never be WIDER than the box it is clamped
  // into (a shift cannot contain something that does not fit).
  const [place, setPlace] = useState<{ dx: number; above: boolean; cap: number; mw: number }>({ dx: 0, above: false, cap: 0, mw: 0 });
  const wrap = useRef<HTMLSpanElement | null>(null);
  const pop = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // ★ THE BUBBLE HAS TO SURVIVE BOTH AXES AND ITS OWN SCROLL CONTAINER.
  //
  //  X — CLAMP TO THE PANEL, NOT THE VIEWPORT. An early attempt flipped sides when the dot sat
  //  past 55% of the WINDOW, which is the wrong box: the settings panel is a narrow column
  //  inside a much wider window, so a dot near the panel's right edge is nowhere near the
  //  window's and the bubble hung outside its own panel. Shift by exactly the overflow instead —
  //  no guesswork about which side has room, and it lands against the edge rather than flipped
  //  away from the control it describes.
  //
  //  Y — FLIP, because a shift cannot help here. The bubble always opened DOWNWARD, so a dot in
  //  the lower half of a long tab opened straight into (and past) the bottom of the scrolling
  //  body and vanished. Down is still preferred; it only flips up when down does not fit and up
  //  does, and if NEITHER fits it takes the roomier side with a max-height and scrolls.
  //
  //  THE BOX is the scroll container intersected WITH THE VIEWPORT. Those are different limits
  //  and both can cut: `.settings-body` clips its own overflow, and on a phone the panel is a
  //  centred modal that can sit near a screen edge. Clamping to either one alone leaves the
  //  other free to swallow the bubble.
  useLayoutEffect(() => {
    if (!open || !pop.current) return;
    const el = pop.current;
    // Measure UNTRANSFORMED. Reading the rect while a previous shift is still applied measures
    // the shifted box and double-counts it — which is exactly what happened on REOPEN, since the
    // bubble unmounts on close and comes back carrying the last placement in state. Clearing it
    // via setState would not help: the DOM still holds the old transform when this effect runs.
    el.style.transform = "none";
    el.style.maxHeight = "";
    el.style.maxWidth = "";
    const box = (wrap.current?.closest(".color-tab, .settings-body, .settings-panel") as HTMLElement | null)
      ?? document.documentElement;
    const b = box.getBoundingClientRect();
    const M = 8;
    const left = Math.max(b.left, 0) + M;
    const right = Math.min(b.right, window.innerWidth) - M;
    const top = Math.max(b.top, 0) + M;
    const bottom = Math.min(b.bottom, window.innerHeight) - M;

    // ★ FIT BEFORE YOU SHIFT. The CSS `max-width: min(300px, 74vw)` is bounded by the VIEWPORT,
    // which is the wrong box for the same reason the old flip-at-55%-of-window was: the panel is
    // a narrow column inside a much wider window. A 300px bubble in a ~294px panel column cannot
    // be contained by ANY offset — shifting it off the right edge just pushes it off the left,
    // which is exactly what the clipped-first-characters screenshot shows. So cap the width to
    // the box first, then shift what is left over.
    //
    // The cap is a CEILING ON TOP OF the CSS one, never a replacement for it. Writing the box
    // width straight into `style.maxWidth` overrides `min(300px, 74vw)` outright, and on a wide
    // dock that let a bubble lay out to ~496px — a readable-line-length rule silently deleted by
    // a containment fix. So: measure at the CSS width first, and only intervene if it does not
    // fit. When it does, no inline width is set at all and the stylesheet stays in charge.
    const boxW = Math.max(140, right - left);
    let mw = 0;
    if (el.getBoundingClientRect().width > boxW) {
      mw = boxW;
      el.style.maxWidth = `${mw}px`;
    }

    const r = el.getBoundingClientRect();
    let dx = 0;
    if (r.right > right) dx = right - r.right;
    // Not `else if`: a bubble shifted left to clear the right edge can land past the LEFT one,
    // and a single either/or pass would never look. With the width capped this is a safety net
    // rather than the common case, which is the point — it should be unreachable, not absent.
    if (r.left + dx < left) dx = left - r.left;

    // Room is measured from the DOT, not from the bubble's current box: the same GAP sits
    // between dot and bubble on whichever side it opens, so both placements are described by
    // the anchor plus that gap. Deriving "above" from the downward rect instead would fold the
    // downward position into the answer and give a different result for the same geometry.
    const a = wrap.current?.getBoundingClientRect() ?? r;
    const GAP = 7;
    const roomBelow = bottom - (a.bottom + GAP);
    const roomAbove = a.top - GAP - top;
    const needs = r.height;
    let above = false;
    let cap = 0;
    if (needs > roomBelow) {
      if (needs <= roomAbove) above = true; // it fits up there whole — flip, no cap
      else if (roomAbove > roomBelow) { above = true; cap = roomAbove; } // neither fits; take the roomier side
      else cap = roomBelow;
    }
    if (cap) cap = Math.max(64, cap); // a bubble too short to show a line is worse than one that scrolls
    // Apply the shift IMPERATIVELY as well as through state. Clearing it here and leaving the
    // re-render to restore it loses it whenever `dx` is unchanged from the last open: React
    // diffs the style prop key by key, sees the same `translateX(...)` string, and writes
    // nothing — while the DOM is sitting on the `none` this effect just set to measure with.
    // The bubble then hangs outside the panel on every reopen but the first. Caught only by
    // running the containment probe TWICE; a single pass reports it clean.
    el.style.transform = `translateX(${dx}px)`;
    setPlace({ dx, above, cap, mw });
  }, [open, text]);

  const show = () => setOpen(true);

  return (
    <span
      className="info-wrap"
      ref={wrap}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") show();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setOpen(false);
      }}
    >
      <button
        type="button"
        className={`info-dot ${open ? "on" : ""}`}
        aria-label={label ? `About ${label}` : "What this does"}
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
      >
        i
      </button>
      {open && (
        <span
          className={`info-pop ${place.above ? "above" : ""}`}
          role="tooltip"
          ref={pop}
          style={{
            transform: `translateX(${place.dx}px)`,
            ...(place.mw ? { maxWidth: `${Math.round(place.mw)}px` } : null),
            ...(place.cap ? { maxHeight: `${Math.round(place.cap)}px`, overflowY: "auto" as const } : null),
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
