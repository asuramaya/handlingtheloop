// ★ MENU AIM — the "Amazon mega dropdown" rule (Ben Kamens, 2013; operator, 2026-11-06: "the amazon
// mega drop down fix needs to be implemented"). A row that opens a flyout opens it on HOVER, so the
// diagonal path from a row to its open flyout crosses the rows below it, and each one stole the
// flyout on the way past: you could only reach a flyout by moving sideways first, then down.
//
// The fix is geometric, not a timer on every row. While the pointer is moving INSIDE the triangle
// from where it was a moment ago to the near edge of the open flyout, it is heading for that flyout,
// so entering another row is deferred. The moment it stops (or leaves the triangle) the row it is
// over takes the flyout as usual. Hovering straight down a list never enters the triangle, so it
// stays instant.

type P = { x: number; y: number };
const trail: P[] = [];
let lastMove = 0;
let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener(
    "mousemove",
    (e) => {
      trail.push({ x: e.clientX, y: e.clientY });
      if (trail.length > 4) trail.shift();
      lastMove = performance.now();
    },
    { passive: true, capture: true },
  );
}

/** The flyout this row's menu currently has open: the next `.fx-menu-fly` after the menu in
 *  document order. (Not by z-index: a flyout and its menu can resolve to the same z, and the later
 *  one simply paints on top; the render order — menu, its flyout, that flyout's flyout — is the
 *  real nesting.) */
function childFly(menu: Element): DOMRect | null {
  for (const f of document.querySelectorAll(".fx-menu-fly")) {
    if (f === menu) continue;
    if (menu.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) return f.getBoundingClientRect();
  }
  return null;
}

const sign = (a: P, b: P, c: P) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y);
/** Is `p` inside triangle a-b-c (edges included)? */
export function inTriangle(p: P, a: P, b: P, c: P): boolean {
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** Is the pointer, now over `row`, travelling toward its menu's open flyout? */
function aiming(row: HTMLElement): boolean {
  const menuEl = row.closest(".fx-preset-menu");
  if (!menuEl || trail.length < 2) return false;
  const fly = childFly(menuEl);
  if (!fly) return false;
  const menu = menuEl.getBoundingClientRect();
  const toRight = fly.left >= menu.left + menu.width / 2;
  const edge = toRight ? fly.left : fly.right;
  const SLACK = 6; // a few px past the flyout's corners, so a path grazing its top or bottom still counts
  return inTriangle(trail[trail.length - 1], trail[0], { x: edge, y: fly.top - SLACK }, { x: edge, y: fly.bottom + SLACK });
}

let pending: ReturnType<typeof setTimeout> | null = null;
const STEP_MS = 90; // re-check cadence while the pointer is still travelling
const MAX_MS = 450; // never hold a row hostage longer than this

/** Call from a flyout row's onMouseEnter in place of opening its flyout directly. Opens at once,
 *  unless the pointer is on its way to the flyout that is already open; then it waits until the
 *  pointer stops or turns away, and opens only if the pointer is still over this row. */
export function aimEnter(row: HTMLElement, open: () => void): void {
  install();
  if (pending) clearTimeout(pending);
  pending = null;
  if (!aiming(row)) {
    open();
    return;
  }
  const t0 = performance.now();
  const tick = () => {
    pending = null;
    if (!row.isConnected || !row.matches(":hover")) return; // it reached the flyout, or moved on
    const now = performance.now();
    if (now - t0 < MAX_MS && now - lastMove < STEP_MS && aiming(row)) {
      pending = setTimeout(tick, STEP_MS);
      return;
    }
    open();
  };
  pending = setTimeout(tick, STEP_MS);
}
