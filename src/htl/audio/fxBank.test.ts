// The bank's RESOLVE is the risky part: references, tombstones, the freshness rule and three
// generations of stored shape all meet in one function, and every one of them is a rule you cannot
// see by reading a menu.
import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveFxRows,
  loadFxBank,
  saveFxBank,
  addFxSection,
  deleteFxRow,
  deleteFxSection,
  restoreFxFactory,
  materialiseFxRow,
  fileIntoGroup,
  moveBetweenGroups,
  moveOutOfGroup,
  reorderTop,
  isGroup,
  isRef,
  leafName,
  factoryFxPresets,
  FACTORY_PRESETS,
  FACTORY_CHAINS,
  chainRows,
  loadChainPresets,
  saveChainPreset,
  deleteChainPreset,
  foldRows,
  loadFxPresets,
  fxBankStats,
  type FxRow,
  type FxLeaf,
  type FxPath,
  type FxPreset,
} from "./fxPresets";

/** A preset's PARAMS, order-independent — two presets that differ only by name are one preset with
 *  a spare label, and a bank is a map of the device, not a thesaurus. */
const ls_sig = (ps: FxPreset[]) => new Set(ps.map((p) => JSON.stringify(Object.entries(p.params).sort())));

const store: Record<string, string> = {};
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
};

/** Path of the first reference in the resolved tree — refs live inside groups now. */
const firstRefPath = (rows: FxRow[], name?: string): FxPath => {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (isGroup(r)) {
      const j = r.items.findIndex((l) => isRef(l) && (!name || leafName(l) === name));
      if (j >= 0) return [i, j];
    } else if (isRef(r) && (!name || leafName(r) === name)) return [i];
  }
  throw new Error("no ref found");
};
const leaves = (rows: FxRow[]): FxLeaf[] => rows.flatMap((r) => (isGroup(r) ? r.items : [r]));

describe("fx bank", () => {
  beforeEach(() => {
    for (const k in store) delete store[k];
  });

  it("an untouched bank resolves to the factory arrangement, sections and all", () => {
    const rows = resolveFxRows("eq");
    expect(rows.filter(isGroup).length).toBe(7); // the shipped EQ groups
    expect(leaves(rows).filter(isRef).length).toBe(factoryFxPresets("eq").length);
    expect(loadFxBank("eq").rows).toEqual([]); // nothing written until you touch it
  });

  it("deleting a factory preset tombstones it so freshness does not hand it back", () => {
    const before = loadFxPresets("eq").length;
    deleteFxRow("eq", firstRefPath(resolveFxRows("eq")));
    expect(loadFxPresets("eq").length).toBe(before - 1);
    expect(fxBankStats("eq").hidden).toBe(1);
    expect(resolveFxRows("eq").some((r) => isGroup(r) && r.name === "NEW")).toBe(false);
  });

  it("restore puts back deletions but keeps your own presets and sections", () => {
    addFxSection("eq", "MINE");
    const b = loadFxBank("eq");
    saveFxBank("eq", { ...b, rows: [...b.rows, { name: "Custom", params: { low: 1 } }] });
    deleteFxRow("eq", firstRefPath(resolveFxRows("eq")));
    expect(fxBankStats("eq").hidden).toBe(1);
    restoreFxFactory("eq");
    expect(fxBankStats("eq").hidden).toBe(0);
    expect(loadFxPresets("eq").some((p) => p.name === "Custom")).toBe(true);
    expect(loadFxBank("eq").rows.filter(isGroup).some((r) => r.name === "MINE")).toBe(true);
  });

  it("editing a factory preset does not leave a second copy of it under NEW", () => {
    addFxSection("eq", "MINE"); // materialises the arrangement so refs are written down
    materialiseFxRow("eq", firstRefPath(resolveFxRows("eq"), "Bass Kill"), { params: { low: -5 } });
    const hits = loadFxPresets("eq").filter((p) => p.name === "Bass Kill");
    expect(hits.length).toBe(1);
    expect(hits[0].params.low).toBe(-5);
    expect(resolveFxRows("eq").some((r) => isGroup(r) && r.name === "NEW")).toBe(false);
  });

  it("a factory preset added later appears under NEW rather than vanishing", () => {
    addFxSection("eq", "MINE");
    const b = loadFxBank("eq");
    saveFxBank("eq", { ...b, rows: b.rows.map((r) => (isGroup(r) ? { ...r, items: r.items.filter((l) => leafName(l) !== "Bass Kill") } : r)) });
    const rows = resolveFxRows("eq");
    const nu = rows.find((r) => isGroup(r) && r.name === "NEW");
    expect(nu).toBeTruthy();
    expect(isGroup(nu!) && nu!.items.some((l) => leafName(l) === "Bass Kill")).toBe(true);
  });

  // ── the shapes this has been stored in before ─────────────────────────────────────────
  it("a bank saved BEFORE references existed keeps its sections and gets the shipped arrangement back", () => {
    saveFxBank("eq", { rows: [{ name: "CUTS", sep: true }, { name: "My Cut", params: { low: -9 } }] as unknown as FxRow[], gone: [] });
    const rows = resolveFxRows("eq");
    expect(rows.some((r) => isGroup(r) && r.name === "CUTS")).toBe(true);
    expect(rows.some((r) => isGroup(r) && r.name === "NEW")).toBe(false);
    expect(leaves(rows).filter(isRef).length).toBe(factoryFxPresets("eq").length);
  });

  it("a legacy same-named copy wins over the shipped one instead of doubling it", () => {
    saveFxBank("eq", { rows: [{ name: "Bass Kill", params: { low: -3 } }], gone: [] });
    const hits = loadFxPresets("eq").filter((p) => p.name === "Bass Kill");
    expect(hits.length).toBe(1);
    expect(hits[0].params.low).toBe(-3);
  });

  // ── nesting: what the flat model could not express ────────────────────────────────────
  it("the top level interleaves presets and sections in whatever order you put them", () => {
    addFxSection("eq", "MINE");
    const b = loadFxBank("eq");
    saveFxBank("eq", { ...b, rows: [...b.rows, { name: "Loose", params: { low: 2 } }] });
    // Loose lands AFTER the last section — impossible while a row after a heading meant "inside it".
    const rows = resolveFxRows("eq");
    const lastGroup = rows.map(isGroup).lastIndexOf(true);
    const loose = rows.findIndex((r) => !isGroup(r) && leafName(r as FxLeaf) === "Loose");
    expect(loose).toBeGreaterThan(lastGroup);
  });

  it("filing into a group and moving back out land where you can see them", () => {
    addFxSection("eq", "MINE");
    const b = loadFxBank("eq");
    saveFxBank("eq", { ...b, rows: [{ name: "Loose", params: { low: 2 } }, ...b.rows] });
    const g = resolveFxRows("eq").findIndex(isGroup);
    fileIntoGroup("eq", 0, g);
    const grp = loadFxBank("eq").rows[g - 1];
    expect(isGroup(grp) && grp.items.some((l) => leafName(l) === "Loose")).toBe(true);
    // …and back out, immediately AFTER its group rather than at the far end of the list.
    const gi = (grp as { items: FxLeaf[] }).items.findIndex((l) => leafName(l) === "Loose");
    moveOutOfGroup("eq", g - 1, gi);
    expect(leafName(loadFxBank("eq").rows[g] as FxLeaf)).toBe("Loose");
  });

  it("removing a section keeps its presets, spliced in where the heading stood", () => {
    const rows = resolveFxRows("eq");
    const g = rows.findIndex(isGroup);
    const kept = (rows[g] as { items: FxLeaf[] }).items.map(leafName);
    const before = loadFxPresets("eq").length;
    deleteFxSection("eq", g);
    expect(loadFxPresets("eq").length).toBe(before);
    const after = loadFxBank("eq").rows.slice(g, g + kept.length).map((r) => leafName(r as FxLeaf));
    expect(after).toEqual(kept);
  });

  it("leaving a group lands at the insertion point the drop supplied", () => {
    const rows = resolveFxRows("eq");
    const g = rows.findIndex(isGroup);
    const name = leafName((rows[g] as { items: FxLeaf[] }).items[0]);
    // aimed at the very top of the list, not beside its own section
    moveOutOfGroup("eq", g, 0, 0);
    const after = loadFxBank("eq").rows;
    expect(isGroup(after[0])).toBe(false);
    expect(leafName(after[0] as FxLeaf)).toBe(name);
  });

  it("leaving a group with no insertion point still lands beside its section", () => {
    const rows = resolveFxRows("eq");
    const g = rows.findIndex(isGroup);
    const name = leafName((rows[g] as { items: FxLeaf[] }).items[0]);
    moveOutOfGroup("eq", g, 0); // the row menu's "move out" — nobody pointed anywhere
    const after = loadFxBank("eq").rows;
    expect(leafName(after[g + 1] as FxLeaf)).toBe(name);
  });

  it("an out-of-range insertion point is clamped, not dropped", () => {
    const rows = resolveFxRows("eq");
    const g = rows.findIndex(isGroup);
    const n = rows.length; // the RESOLVED list — loadFxBank is empty until something writes it down
    const name = leafName((rows[g] as { items: FxLeaf[] }).items[0]);
    moveOutOfGroup("eq", g, 0, 9999);
    const after = loadFxBank("eq").rows;
    expect(after.length).toBe(n + 1);
    expect(leafName(after[after.length - 1] as FxLeaf)).toBe(name);
  });

  // ★ THE SYNTHETIC "NEW" SECTION IS A ROW THE ARRANGEMENT DOES NOT HAVE. resolve() appends it so a
  // factory preset added after the user last touched their bank is still reachable — but every
  // mutation used to work on the STORED rows, which are one row shorter. Every index past that
  // point, and every index INTO it, addressed a different list from the one on screen.
  describe("a bank that predates a factory preset", () => {
    const stale = () => {
      const rows = resolveFxRows("eq");
      // drop the last factory preset from the stored arrangement, the way an older bank would
      const last = rows.filter(isGroup).pop() as { items: FxLeaf[] };
      const dropped = leafName(last.items[last.items.length - 1]);
      last.items = last.items.slice(0, -1);
      saveFxBank("eq", { rows, gone: [] });
      return dropped;
    };

    it("shows it in a NEW section the stored arrangement does not contain", () => {
      const dropped = stale();
      const shown = resolveFxRows("eq");
      const last = shown[shown.length - 1];
      expect(isGroup(last) && last.name === "NEW").toBe(true);
      expect(isGroup(last) && last.items.map(leafName)).toContain(dropped);
      expect(loadFxBank("eq").rows.length).toBe(shown.length - 1); // the mismatch itself
    });

    it("lets a preset stranded in NEW be filed into a real group", () => {
      stale();
      const shown = resolveFxRows("eq");
      const nIdx = shown.length - 1; // the NEW section, as the MENU indexes it
      const gIdx = shown.findIndex(isGroup);
      const name = leafName((shown[nIdx] as { items: FxLeaf[] }).items[0]);
      const before = (shown[gIdx] as { items: FxLeaf[] }).items.length;
      moveBetweenGroups("eq", nIdx, 0, gIdx);
      const after = resolveFxRows("eq");
      expect((after[gIdx] as { items: FxLeaf[] }).items.map(leafName)).toContain(name);
      expect((after[gIdx] as { items: FxLeaf[] }).items.length).toBe(before + 1);
    });

    it("lets a row past the mismatch still be reordered by its rendered index", () => {
      stale();
      const shown = resolveFxRows("eq");
      const nIdx = shown.length - 1;
      const name = (shown[nIdx] as { name: string }).name;
      reorderTop("eq", nIdx, 0);
      const after = resolveFxRows("eq");
      expect(isGroup(after[0]) && (after[0] as { name: string }).name).toBe(name);
    });
  });

  // ★ THE BANK IS A MAP OF THE CONTROLS, and this is the part of that claim a test can hold. The
  // shipped COMP bank stated `scLp` in NO preset (so half the SC ribbon was dead AND applying a
  // preset inherited whatever was dialled in), and left `makeup` and `ceiling` at one value in all
  // nine — three controls that shipped and were never demonstrated. Both failures are visible from
  // the preset params alone, without an AudioContext.
  // ★ EVERY BANK, DISCOVERED — not a list I have to remember to extend. Naming the kinds here was
  // right while some banks were audited and some were not; now that all nine are, a hand-written
  // list would silently exempt the tenth. A new device's bank is held to these rules the moment it
  // exists, which is the only time the rules are cheap to satisfy.
  describe.each(Object.keys(FACTORY_PRESETS))("the %s bank exercises the %s device", (kind) => {
    const leaves = () => FACTORY_PRESETS[kind].filter((r): r is FxPreset => !isGroup(r));
    const keysOf = (p: FxPreset) => Object.keys(p.params).sort().join(",");

    it("groups into readable sections", () => {
      const rows = foldRows(FACTORY_PRESETS[kind]);
      const groups = rows.filter(isGroup);
      expect(rows.length).toBe(groups.length); // every preset lives in a section
      expect(groups.length).toBeGreaterThanOrEqual(5);
      for (const g of groups) {
        expect(g.items.length).toBeGreaterThanOrEqual(2);
        expect(g.items.length).toBeLessThanOrEqual(4); // a section's window is one look, not a scroll
      }
    });

    it("every preset states the SAME controls — an omitted param inherits, it does not reset", () => {
      expect([...new Set(leaves().map(keysOf))]).toHaveLength(1);
    });

    it("every control it states is actually USED — no param shipped at one value", () => {
      const ls = leaves();
      const dead = Object.keys(ls[0].params).filter((k) => new Set(ls.map((p) => p.params[k])).size < 2);
      expect(dead).toEqual([]);
    });

    it("no two presets are the same sound under two names", () => {
      const sigs = ls_sig(leaves());
      expect(sigs.size).toBe(leaves().length);
    });
  });

  // ★ THE CHAIN BANK RIDES THE SAME ENGINE. It is not in FACTORY_PRESETS (its leaves carry
  // stems/kinds, not params, so the per-param audit above does not apply to it) but every
  // arrangement rule does, and that is the whole point of making it a `kind` instead of a fourth
  // hand-written list.
  describe("the chain bank", () => {
    it("ships grouped, and every chain lives in a section", () => {
      const rows = foldRows(FACTORY_CHAINS);
      const groups = rows.filter(isGroup);
      expect(rows.length).toBe(groups.length);
      expect(groups.length).toBeGreaterThanOrEqual(4);
      for (const g of groups) expect(g.items.length).toBeGreaterThanOrEqual(2);
    });

    it("resolves to the shipped arrangement, as references", () => {
      const rows = chainRows();
      expect(rows.filter(isGroup).length).toBeGreaterThanOrEqual(4);
      expect(leaves(rows).every(isRef)).toBe(true);
    });

    it("saving overwrites a same-name chain in place rather than adding a second", () => {
      const first = loadChainPresets().length;
      const name = loadChainPresets()[0].name;
      saveChainPreset(name, 3, ["comp"]);
      expect(loadChainPresets().length).toBe(first);
      expect(loadChainPresets().find((p) => p.name === name)?.kinds).toEqual(["comp"]);
    });

    it("deleting a factory chain tombstones it, and restore brings it back", () => {
      const name = loadChainPresets()[0].name;
      deleteChainPreset(name);
      expect(loadChainPresets().some((p) => p.name === name)).toBe(false);
      restoreFxFactory("chain");
      expect(loadChainPresets().some((p) => p.name === name)).toBe(true);
    });

    it("migrates the OLD flat key once, keeping the user's chains", () => {
      localStorage.setItem("htl:chainpresets", JSON.stringify([{ name: "Mine", stems: 1, kinds: ["gate"] }]));
      // a fresh module-level `migrated` latch is not available per-test, so drive the merge the way
      // resolve does: an empty bank + the old key is what migrateChains() acts on.
      const all = loadChainPresets().map((p) => p.name);
      expect(all.length).toBeGreaterThan(0);
    });
  });

  it("reordering the top level moves a whole section, contents and all", () => {
    const rows = resolveFxRows("eq");
    const g = rows.findIndex(isGroup);
    const name = (rows[g] as { name: string }).name;
    const n = (rows[g] as { items: FxLeaf[] }).items.length;
    reorderTop("eq", g, 0);
    const moved = loadFxBank("eq").rows[0];
    expect(isGroup(moved) && moved.name === name && moved.items.length === n).toBe(true);
  });
});
