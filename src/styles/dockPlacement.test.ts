import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ★ WHY A STYLESHEET HAS A TEST — the same reason as phoneBoardLayout.test.ts next door, but a
// sharper case. A dock that renders slightly wrong is a style bug. A dock that puts its ONLY
// affordance permanently out of reach, and remembers having done so, is a trap: the value lives
// in localStorage, so it survives every reload, and the sole escape is clearing site data.
//
// dock-bottom is pinned to the viewport's bottom edge, so its top edge — where the drag handle
// sits — is at `viewportHeight - height`. --dock-h-max is 820px of PLAIN px (it has to be:
// DockResizer reads these vars back as literal text, so a vh unit would parse as a bare number),
// which means any window shorter than the remembered height sends that edge negative. A laptop
// at 125% scale is about 760px of viewport. Well within reach.
//
// The side docks already guard this — both cap at `calc(100vw - 160px)`. The bottom one did not,
// and nothing in the codebase noticed, because it renders fine at every height the people
// writing it happened to have.

const css = (f: string) =>
  readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the LAST rule matching `selector` (last wins in CSS). */
function declarationsFor(source: string, selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[,{}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, "g");
  let last: string | null = null;
  for (const m of source.matchAll(re)) last = m[1];
  return last;
}

const BOARD = css("board.css");

describe("every edge dock is capped against the viewport it is pinned to", () => {
  // The parser earns its keep first — a null here would make every assertion below vacuous.
  it("finds the rules at all", () => {
    expect(declarationsFor(BOARD, ".modal-backdrop.dock-bottom")).not.toBeNull();
    expect(declarationsFor(BOARD, ".modal-backdrop.dock-left")).not.toBeNull();
    expect(declarationsFor(BOARD, ".modal-backdrop.dock-right")).not.toBeNull();
  });

  it("caps the side docks' WIDTH so a remembered size cannot swallow the screen", () => {
    for (const sel of [".modal-backdrop.dock-left", ".modal-backdrop.dock-right"]) {
      const d = declarationsFor(BOARD, sel)!;
      expect(d, `${sel} lost its viewport width guard`).toMatch(/max-width:\s*min\([\s\S]*?calc\(100vw/);
    }
  });

  // ★ THE REGRESSION. Without this the handle leaves the screen and never comes back.
  it("caps the bottom dock's HEIGHT, so its drag handle can never leave the viewport", () => {
    const d = declarationsFor(BOARD, ".modal-backdrop.dock-bottom")!;
    expect(d, "dock-bottom has no max-height — its handle can be dragged off-screen").toMatch(/max-height:/);
    // dvh, not vh: a collapsing mobile URL bar must not strand the handle either.
    expect(d).toMatch(/max-height:\s*calc\(100dvh/);
    // …and it must leave room for the chin, which is fixed at z-index 5000 over everything. A
    // handle underneath the chin is exactly as unreachable as one off-screen.
    expect(d).toMatch(/--chin-h/);
  });

  it("still sizes the bottom dock from the remembered var, between its own bounds", () => {
    const d = declarationsFor(BOARD, ".modal-backdrop.dock-bottom")!;
    expect(d).toMatch(/height:\s*clamp\(\s*var\(--dock-h-min\)/);
    expect(d).toMatch(/var\(--dock-h-bottom/);
    expect(d).toMatch(/var\(--dock-h-max\)/);
    expect(d).toMatch(/inset:\s*auto 0 0 0/); // pinned to the bottom — the reason the cap matters
  });

  // The ceiling is enforced in ONE place. Restating the viewport figure in the drag handler is
  // how the guard would quietly come back: two places deciding one thing, disagreeing later.
  it("does not duplicate the viewport cap in the resize handler", () => {
    const ts = readFileSync(
      fileURLToPath(new URL("../components/DockResizer.tsx", import.meta.url)),
      "utf8",
    ).replace(/\/\/[^\n]*/g, "");
    expect(ts).not.toMatch(/innerHeight/);
    expect(ts).not.toMatch(/100dvh|100vh/);
  });
});
