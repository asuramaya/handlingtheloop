import type { DockMode, PanelKey } from "./settings";

// PANEL PLACEMENT — the ONE answer to "how is this panel showing right now".
//
// ★ WHY THIS MODULE EXISTS. The placement question used to be answered TWICE, independently,
// and the two answers disagreed:
//   • JS asked `window.matchMedia("(max-width: 768px)")` to decide EXCLUSIVITY (does opening
//     this panel close the others?).
//   • CSS asked its own `@media (max-width: 768px)` to decide LOOKS — and only ever wrote
//     rules for `.dock-left` and `.dock-right`.
// So a panel configured "center" or "bottom" got phone exclusivity from the JS half and the
// generic floating-card look from the CSS half: a small window with 16px of padding, dimmed by
// `--panel-dim`, floating over a board you cannot reach. With the dim turned down to 0 — which
// is a perfectly reasonable desktop taste, and is what this repo's own operator has saved — it
// is a card hovering over a live mixer on a 390px screen. That is the reported bug, and it was
// not one panel misbehaving: three of the four defaults are "center".
//
// The fix is not a fifth media query. It is to stop asking twice. A phone resolves to `sheet`
// HERE, in JS, once; the class goes on the element; and the stylesheet's `.dock-sheet` rule
// carries no media query at all, so it cannot disagree about when it applies.
//
// ★ AND WHY "sheet" IS A PLACEMENT, NOT A FLAG. It is tempting to keep four modes and pass a
// separate `phone` boolean everywhere. But every consumer — the class name, the z-index, the
// resize handles, the exclusivity rule — has to branch on it, and each branch is a place the
// two can drift apart again. A fifth member of the union makes the compiler walk every switch
// for us.

/** A panel's placement AS RENDERED. The four `DockMode`s are what the user configures for a
 *  desktop; `sheet` is the phone's single slot and is never configurable — it is what a small
 *  screen resolves every configuration to. */
export type PanelPlacement = DockMode | "sheet";

/**
 * ★ THE PHONE HAS ONE SLOT, so a phone has one placement.
 *
 * `onePanel` is deliberately a parameter rather than a media query read inside this function:
 * it keeps the module pure and testable, and it means the app reads the device ONCE (see
 * useOnePanel) instead of at each of the dozen call sites that used to re-run matchMedia.
 */
export function placementFor(configured: DockMode, onePanel: boolean): PanelPlacement {
  return onePanel ? "sheet" : configured;
}

export function placementsFor(
  docks: Record<PanelKey, DockMode>,
  onePanel: boolean,
): Record<PanelKey, PanelPlacement> {
  return {
    library: placementFor(docks.library, onePanel),
    settings: placementFor(docks.settings, onePanel),
    people: placementFor(docks.people, onePanel),
    session: placementFor(docks.session, onePanel),
  };
}

/**
 * ★ ONE EXCLUSIVITY RULE, replacing four hand-written lists.
 *
 * App.tsx used to spell out "when opening People, close Session and Settings and Library" at
 * each of four launchers, each list written separately and each one a place to forget the
 * panel added last. (One of them, `closeRightDock`, still closed a "discover" dock that had
 * stopped existing.) The rule is small enough to state once:
 *
 *   sheet   → close EVERY other panel. There is one slot; occupying it evicts.
 *   center  → close every other panel that is ALSO center. Two full-viewport modals with a dim
 *             each would just be dim-over-dim with one hiding the other.
 *   edge    → close nothing. Left/right/bottom are pinned, non-overlapping real estate, and
 *             even when two share an edge that is supported stacking (panelOrder decides who
 *             is on top), not a collision.
 */
export function panelsToClose(
  opening: PanelKey,
  placements: Record<PanelKey, PanelPlacement>,
): PanelKey[] {
  const mine = placements[opening];
  if (mine !== "sheet" && mine !== "center") return [];
  const others = (Object.keys(placements) as PanelKey[]).filter((k) => k !== opening);
  return mine === "sheet" ? others : others.filter((k) => placements[k] === "center");
}

/** Only a desktop placement can be dragged. A sheet fills its screen, so there is no edge to
 *  pull and nothing a size would mean. */
export function isResizable(p: PanelPlacement): boolean {
  return p !== "sheet";
}

/** A sheet dims nothing: it is opaque, full-bleed, and the only thing on screen. Returning 0
 *  rather than letting `--panel-dim` through is the difference between "the board is behind
 *  this, faintly" and "this IS the screen", and only the second one is true on a phone. */
export function placementDim(p: PanelPlacement, configuredDim: number): number {
  return p === "sheet" ? 0 : configuredDim;
}

// STACKING. Base 40 matches the z-index the desktop dock CSS used before any of this existed,
// so an unranked key (a panel nobody has added to `panelOrder` yet) still renders above the
// board.
const EDGE_Z_BASE = 40;

export function edgeZIndex(key: PanelKey, order: readonly PanelKey[]): number {
  const idx = order.indexOf(key);
  const rank = idx === -1 ? order.length : idx; // not in the list → lowest priority
  return EDGE_Z_BASE + (order.length - rank);
}

/**
 * A sheet needs no ranking — it is the only panel open, by construction (see panelsToClose), so
 * asking `panelOrder` who wins would be answering a question nobody asked. It takes the base
 * modal z-index and stops.
 *
 * `centerZ` is the most-recently-opened counter from useCenterZIndex, threaded in rather than
 * read here so this stays pure.
 */
export const SHEET_Z = 50;
export function panelZIndex(
  p: PanelPlacement,
  key: PanelKey,
  order: readonly PanelKey[],
  centerZ: number | undefined,
): number | undefined {
  if (p === "sheet") return SHEET_Z;
  if (p === "center") return centerZ;
  return edgeZIndex(key, order);
}
