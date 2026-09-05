import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ★ WHY A STYLESHEET HAS A TEST.
//
// The phone board's vertical split is a LOAD-BEARING INVARIANT, not a style choice: the audio
// viewport must not resize when a deck changes its own controls. It broke because the rule
// expressing it was written in a form that only held while the control stack's height happened
// to stay put — `.decks-third { flex: 0 1 auto }`, i.e. "as tall as my content". Turning a deck
// to its FX page hides eight rows at once, so the content height moved, so the waveform moved.
//
// Nothing could have caught that: it is CSS, it rendered, and it looked correct in the one state
// anybody screenshotted. What CAN be caught is the SHAPE of the rule — a content-derived basis
// on either term of the split is the bug, whatever else changes around it. So this reads the
// real stylesheet and asserts the shape.

// Comments are stripped FIRST. Without this, `declarationsFor` returns null for any rule that
// follows a comment block — which in this file is every rule that matters, since each of them
// carries the explanation of why it exists. That produced three green-looking nulls on the first
// run; the "parser actually works" cases below exist because of it.
const css = (f: string) =>
  readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Pull the body of the top-level `@media (max-width: 768px)` blocks — the phone rules. */
function phoneBlocks(source: string): string {
  const out: string[] = [];
  const lines = source.split("\n");
  let depth = 0;
  let start: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (depth === 0 && /^\s*@media\b/.test(l) && /max-width:\s*768px/.test(l)) start = i;
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0);
    if (start !== null && depth === 0 && i > start) {
      out.push(lines.slice(start, i + 1).join("\n"));
      start = null;
    }
  }
  return out.join("\n");
}

/** The declarations of the LAST rule matching `selector` inside `block` (last wins in CSS). */
function declarationsFor(block: string, selector: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[,{}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`, "g");
  let last: string | null = null;
  for (const m of block.matchAll(re)) last = m[1];
  return last;
}

/** The flex-basis a shorthand resolves to: `flex: <grow> <shrink> <basis>`. */
function flexBasis(decls: string): string | null {
  const m = decls.match(/(?:^|[;\s])flex:\s*([^;]+);/);
  if (!m) return null;
  const parts = m[1].trim().split(/\s+(?![^(]*\))/);
  return parts.length >= 3 ? parts.slice(2).join(" ") : parts.length === 1 ? "0%" : null;
}

const BOARD = phoneBlocks(css("board.css"));
const FX = phoneBlocks(css("fx.css"));

describe("the phone board's vertical split never depends on control-stack content", () => {
  it("gives the waveform flank a FIXED basis, not a share of the leftovers", () => {
    const d = declarationsFor(BOARD, ".stage .lanes-flank");
    expect(d, ".stage .lanes-flank has no phone rule at all").not.toBeNull();
    const basis = flexBasis(d!);
    expect(basis).toBe("min(290px, 34vh)");
  });

  it("gives the control third the REMAINDER, never its own content height", () => {
    const d = declarationsFor(BOARD, ".stage .decks-third");
    expect(d).not.toBeNull();
    // ★ THE CASE THAT PROVES THE BUG. `flex: 0 1 auto` — the value this shipped with — is a
    // content-derived basis, and it is precisely what let eight hidden rows move the waveform.
    // A test written against the old code would have to assert `auto` here, and that assertion
    // IS the defect.
    expect(flexBasis(d!)).not.toBe("auto");
    expect(flexBasis(d!)).toBe("0");
  });

  it("does not let .lanes fight the flank for the height — the flank owns it", () => {
    // .lanes lives inside .lanes-flank, a ROW. Its flex governs WIDTH there, so a min-height on
    // it would be a second, competing owner of the vertical size (and was, silently, once the
    // SongOverview rails wrapped it).
    const d = declarationsFor(BOARD, ".stage .lanes");
    expect(d).not.toBeNull();
    expect(d!).toMatch(/min-height:\s*0\s*;/);
  });
});

describe("the FX strip stays under the thumb when you open an effect", () => {
  it("pins the strip to the bottom of the bank on both pages", () => {
    const d = declarationsFor(FX, ".decks-row .bank-main > .eq-row");
    expect(d, "the phone eq-row rule is gone").not.toBeNull();
    // Without this the strip lands wherever the stack ends — which is a different place on the
    // MIX page (eight rows above it) than on the FX page (those rows display:none).
    expect(d!).toMatch(/margin-top:\s*auto\s*;/);
  });

  it("opens the effect panel ABOVE the bar, so the bar itself never moves", () => {
    const d = declarationsFor(FX, ".fx-strip > .fx-rack-bar");
    expect(d, "the rack bar is not re-ordered on a phone").not.toBeNull();
    expect(d!).toMatch(/order:\s*1\s*;/);
  });
});

describe("the parser these assertions rest on actually works", () => {
  // A test whose helper silently matches nothing passes for the wrong reason. These pin the
  // helpers against known-good and known-bad input so a false green is not available.
  it("reads a basis out of each flex shorthand form", () => {
    expect(flexBasis("flex: 0 0 min(290px, 34vh);")).toBe("min(290px, 34vh)");
    expect(flexBasis("flex: 0 1 auto;")).toBe("auto");
    expect(flexBasis("flex: 1 1 0;")).toBe("0");
    expect(flexBasis("color: red;")).toBeNull();
  });

  it("finds phone blocks and nothing else", () => {
    expect(BOARD).toContain("@media (max-width: 768px)");
    expect(BOARD.length).toBeGreaterThan(0);
    expect(phoneBlocks("@media (min-width: 769px) {\n .a { flex: 0 1 auto; }\n}")).toBe("");
    // A rule preceded by a comment must still be found — the exact case that broke first.
    expect(declarationsFor("/* why */\n.a { order: 1; }", ".a")).toMatch(/order:\s*1/);
    expect(declarationsFor(BOARD, ".selector-that-does-not-exist")).toBeNull();
  });
});
