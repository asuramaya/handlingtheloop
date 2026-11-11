import { useEffect } from "react";

// ★ A STRIP OF BUTTONS TOO WIDE FOR ITS ROW GLIDES ACROSS IT (operator, 2026-11-10: the title bar's
// count + Cached / Stemmed + −/＋ "on the same line and if it overflows make it do what the song
// title does"). The song title's ticker moves the text with a transform; a strip of BUTTONS cannot,
// or what you see is not where you tap. So this moves the strip's own scroll position: to the end
// and back, pausing at each end, and holding still for a few seconds after any touch so a press
// lands where the finger meant it. Fits → nothing moves.
const SPEED = 40; // px per second
const END_PAUSE_MS = 1400;
const TOUCH_HOLD_MS = 4000;

export function useStripGlide(host: HTMLElement | null, selector: string, deps: readonly unknown[] = []): void {
  useEffect(() => {
    if (!host || typeof requestAnimationFrame === "undefined") return;
    let el: HTMLElement | null = null;
    let raf = 0;
    let dir = 1;
    let holdUntil = 0;
    let last = 0;
    const hold = () => {
      holdUntil = performance.now() + TOUCH_HOLD_MS;
    };
    const attach = () => {
      const next = host.querySelector<HTMLElement>(selector);
      if (next === el) return;
      el?.removeEventListener("pointerdown", hold);
      el?.removeEventListener("wheel", hold);
      el = next;
      el?.addEventListener("pointerdown", hold, { passive: true });
      el?.addEventListener("wheel", hold, { passive: true });
      if (el) el.scrollLeft = 0;
      dir = 1;
    };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      if (!el || now < holdUntil) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 2) {
        if (el.scrollLeft !== 0) el.scrollLeft = 0;
        return;
      }
      const next = el.scrollLeft + dir * SPEED * dt;
      if (next >= max) {
        el.scrollLeft = max;
        dir = -1;
        holdUntil = now + END_PAUSE_MS;
      } else if (next <= 0) {
        el.scrollLeft = 0;
        dir = 1;
        holdUntil = now + END_PAUSE_MS;
      } else el.scrollLeft = next;
    };
    attach();
    holdUntil = performance.now() + END_PAUSE_MS; // read the start first
    const mo = new MutationObserver(attach);
    mo.observe(host, { childList: true, subtree: true });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      el?.removeEventListener("pointerdown", hold);
      el?.removeEventListener("wheel", hold);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, selector, ...deps]);
}
