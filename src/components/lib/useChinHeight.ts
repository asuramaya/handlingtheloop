import { useEffect } from "react";

/**
 * Publish the chin's MEASURED height as `--chin-h` on <html>.
 *
 * ★ WHY THIS IS MEASURED AND NOT A CONSTANT. The phone sheet has to start exactly below the
 * chin, and the stylesheet used to say `inset: 36px 0 0 0` with a comment claiming "the 36px
 * chin height is stable across phone widths". It is not a height at all: `.chin` is
 * `flex: 0 0 auto` with content-sized buttons, so it is however tall its own label, icon, font
 * size and the device's top safe-area inset make it. Measured on this machine at a desktop
 * width it is 40.8px, so the sheet's first 4.8px were sitting UNDER the chin — the panel's own
 * header, clipped, for exactly the reason the overview rail's top glyph was clipped: a magic
 * number that does not range over what it claims to.
 *
 * A CSS variable cannot be derived from an element's rendered height, so this is the one
 * honest place to put it: measure the real element, publish the number, let every rule read it.
 * ResizeObserver rather than a one-shot read, because the thing that makes it vary — font
 * scaling, an orientation change moving the safe-area inset, the labels wrapping — all happen
 * after first paint.
 */
export function useChinHeight(el: HTMLElement | null) {
  useEffect(() => {
    if (!el) return;
    const publish = () => {
      const h = el.getBoundingClientRect().height;
      // Guard the zero case: a display:none or not-yet-laid-out chin would otherwise publish
      // 0px and let a sheet slide up under a chin that is about to exist.
      if (h > 0) document.documentElement.style.setProperty("--chin-h", `${h}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
}
