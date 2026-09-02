// Per-effect user presets, stored client-side (localStorage), keyed by effect kind so a
// preset is shared across both decks. Minimal by design: a built-in "Default" (the device's
// reset state, not stored here) plus user-saved snapshots of the current param set. The
// menu that drives this lives in FxStrip (right-click an effect tab).

export interface FxPreset {
  name: string;
  params: Record<string, number>;
}

// ★ SECTIONS ARE ROWS, NOT A TAXONOMY. A user's saved bank grows past what one list can hold, and
// how it wants grouping is nobody's business but theirs — so a SEPARATOR is simply another entry in
// the same array, and membership is IMPLICIT FROM ORDER: a preset belongs to whatever separator
// precedes it, and anything above the first one is ungrouped.
//
//   [ preset, preset, {sep:"DROPS"}, preset, preset, {sep:"FILTERS"}, preset ]
//
// The alternative — a `group: "..."` field on each preset — leaves the ORDER OF THE GROUPS
// undefined, so it needs a second ordering invented alongside it, and it needs a null-group special
// case for ungrouped ones. This way the stored array IS the rendered order, empty sections are
// legal (delete the last preset under a heading mid-set and the heading waits for you), and
// deleting a separator is non-destructive: its presets rejoin the ungrouped run.
//
// ★ FORWARD-COMPATIBLE BY ACCIDENT AND THEN ON PURPOSE: loadFxPresets() has always filtered on
// `p.params && typeof p.params === "object"`, so a build that predates sections drops separator
// rows rather than choking on them, and every existing caller that only wants PRESETS keeps
// working unchanged. Only the menu reads rows.
// ★ A SECTION IS A CONTAINER, NOT A MARKER. The first version made a separator a row in a flat
// array and let membership fall out of ORDER — which is compact, and cannot express the one thing
// the operator asked for next: a preset sitting AFTER a section at the top level. In a flat list a
// row after a separator IS in that section, by definition, so the top level could only ever be
// "loose presets, then every section". Sections nest now, one level deep, and the top level holds
// presets and sections interleaved in whatever order you drag them into.
//
// The flat shape is still what the FACTORY banks are AUTHORED in (a literal with separators reads
// far better in source than nested arrays) and it is still what older saved banks hold — foldRows()
// turns either into the nested one on the way in, so there is exactly one shape in memory.
export interface FxSep {
  name: string;
  sep: true;
}
/** A FACTORY preset, placed in your arrangement. It stores only the name — the params stay in
 *  code, so a fixed or improved factory preset reaches you through this reference instead of
 *  being frozen at whatever version seeded your browser. Editing one MATERIALISES it: the ref
 *  becomes a plain FxPreset you own, and the untouched original is still in code to revert to. */
export interface FxRef {
  ref: string;
}
/** A leaf BODY: an effect preset, or a chain preset. Both are `{ name, … }`, which is all the
 *  arrangement engine ever asks of them. */
export type FxBody = FxPreset | ChainPreset;
export type FxLeaf = FxBody | FxRef;
export interface FxGroup extends FxSep {
  items: FxLeaf[];
}
export type FxRow = FxLeaf | FxGroup;
/** How a row is addressed: [i] at the top level, [g, i] inside the group at top-level index g. */
export type FxPath = [number] | [number, number];

// Deliberately loose in their argument: these also run over the AUTHORED flat shape (FxSep, no
// items) on the way in, and over raw parsed JSON. Narrow going out, permissive coming in.
export const isGroup = (r: unknown): r is FxGroup => !!r && (r as FxSep).sep === true;
export const isRef = (r: unknown): r is FxRef => typeof (r as FxRef)?.ref === "string";
export const isSep = isGroup; // the old name, kept for callers that only ask "is this a heading?"
export const leafName = (r: FxLeaf): string => (isRef(r) ? r.ref : r.name);
export const rowName = (r: FxRow): string => (isGroup(r) ? r.name : leafName(r));

/** Fold the AUTHORED / STORED flat shape into the nested one: leaves before the first heading stay
 *  at the top level, and each heading swallows the leaves that follow it.
 *
 *  ★ IT MUST DETECT NESTED INPUT AND PASS IT THROUGH, not re-fold it. Folding is exactly the rule
 *  the nesting exists to escape — "a leaf after a heading is inside it" — so running it over an
 *  already-nested bank silently swallows every top-level preset that sits after a section, which is
 *  the one arrangement the flat model could not express and the whole reason for this shape. A
 *  heading that carries an `items` array is a container and has already been folded. */
export function foldRows(flat: readonly (FxLeaf | FxSep | FxGroup)[]): FxRow[] {
  const nested = flat.some((r) => isGroup(r) && Array.isArray((r as FxGroup).items));
  if (nested) return flat.map((r): FxRow => (isGroup(r) ? { name: r.name, sep: true, items: [...((r as FxGroup).items ?? [])] } : (r as FxLeaf)));
  const out: FxRow[] = [];
  let cur: FxGroup | null = null;
  for (const r of flat) {
    if (isGroup(r)) {
      cur = { name: r.name, sep: true, items: [] };
      out.push(cur);
    } else if (cur) cur.items.push(r as FxLeaf);
    else out.push(r as FxLeaf);
  }
  return out;
}

/** What is stored per kind. `rows` is the ARRANGEMENT — exactly what the menu shows, in order.
 *  `gone` is the suppression set: factory presets you deleted outright.
 *
 *  ★ TOMBSTONES LIVE OUTSIDE `rows` ON PURPOSE. Absence from the arrangement means "new — append
 *  it", which is the whole freshness mechanism; a deleted factory preset would otherwise come
 *  straight back on the next resolve. */
export interface FxBank {
  rows: FxRow[];
  gone: string[];
}

const validLeaf = (p: unknown): boolean => {
  const r = p as { name?: unknown; ref?: unknown; params?: unknown; kinds?: unknown };
  if (!r) return false;
  if (typeof r.ref === "string") return true;
  if (typeof r.name !== "string") return false;
  // Two leaf BODIES share this engine: an effect preset (params) and a chain preset (kinds). The
  // arrangement itself only ever reads `name` — refs, tombstones, sections and freshness are all
  // name-keyed — so widening it here is the whole cost of giving chains the same bank.
  return (!!r.params && typeof r.params === "object") || Array.isArray(r.kinds);
};
const validRow = (p: unknown): boolean => {
  const r = p as { name?: unknown; sep?: unknown; items?: unknown };
  if (r && r.sep === true) return typeof r.name === "string";
  return validLeaf(p);
};

/** The bank as stored. Reads every shape this has ever had — a bare array of presets (before
 *  sections), a flat array with separators (before nesting), or the nested one — and folds them all
 *  to nested. No version stamp, no upgrade step, no rewrite until you next edit something. */
export function loadFxBank(kind: string): FxBank {
  try {
    const raw = localStorage.getItem(KEY(kind));
    if (!raw) return { rows: [], gone: [] };
    const v = JSON.parse(raw);
    const rows = Array.isArray(v) ? v : Array.isArray(v?.rows) ? v.rows : [];
    const gone = !Array.isArray(v) && Array.isArray(v?.gone) ? (v.gone as unknown[]).filter((n): n is string => typeof n === "string") : [];
    return {
      rows: foldRows(rows.filter(validRow).map((r: FxGroup) => (r.sep === true ? { ...r, items: (r.items ?? []).filter(validLeaf) } : r))),
      gone,
    };
  } catch {
    return { rows: [], gone: [] };
  }
}

let announce: ((kind: string, bank: FxBank) => void) | null = null;
/** ★ THE SYNC BRIDGE. The bank has to stay synchronous and localStorage-backed — it is read during
 *  render and inside the hardware preset browse, neither of which can await anything — so it is NOT
 *  moved into React settings state. Instead every write announces itself and App mirrors it into
 *  settings.fxBanks, which is what syncs to the account. One direction each way: hydrate on load,
 *  announce on change. Nothing reads back through this, so there is no loop. */
export function onFxBankChange(fn: ((kind: string, bank: FxBank) => void) | null) {
  announce = fn;
}
/** Write the account's banks into the working store. ★ IT IS DIRTY-CHECKED AND IT REPORTS, because
 *  it is no longer a once-on-mount call: the account blob arrives asynchronously (the sign-in
 *  reconcile, the 30s poll, the live account-room broadcast all land AFTER mount), so this runs on
 *  every change to settings.fxBanks. Writing only what actually differs keeps that free, and the
 *  count is what lets the caller tell "a real inbound bank landed" from "the same value again",
 *  which is the difference between a sync and a loop. A kind the blob does not mention is LEFT
 *  ALONE — never cleared — so a device with a bank the account has not seen keeps it. */
export function hydrateFxBanks(banks: Record<string, FxBank> | undefined): number {
  if (!banks) return 0;
  let changed = 0;
  for (const kind in banks) {
    const b = banks[kind];
    if (!b || !Array.isArray(b.rows)) continue;
    try {
      const next = JSON.stringify(b);
      if (localStorage.getItem(KEY(kind)) === next) continue;
      localStorage.setItem(KEY(kind), next);
      changed++;
    } catch {
      /* quota / unavailable — it just won't persist */
    }
  }
  return changed;
}

export function saveFxBank(kind: string, bank: FxBank): FxBank {
  try {
    localStorage.setItem(KEY(kind), JSON.stringify(bank));
  } catch {
    /* quota / unavailable — it just won't persist */
  }
  announce?.(kind, bank);
  return bank;
}

export function loadFxRows(kind: string): FxRow[] {
  return loadFxBank(kind).rows;
}
export function saveFxRows(kind: string, rows: FxRow[]): FxRow[] {
  saveFxBank(kind, { ...loadFxBank(kind), rows });
  return rows;
}

const leavesOf = (rows: readonly FxRow[]): FxLeaf[] => rows.flatMap((r) => (isGroup(r) ? r.items : [r]));

/** ★ THE RESOLVED LIST — the only place refs, tombstones and freshness are reconciled.
 *
 *  1. An empty arrangement resolves to the FACTORY arrangement — the shipped rows and sections, as
 *     references. That is what "premade groups" is: a default arrangement in code, not a copy in
 *     your browser.
 *  2. A ref whose factory preset no longer exists (renamed or retired upstream) drops.
 *  3. Any factory preset neither present nor suppressed is appended under a NEW heading — so a
 *     preset added in a later release still reaches a user who curated their bank a year ago.
 *  ★ "Present" is asked of REFS AND OWNED ROWS ALIKE: editing a factory preset materialises its ref
 *    into an owned row of the same name, and asking only the refs would read that as missing and
 *    append a second copy of it. Editing any factory preset used to duplicate it.
 *  4. A bank saved before references existed has rows but NOT ONE ref — shape-identical to "I
 *     deleted every factory preset". Tombstones tell them apart: deleting always records in `gone`,
 *     so rows + no refs + nothing suppressed predates refs, and the shipped arrangement is merged
 *     in after theirs (minus anything they already hold a same-named copy of). */
export const NEW_SECTION = "NEW";

export function resolveFxRows(kind: string): FxRow[] {
  const bank = loadFxBank(kind);
  const factory = factoryFxRows(kind);
  const byName = new Map<string, FxBody>(leavesOf(factory).filter((r): r is FxBody => !isRef(r)).map((p) => [p.name, p] as const));
  const gone = new Set(bank.gone);
  const shipped: FxRow[] = factory.map((r): FxRow => (isGroup(r) ? { ...r, items: r.items.map((l): FxLeaf => ({ ref: leafName(l) })) } : { ref: leafName(r) }));

  const mineNames = new Set(leavesOf(bank.rows).filter((r): r is FxBody => !isRef(r)).map((p) => p.name));
  const legacy = bank.rows.length > 0 && !leavesOf(bank.rows).some(isRef) && bank.gone.length === 0;
  const merged: FxRow[] = !bank.rows.length
    ? shipped
    : legacy
      ? [...bank.rows, ...shipped.map((r) => (isGroup(r) ? { ...r, items: r.items.filter((l) => !mineNames.has(leafName(l))) } : r)).filter((r) => (isGroup(r) ? r.items.length > 0 : !mineNames.has(leafName(r))))]
      : bank.rows;

  const seen = new Set<string>();
  const keep = (l: FxLeaf): boolean => {
    const n = leafName(l);
    if (isRef(l) && (!byName.has(n) || gone.has(n))) return false;
    seen.add(n);
    return true;
  };
  const out: FxRow[] = [];
  for (const r of merged) {
    if (isGroup(r)) out.push({ ...r, items: r.items.filter(keep) });
    else if (keep(r)) out.push(r);
  }
  const missing = [...byName.keys()].filter((n) => !seen.has(n) && !gone.has(n));
  if (missing.length && bank.rows.length) out.push({ name: NEW_SECTION, sep: true, items: missing.map((n): FxLeaf => ({ ref: n })) });
  return out;
}

/** Resolve a leaf to the preset it stands for — following a ref into the factory bank. */
export function presetOf(kind: string, r: FxLeaf): FxPreset | null {
  const b = bodyOf(kind, r);
  return b && "params" in b ? b : null;
}
/** Resolve a leaf to its BODY, following a ref into the factory bank — whichever kind of body the
 *  bank holds. `presetOf` and `chainOf` are the two typed doors onto this. */
export function bodyOf(kind: string, r: FxLeaf): FxBody | null {
  if (!isRef(r)) return r;
  return (leavesOf(factoryFxRows(kind)).find((f) => !isRef(f) && f.name === r.ref) as FxBody | undefined) ?? null;
}
/** The chain-bank door: a leaf resolved to the chain preset it stands for. */
export function chainOf(r: FxLeaf): ChainPreset | null {
  const b = bodyOf(CHAIN_KIND, r);
  return b && "kinds" in b ? b : null;
}

/** An entry as the menu needs it: the preset to apply, its path, and whether it is still a FACTORY
 *  reference — which decides whether the row offers "revert", and whether deleting it writes a
 *  tombstone or simply drops a row. */
export interface FxEntry {
  p: FxPreset;
  path: FxPath;
  factory: boolean;
}
export function entryOf(kind: string, l: FxLeaf, path: FxPath): FxEntry | null {
  const p = presetOf(kind, l);
  return p ? { p, path, factory: isRef(l) } : null;
}

// ── mutations ────────────────────────────────────────────────────────────────────────────────
// ★ THE ARRANGEMENT HAS TO EXIST BEFORE IT CAN BE EDITED. An untouched bank stores nothing at all
// and resolves to the factory arrangement on the fly, so the very first edit has to write that
// resolved list down first — otherwise the mutation applies to an empty array and silently does
// nothing.
/** ★ EVERY MUTATION EDITS THE LIST THAT IS ON SCREEN. It used to edit the STORED rows whenever any
 *  existed, and fall back to the resolved list only for a bank nobody had touched — but the two are
 *  not the same list. resolve() appends a synthetic "NEW" section holding any factory preset the
 *  stored arrangement predates, so the menu renders one row more than the arrangement has, and from
 *  that row onward every index addressed a DIFFERENT list from the one the operator was pointing
 *  at: a drop into NEW hit `rows[undefined]` and returned silently, and a reorder past it moved the
 *  wrong section. It reads as "this one preset can't be dragged anywhere" — a guard, which it never
 *  was. Resolving here writes the synthetic section down as a real one on the first edit, which is
 *  also the only way it can ever be renamed or dissolved. resolve() is idempotent on its own output
 *  (its rows carry refs, so nothing is re-merged and nothing is missing), so this costs a read. */
function ensureArrangement(kind: string): FxRow[] {
  return structuredClone(resolveFxRows(kind));
}
function atPath(rows: FxRow[], path: FxPath): FxLeaf | FxGroup | undefined {
  const top = rows[path[0]];
  if (path.length === 1) return top;
  return top && isGroup(top) ? top.items[path[1]] : undefined;
}
function takeAt(rows: FxRow[], path: FxPath): FxRow | undefined {
  if (path.length === 1) return rows.splice(path[0], 1)[0];
  const g = rows[path[0]];
  return g && isGroup(g) ? g.items.splice(path[1], 1)[0] : undefined;
}

/** Reorder at the TOP level — presets and sections alike, which is what lets the two interleave. */
export function reorderTop(kind: string, from: number, at: number): FxRow[] {
  const rows = ensureArrangement(kind);
  if (from < 0 || from >= rows.length) return rows;
  const [row] = rows.splice(from, 1);
  rows.splice(from < at ? at - 1 : at, 0, row);
  return saveFxRows(kind, rows);
}
export function reorderInGroup(kind: string, g: number, from: number, at: number): FxRow[] {
  const rows = ensureArrangement(kind);
  const grp = rows[g];
  if (!grp || !isGroup(grp) || from < 0 || from >= grp.items.length) return rows;
  const [it] = grp.items.splice(from, 1);
  grp.items.splice(from < at ? at - 1 : at, 0, it);
  return saveFxRows(kind, rows);
}
/** File a top-level preset into a group — at its END, so a drop onto a closed heading has one
 *  unambiguous meaning. */
export function fileIntoGroup(kind: string, from: number, g: number): FxRow[] {
  const rows = ensureArrangement(kind);
  const src = rows[from];
  const grp = rows[g];
  if (!src || isGroup(src) || !grp || !isGroup(grp)) return rows;
  rows.splice(from, 1);
  grp.items.push(src);
  return saveFxRows(kind, rows);
}
/** Out of a group and back to the top level, immediately after the group it came from — where you
 *  can see it land, rather than at the far end of a list you are not looking at. */
/** Out of a group and back to the top level. ★ `at` IS AN INSERTION POINT IN THE TOP-LEVEL LIST,
 *  and it is what a drop under the pointer supplies — landing every escapee at `g + 1` regardless
 *  of where it was dropped is the same list ignoring you that the drop line exists to prevent.
 *  Nothing is removed from the top level here (the row comes out of a group), so the index needs no
 *  correction. Omitted (the row menu's "move out", which has no pointer) it still lands beside its
 *  old section, which is the only sensible answer when nobody pointed anywhere. */
export function moveOutOfGroup(kind: string, g: number, i: number, at?: number | null): FxRow[] {
  const rows = ensureArrangement(kind);
  const grp = rows[g];
  if (!grp || !isGroup(grp)) return rows;
  const [it] = grp.items.splice(i, 1);
  if (it) rows.splice(at == null ? g + 1 : Math.max(0, Math.min(rows.length, at)), 0, it);
  return saveFxRows(kind, rows);
}

/** Straight from one group into another — the drag the two-window layout makes possible and the
 *  ⇱-then-drag two-step made tedious. A move to the group it is already in is a no-op rather than
 *  a reorder-to-the-end, because a drop on your own heading is a mis-aim, not an instruction. */
export function moveBetweenGroups(kind: string, g: number, i: number, toG: number): FxRow[] {
  const rows = ensureArrangement(kind);
  const from = rows[g];
  const to = rows[toG];
  if (!from || !isGroup(from) || !to || !isGroup(to) || g === toG) return rows;
  const [it] = from.items.splice(i, 1);
  if (it) to.items.push(it);
  return saveFxRows(kind, rows);
}

export function addFxSection(kind: string, name: string): FxRow[] {
  const clean = name.trim();
  if (!clean) return loadFxRows(kind);
  return saveFxRows(kind, [...ensureArrangement(kind), { name: clean, sep: true, items: [] }]);
}
export function renameFxSection(kind: string, g: number, name: string): FxRow[] {
  const clean = name.trim();
  const rows = ensureArrangement(kind);
  const grp = rows[g];
  if (!clean || !grp || !isGroup(grp)) return rows;
  grp.name = clean;
  return saveFxRows(kind, rows);
}
/** Drop the heading, KEEP its presets — they are spliced back in where the group stood. Deleting
 *  several presets is what the row's own delete is for; a container that took its contents with it
 *  would be a destructive act wearing a tidy-up's clothes. */
export function deleteFxSection(kind: string, g: number): FxRow[] {
  const rows = ensureArrangement(kind);
  const grp = rows[g];
  if (!grp || !isGroup(grp)) return rows;
  rows.splice(g, 1, ...grp.items);
  return saveFxRows(kind, rows);
}

/** ★ MATERIALISE — copy-on-write. Editing a factory preset turns its REFERENCE into a preset you
 *  own, the factory original untouched in code behind it. That is what makes revert always possible,
 *  and it is the difference between this and seeding a copy of the bank into the browser. */
export function materialiseFxRow(kind: string, path: FxPath, patch?: { name?: string; params?: Record<string, number> }): FxRow[] {
  const rows = ensureArrangement(kind);
  const cur = atPath(rows, path);
  if (!cur || isGroup(cur)) return rows;
  const base = presetOf(kind, cur);
  if (!base) return rows;
  const next: FxLeaf = { name: patch?.name?.trim() || base.name, params: patch?.params ?? { ...base.params } };
  if (path.length === 1) rows[path[0]] = next;
  else (rows[path[0]] as FxGroup).items[path[1]] = next;
  return saveFxRows(kind, rows);
}
export function revertFxRow(kind: string, path: FxPath): FxRow[] {
  const rows = ensureArrangement(kind);
  const cur = atPath(rows, path);
  if (!cur || isGroup(cur) || isRef(cur)) return rows;
  if (!factoryFxPresets(kind).some((f) => f.name === cur.name)) return rows;
  const next: FxLeaf = { ref: cur.name };
  if (path.length === 1) rows[path[0]] = next;
  else (rows[path[0]] as FxGroup).items[path[1]] = next;
  return saveFxRows(kind, rows);
}
/** Delete a row. A factory preset is TOMBSTONED as well as removed, or the freshness rule hands it
 *  straight back on the next resolve. Anything you own is simply dropped. */
export function deleteFxRow(kind: string, path: FxPath): FxRow[] {
  const bank = { ...loadFxBank(kind), rows: ensureArrangement(kind) };
  const cur = atPath(bank.rows, path);
  if (!cur || isGroup(cur)) return bank.rows;
  const n = leafName(cur);
  if (isRef(cur) || factoryFxPresets(kind).some((f) => f.name === n)) bank.gone = [...new Set([...bank.gone, n])];
  takeAt(bank.rows, path);
  return saveFxBank(kind, bank).rows;
}

/** Restore-to-factory, the SAFE rung: un-suppress every deleted factory preset and drop the edits
 *  that materialised others. Your own presets, your sections and your order all survive. */
export function restoreFxFactory(kind: string): FxBank {
  const back = (l: FxLeaf): FxLeaf => (!isRef(l) && factoryFxPresets(kind).some((f) => f.name === l.name) ? { ref: l.name } : l);
  const rows = ensureArrangement(kind).map((r): FxRow => (isGroup(r) ? { ...r, items: r.items.map(back) } : back(r)));
  return saveFxBank(kind, { rows, gone: [] });
}
/** The heavier rung: throw the arrangement away too. Presets you saved yourself are KEPT — nothing
 *  in a command named "reset arrangement" implies losing them. */
export function resetFxArrangement(kind: string): FxBank {
  const mine = leavesOf(ensureArrangement(kind)).filter((l): l is FxPreset => !isRef(l) && !factoryFxPresets(kind).some((f) => f.name === l.name));
  return saveFxBank(kind, { rows: mine, gone: [] });
}
export function fxBankStats(kind: string): { hidden: number; edited: number; sections: number; own: number } {
  const bank = loadFxBank(kind);
  const factory = factoryFxPresets(kind);
  const leaves = leavesOf(bank.rows);
  return {
    hidden: bank.gone.length,
    edited: leaves.filter((l) => !isRef(l) && factory.some((f) => f.name === l.name)).length,
    sections: bank.rows.filter(isGroup).length,
    own: leaves.filter((l) => !isRef(l) && !factory.some((f) => f.name === l.name)).length,
  };
}

export const FACTORY_PRESETS: Record<string, (FxLeaf | FxSep)[]> = {
  // COMP — the dynamics machine. MODE is the instrument (its ballistics), the rest is taste.
  //
  // ★ THE BANK IS A MAP OF THE CONTROLS, and the first one was not. Mapping every preset against
  // CompFx's registerParams() found four powers the shipped nine never touched:
  //   • `scLp` — the sidechain LOW-pass — appeared in NO preset at all, so half the SC ribbon was
  //     dead in the bank AND a preset left whatever was dialled in (an omitted param inherits).
  //     Every preset states it now, and two exist to USE it: the detector goes deaf above a
  //     frequency, so hats and air stop triggering and only the body drives the reduction.
  //   • `makeup` was 0 in all nine, because `auto` was 1 in all but two. MANUAL MAKEUP is the
  //     other workflow, and it is the only way to make the comp LOUDER on purpose.
  //   • `ceiling` was -0.3 in all nine — the one control LIMIT actually operates.
  //   • the far ends of `attack` (100 ms), `release` (3000 ms) and `knee` (24) were unreachable:
  //     nothing went past 30 / 600 / 10, so a third of each range shipped unexplored.
  //
  // Grouped by WHAT YOU ARE DOING, not by which control it moves — the same rule the EQ bank
  // follows. Note GLUE's "Kick-Deaf" and SMASH's "Pump It" are the SAME control (`scHp`) at
  // opposite ends for opposite reasons: deaf to the kick so it stops pumping, or wide open so it
  // pumps on purpose. That pairing is the fastest way to learn what that filter does.
  comp: [
    { name: "GLUE", sep: true },
    // Holding a finished mix together. Slow, gentle, and the sidechain HP is doing most of the
    // work — without it the kick drives the reduction and the whole track breathes with it.
    { name: "Buss Glue", params: { mode: 0, threshold: -18, ratio: 4, attack: 10, release: 250, knee: 6, makeup: 0, auto: 1, scHp: 80, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "Gentle Glue", params: { mode: 0, threshold: -14, ratio: 2, attack: 30, release: 600, knee: 10, makeup: 0, auto: 1, scHp: 60, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "Kick-Deaf Glue", params: { mode: 0, threshold: -16, ratio: 4, attack: 15, release: 300, knee: 8, makeup: 0, auto: 1, scHp: 200, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "PUNCH", sep: true },
    // Shaping the transient rather than the level. A SLOW attack is the whole trick: the hit gets
    // through untouched and the body behind it is clamped, which is what reads as punch.
    { name: "Punch (slow attack)", params: { mode: 0, threshold: -20, ratio: 4, attack: 30, release: 120, knee: 3, makeup: 0, auto: 1, scHp: 100, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "Let It Hit", params: { mode: 0, threshold: -24, ratio: 6, attack: 60, release: 150, knee: 2, makeup: 0, auto: 1, scHp: 80, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "FET Grab", params: { mode: 1, threshold: -22, ratio: 8, attack: 0.05, release: 120, knee: 2, makeup: 0, auto: 1, scHp: 60, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "SMASH", sep: true },
    // Compression as an EFFECT — you are meant to hear it. PUMP IT is the deliberate opposite of
    // KICK-DEAF GLUE: sidechain HP wide open and a long release, so the kick ducks the track and
    // it swells back between beats.
    { name: "All Buttons", params: { mode: 1, threshold: -30, ratio: 20, attack: 0.02, release: 60, knee: 0, makeup: 0, auto: 1, scHp: 0, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "Parallel Smash", params: { mode: 1, threshold: -34, ratio: 20, attack: 0.05, release: 90, knee: 0, makeup: 0, auto: 1, scHp: 0, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 0.45 } },
    { name: "Pump It", params: { mode: 0, threshold: -30, ratio: 10, attack: 1, release: 900, knee: 2, makeup: 0, auto: 1, scHp: 0, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "LEVEL", sep: true },
    // One loudness, no character — the presets you leave ON. HAT-DEAF is the sidechain LOW-pass
    // earning its place: the detector cannot hear the cymbals, so they stop triggering it.
    { name: "Opto Levelling", params: { mode: 2, threshold: -20, ratio: 3, attack: 10, release: 600, knee: 10, makeup: 0, auto: 1, scHp: 0, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "Vocal Ride", params: { mode: 2, threshold: -24, ratio: 3, attack: 10, release: 1400, knee: 18, makeup: 0, auto: 1, scHp: 100, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "Hat-Deaf Level", params: { mode: 0, threshold: -20, ratio: 3, attack: 20, release: 400, knee: 10, makeup: 0, auto: 1, scHp: 0, scLp: 4000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "Manual Makeup", params: { mode: 0, threshold: -20, ratio: 4, attack: 10, release: 250, knee: 6, makeup: 6, auto: 0, scHp: 80, scLp: 20000, scExt: 0, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "DUCK", sep: true },
    // `scExt:1` hands the detector to the OTHER deck (or the mic), so something else drives the
    // reduction. The sidechain filters matter most here: band-limit the detector to what is
    // actually speaking and the duck follows the voice instead of the room.
    { name: "Duck the Other Deck", params: { mode: 0, threshold: -26, ratio: 6, attack: 5, release: 220, knee: 4, makeup: 0, auto: 0, scHp: 120, scLp: 20000, scExt: 1, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "Duck Under Mic", params: { mode: 1, threshold: -34, ratio: 8, attack: 1, release: 400, knee: 2, makeup: 0, auto: 0, scHp: 150, scLp: 8000, scExt: 1, lookahead: 0, ceiling: -0.3, mix: 1 } },
    { name: "CEILING", sep: true },
    // LIMIT mode, where `ceiling` is the control and `lookahead` is what makes it true. The three
    // differ only in how much headroom they leave and how far ahead they look.
    { name: "Brickwall", params: { mode: 3, threshold: -18, ratio: 20, attack: 0.2, release: 80, knee: 1, makeup: 0, auto: 0, scHp: 0, scLp: 20000, scExt: 0, lookahead: 1.5, ceiling: -0.3, mix: 1 } },
    { name: "Safe Ceiling", params: { mode: 3, threshold: -12, ratio: 20, attack: 0.2, release: 120, knee: 1, makeup: 0, auto: 0, scHp: 0, scLp: 20000, scExt: 0, lookahead: 3, ceiling: -1, mix: 1 } },
    { name: "Soft Cap", params: { mode: 3, threshold: -16, ratio: 20, attack: 0.5, release: 250, knee: 4, makeup: 0, auto: 0, scHp: 0, scLp: 20000, scExt: 0, lookahead: 5, ceiling: -0.5, mix: 1 } },
  ],
  // SATURATOR — the 5 style curves (TUBE/TAPE/CLIP/FOLD/DIODE) crossed with the multiband drives
  // (drive0=low <250 Hz, drive1=mid, drive2=high >2.5 kHz) so a style becomes several sounds:
  // saturate just the lows (weight, no fizz) or just the highs (air). `mix` sets how hard it hits
  // (auto gain-comp keeps it dirt-not-loudness); `bias` adds even harmonics; `punish` steepens.
  //
  // ★ MAPPED AGAINST SaturatorFx.registerParams(). `heat` — how hot a PUNISHED band gets — shipped
  // in no preset at all (it was added after these were written), so the whole hot/cold axis of the
  // punish switch was one value for the entire bank. All fourteen state it now; the shipped eight
  // state 0.5, which is what they were already getting, so nothing they do changes. And the second
  // finding is not a missing param but a missing IDEA: style/punish/bias/heat/out are PER BAND, and
  // every preset set all three bands identically — one character for the whole device, which is the
  // one thing a multiband saturator does not have to be. SPLIT CHARACTER is the first that does not:
  // tape on the lows, tube in the mids, clip on top.
  saturator: [
    { name: "BUS", sep: true },
    // What you leave on. Low drive, low mix, no punish — the point is that you notice it when you
    // switch it OFF.
    { name: "Warm Bus", params: { style0: 1, style1: 1, style2: 1, punish0: 0, punish1: 0, punish2: 0, bias0: 0.1, bias1: 0.1, bias2: 0.1, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.5, out1: 0.5, out2: 0.5, drive0: 0.45, drive1: 0.4, drive2: 0.35, xover0: 0.366, xover1: 0.699, mix: 0.35 } },
    { name: "Tube Warmth", params: { style0: 0, style1: 0, style2: 0, punish0: 0, punish1: 0, punish2: 0, bias0: 0.35, bias1: 0.35, bias2: 0.35, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.5, out1: 0.5, out2: 0.5, drive0: 0.5, drive1: 0.5, drive2: 0.45, xover0: 0.366, xover1: 0.699, mix: 0.5 } },
    { name: "Console Drive", params: { style0: 1, style1: 1, style2: 1, punish0: 0, punish1: 0, punish2: 0, bias0: 0.05, bias1: 0.05, bias2: 0.05, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.5, out1: 0.5, out2: 0.5, drive0: 0.35, drive1: 0.32, drive2: 0.28, xover0: 0.366, xover1: 0.699, mix: 0.28 } },
    { name: "DIRT", sep: true },
    // Audible damage. FULL PUNISH is the device at its limit and the only preset with HEAT at 1 —
    // punish decides that a band clips hard, heat decides how hot it is when it gets there.
    { name: "Tube Slam", params: { style0: 0, style1: 0, style2: 0, punish0: 1, punish1: 1, punish2: 1, bias0: 0.4, bias1: 0.4, bias2: 0.4, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.44, out1: 0.44, out2: 0.44, drive0: 0.75, drive1: 0.72, drive2: 0.6, xover0: 0.366, xover1: 0.699, mix: 0.72 } },
    { name: "Transistor Fuzz", params: { style0: 2, style1: 2, style2: 2, punish0: 1, punish1: 1, punish2: 1, bias0: 0.15, bias1: 0.15, bias2: 0.15, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.4, out1: 0.4, out2: 0.4, drive0: 0.68, drive1: 0.8, drive2: 0.68, xover0: 0.366, xover1: 0.699, mix: 0.82 } },
    { name: "Full Punish", params: { style0: 2, style1: 2, style2: 2, punish0: 1, punish1: 1, punish2: 1, bias0: 0.2, bias1: 0.2, bias2: 0.2, heat0: 1, heat1: 1, heat2: 1, out0: 0.38, out1: 0.38, out2: 0.38, drive0: 0.9, drive1: 0.88, drive2: 0.8, xover0: 0.366, xover1: 0.699, mix: 0.95 } },
    { name: "BANDS", sep: true },
    // One band, and the crossover moved to put it where you want it. This is the reason the device
    // is multiband at all: weight without fizz, air without mud, bite without either.
    { name: "Low-End Weight", params: { style0: 0, style1: 0, style2: 0, punish0: 1, punish1: 1, punish2: 1, bias0: 0.2, bias1: 0.2, bias2: 0.2, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.5, out1: 0.5, out2: 0.5, drive0: 0.85, drive1: 0.28, drive2: 0.12, xover0: 0.26, xover1: 0.699, mix: 0.6 } },
    { name: "Mid Bite", params: { style0: 0, style1: 0, style2: 0, punish0: 1, punish1: 1, punish2: 1, bias0: 0.25, bias1: 0.25, bias2: 0.25, heat0: 0.7, heat1: 0.7, heat2: 0.7, out0: 0.5, out1: 0.5, out2: 0.5, drive0: 0.1, drive1: 0.8, drive2: 0.18, xover0: 0.3, xover1: 0.78, mix: 0.5 } },
    { name: "Top Air", params: { style0: 2, style1: 2, style2: 2, punish0: 0, punish1: 0, punish2: 0, bias0: 0, bias1: 0, bias2: 0, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.48, out1: 0.48, out2: 0.48, drive0: 0.12, drive1: 0.22, drive2: 0.7, xover0: 0.366, xover1: 0.82, mix: 0.32 } },
    { name: "CHARACTER", sep: true },
    // The two curves nothing else uses, and the one preset that stops treating the three bands as
    // one device: SPLIT CHARACTER runs a different shaper in each.
    { name: "Metal Fold", params: { style0: 3, style1: 3, style2: 3, punish0: 1, punish1: 1, punish2: 1, bias0: 0.3, bias1: 0.3, bias2: 0.3, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.4, out1: 0.4, out2: 0.4, drive0: 0.58, drive1: 0.75, drive2: 0.64, xover0: 0.366, xover1: 0.699, mix: 0.6 } },
    { name: "Diode Honk", params: { style0: 4, style1: 4, style2: 4, punish0: 1, punish1: 1, punish2: 1, bias0: 0.55, bias1: 0.55, bias2: 0.55, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.4, out1: 0.4, out2: 0.4, drive0: 0.62, drive1: 0.8, drive2: 0.58, xover0: 0.5, xover1: 0.6, mix: 0.7 } },
    { name: "Split Character", params: { style0: 1, style1: 0, style2: 2, punish0: 0, punish1: 1, punish2: 0, bias0: 0.3, bias1: 0.15, bias2: 0.05, heat0: 0.5, heat1: 0.85, heat2: 0.5, out0: 0.5, out1: 0.5, out2: 0.5, drive0: 0.5, drive1: 0.55, drive2: 0.4, xover0: 0.366, xover1: 0.699, mix: 0.55 } },
    { name: "TOUCH", sep: true },
    // Almost nothing. SILK is the lowest drive in the bank and TAPE KISS the coldest punish — both
    // exist because "a bit" is a setting people want and a bank of eight loud presets cannot offer.
    { name: "Silk", params: { style0: 0, style1: 0, style2: 0, punish0: 0, punish1: 0, punish2: 0, bias0: 0.05, bias1: 0.05, bias2: 0.05, heat0: 0.5, heat1: 0.5, heat2: 0.5, out0: 0.52, out1: 0.52, out2: 0.52, drive0: 0.18, drive1: 0.16, drive2: 0.14, xover0: 0.366, xover1: 0.699, mix: 0.18 } },
    { name: "Tape Kiss", params: { style0: 1, style1: 1, style2: 1, punish0: 1, punish1: 1, punish2: 1, bias0: 0.12, bias1: 0.12, bias2: 0.12, heat0: 0.25, heat1: 0.25, heat2: 0.25, out0: 0.5, out1: 0.5, out2: 0.5, drive0: 0.3, drive1: 0.28, drive2: 0.24, xover0: 0.366, xover1: 0.699, mix: 0.3 } },
  ],
  // DELAY (ECHO) — a dub/DJ delay. Beat-locked (`sync:1`), so `div` (0=1/16…8=1 bar) is the
  // musical identity and `time` is just the 120-BPM echo of it (recomputed live from the deck
  // tempo). `feedback` sets the tail length; the in-loop HP/LP narrow each repeat (dub sweep);
  // `analog` colours the tails; `stereo:1` = ping-pong; `spread` drifts L/R for width.
  //
  // ★ MAPPED AGAINST DelayFx.registerParams(), the same audit the COMP bank got. What the nine
  // shipped presets never touched:
  //   • `hpRes` / `lpRes` — the ribbon's RESONANCE axis — appeared in NO preset, so the whole
  //     second dimension of the filter control was dead in the bank AND, since an omitted param
  //     INHERITS, every preset left whatever resonance was dialled in. All sixteen state it now;
  //     the shipped nine state 0 (their sound is unchanged) and the new ones use it. Note the
  //     in-loop safety cap: at high feedback the DSP declines part of a big resonance and the
  //     ribbon shows what was APPLIED, so DUB SIREN's 0.8 will read lower than it asks for.
  //   • `div` only ever took 1,2,3,4,6 of 0..8 — no 1/16 (STUTTER) and no whole bar (BAR THROW),
  //     which are two of the four things a DJ actually does with a delay.
  //   • the far ends: `feedback` stopped at .60 of .95 (DUB SIREN .88, the runaway), `modRate` at
  //     0.9 of 8 and `modDepth` at .007 of .012 (CHORUS TAIL — a delay short enough to be a
  //     chorus is the same device wearing a different hat), `spread` at .40, `analog` at .60.
  //
  // Grouped by WHAT YOU ARE DOING with it, the same rule as EQ and COMP: a throw is a gesture, a
  // dub is a texture, and the fact that both are "a delay with feedback" is not how you reach for
  // one. SLAPBACK is where the two `sync:0` presets live — free milliseconds is the whole point of
  // that group, and it is the only place in the bank the grid is off.
  delay: [
    { name: "THROWS", sep: true },
    // The stab-and-pull-back. Tempo-locked and REPITCH, so a time change slurs like tape — which
    // is the sound of the gesture, not a side effect of it.
    { name: "1/8 Slap", params: { mix: 0.26, time: 0.25, feedback: 0.28, hp: 200, lp: 8000, hpRes: 0, lpRes: 0, sync: 1, div: 2, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0, modDepth: 0, modRate: 0.5, duck: 0, spread: 0 } },
    { name: "Triplet Throw", params: { mix: 0.3, time: 0.167, feedback: 0.42, hp: 150, lp: 6000, hpRes: 0, lpRes: 0, sync: 1, div: 1, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0.2, modDepth: 0, modRate: 0.5, duck: 0, spread: 0 } },
    { name: "Bar Throw", params: { mix: 0.32, time: 2.0, feedback: 0.5, hp: 160, lp: 6000, hpRes: 0, lpRes: 0.2, sync: 1, div: 8, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0.25, modDepth: 0, modRate: 0.5, duck: 0.2, spread: 0.1 } },
    { name: "Stutter 1/16", params: { mix: 0.45, time: 0.125, feedback: 0.68, hp: 200, lp: 7000, hpRes: 0, lpRes: 0, sync: 1, div: 0, timeMode: 1, stereo: 0, link: 0, freeze: 0, analog: 0, modDepth: 0, modRate: 0.5, duck: 0, spread: 0 } },
    { name: "SLAPBACK", sep: true },
    // The two that are NOT on the grid. Short enough that the repeat reads as one sound with the
    // dry rather than as an echo of it — which is why `sync:0` belongs here and nowhere else.
    { name: "Slapback", params: { mix: 0.25, time: 0.09, feedback: 0.18, hp: 240, lp: 7000, hpRes: 0, lpRes: 0, sync: 0, div: 2, timeMode: 1, stereo: 0, link: 0, freeze: 0, analog: 0.25, modDepth: 0, modRate: 0.5, duck: 0, spread: 0 } },
    { name: "Doubler", params: { mix: 0.35, time: 0.032, feedback: 0.04, hp: 300, lp: 9000, hpRes: 0, lpRes: 0, sync: 0, div: 2, timeMode: 1, stereo: 0, link: 0, freeze: 0, analog: 0.1, modDepth: 0, modRate: 0.5, duck: 0, spread: 0.55 } },
    { name: "DUB", sep: true },
    // Long, filtered, fed back hard. DUB SIREN is the runaway: feedback near the cap with a
    // resonant low-pass in the loop, which is the sound that made the filter worth sweeping.
    { name: "Ducked Dub", params: { mix: 0.38, time: 0.5, feedback: 0.55, hp: 180, lp: 3800, hpRes: 0, lpRes: 0, sync: 1, div: 4, timeMode: 0, stereo: 0, link: 1, freeze: 0, analog: 0.4, modDepth: 0, modRate: 0.5, duck: 0.65, spread: 0.15 } },
    { name: "Tape Echo", params: { mix: 0.3, time: 0.5, feedback: 0.46, hp: 220, lp: 3200, hpRes: 0, lpRes: 0, sync: 1, div: 4, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0.6, modDepth: 0.007, modRate: 0.9, duck: 0, spread: 0.2 } },
    { name: "Dub Siren", params: { mix: 0.42, time: 0.5, feedback: 0.88, hp: 400, lp: 1200, hpRes: 0.35, lpRes: 0.8, sync: 1, div: 4, timeMode: 0, stereo: 0, link: 1, freeze: 0, analog: 0.8, modDepth: 0.003, modRate: 0.6, duck: 0.3, spread: 0.2 } },
    { name: "WIDTH", sep: true },
    // Anything whose point is the stereo field: `stereo:1` crosses the feedback L↔R, `spread`
    // offsets the two delay times so the repeats are not one thing in the middle.
    { name: "Ping-Pong 1/8", params: { mix: 0.3, time: 0.25, feedback: 0.42, hp: 160, lp: 7000, hpRes: 0, lpRes: 0, sync: 1, div: 2, timeMode: 0, stereo: 1, link: 0, freeze: 0, analog: 0, modDepth: 0, modRate: 0.5, duck: 0.3, spread: 0.3 } },
    { name: "Digital Bounce", params: { mix: 0.3, time: 0.375, feedback: 0.44, hp: 200, lp: 5000, hpRes: 0, lpRes: 0, sync: 1, div: 3, timeMode: 1, stereo: 1, link: 0, freeze: 0, analog: 0.15, modDepth: 0, modRate: 0.5, duck: 0, spread: 0.25 } },
    { name: "Half-Bar Wash", params: { mix: 0.3, time: 1.0, feedback: 0.4, hp: 300, lp: 2600, hpRes: 0, lpRes: 0, sync: 1, div: 6, timeMode: 2, stereo: 1, link: 1, freeze: 0, analog: 0.3, modDepth: 0.004, modRate: 0.35, duck: 0.4, spread: 0.4 } },
    { name: "MOTION", sep: true },
    // The tail MOVES. CHORUS TAIL is the device at its shortest and fastest — 22 ms with the mod
    // at full depth is a chorus, and it is the same three controls doing it.
    { name: "Chorus Tail", params: { mix: 0.4, time: 0.022, feedback: 0.22, hp: 250, lp: 9000, hpRes: 0, lpRes: 0, sync: 0, div: 2, timeMode: 1, stereo: 1, link: 0, freeze: 0, analog: 0.15, modDepth: 0.012, modRate: 4.5, duck: 0, spread: 0.35 } },
    { name: "Warble Echo", params: { mix: 0.32, time: 0.5, feedback: 0.5, hp: 200, lp: 3400, hpRes: 0, lpRes: 0.3, sync: 1, div: 4, timeMode: 0, stereo: 0, link: 0, freeze: 0, analog: 0.5, modDepth: 0.009, modRate: 2.2, duck: 0, spread: 0.25 } },
    { name: "HOLD", sep: true },
    // `freeze:1` — feedback to 1.0 and the input closed, so what is in the line stays there. FREEZE
    // HOLD keeps the grab dry and mono; INFINITE WASH turns the same trick into a pad.
    { name: "Freeze Hold", params: { mix: 0.4, time: 0.5, feedback: 0.6, hp: 140, lp: 5500, hpRes: 0, lpRes: 0, sync: 1, div: 4, timeMode: 0, stereo: 0, link: 0, freeze: 1, analog: 0, modDepth: 0, modRate: 0.5, duck: 0, spread: 0 } },
    { name: "Infinite Wash", params: { mix: 0.5, time: 1.0, feedback: 0.6, hp: 200, lp: 2000, hpRes: 0, lpRes: 0.45, sync: 1, div: 6, timeMode: 2, stereo: 1, link: 1, freeze: 1, analog: 0.35, modDepth: 0.005, modRate: 0.3, duck: 0, spread: 0.6 } },
  ],
  // REVERB (VERB) — the Jot FDN tank. `style` (0 HALL/1 ROOM/2 PLATE/3 AMBIENT) picks the voicing;
  // `size`×`decay` set the space and tail; `lowCut`/`highCut` keep the wet out of the mud and the
  // fizz; `duck` blooms the tail in the gaps; `character`/`modRate` add movement; post shelves tilt.
  //
  // ★ MAPPED AGAINST ReverbFx.registerParams() — and it is the SAME MISS for the third device
  // running: `lowCutRes`/`highCutRes`, the resonance beside the two cut frequencies every preset
  // already sets, appeared in none of them. A frequency gets dialled because it is obvious; the Q
  // next to it does not, and only the param registry says so. The other under-used ends:
  //   • `predelay` never left 0.005‥0.03 of a 0‥0.2 range — the gap BEFORE the tail is what puts a
  //     vocal in front of its own reverb (GATED PLATE .09, CATHEDRAL .12).
  //   • `modRate` sat at 0.25‥0.6 of 0.02‥6. At 3.5 the tank is a chorus (CHORUS TANK).
  //   • `width` stopped at 1.3 of 1.5, `drive` at 0.45 of 1.
  // Grouped by the SPACE you are asking for, which is how anyone picks a reverb.
  reverb: [
    { name: "PLATES", sep: true },
    // Bright, dense, no early-reflection story — the vocal/snare reverb. GATED PLATE is the short
    // one with a long predelay: the tail starts late and stops early, so it never sits on the word.
    { name: "Vocal Plate", params: { mix: 0.28, size: 0.5, decay: 0.5, brightness: 0.7, predelay: 0.02, width: 1.1, lowCut: 200, highCut: 12000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0, modRate: 0.35, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 2 } },
    { name: "Shimmer Air", params: { mix: 0.3, size: 0.8, decay: 0.8, brightness: 0.85, predelay: 0.02, width: 1.25, lowCut: 300, highCut: 16000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0.5, modRate: 0.6, postLow: 0, postHigh: 4, duck: 0, freeze: 0, style: 2 } },
    { name: "Gated Plate", params: { mix: 0.3, size: 0.45, decay: 0.18, brightness: 0.75, predelay: 0.09, width: 1.15, lowCut: 250, highCut: 13000, lowCutRes: 0, highCutRes: 0, drive: 0.1, character: 0.05, modRate: 0.35, postLow: -3, postHigh: 2, duck: 0, freeze: 0, style: 2 } },
    { name: "ROOMS", sep: true },
    // Small and early. TIGHT BOOTH is where the high-cut RESONANCE earns its place: a peak right at
    // the cutoff is what makes a small room sound boxy rather than merely dark.
    { name: "Drum Room", params: { mix: 0.25, size: 0.35, decay: 0.35, brightness: 0.55, predelay: 0.008, width: 1, lowCut: 120, highCut: 9000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0, modRate: 0.35, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 1 } },
    { name: "Short Room", params: { mix: 0.3, size: 0.4, decay: 0.25, brightness: 0.6, predelay: 0.005, width: 1, lowCut: 150, highCut: 11000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0, modRate: 0.35, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 1 } },
    { name: "Tight Booth", params: { mix: 0.22, size: 0.25, decay: 0.2, brightness: 0.5, predelay: 0.004, width: 0.85, lowCut: 180, highCut: 7000, lowCutRes: 0, highCutRes: 0.6, drive: 0.15, character: 0, modRate: 0.35, postLow: 0, postHigh: -2, duck: 0, freeze: 0, style: 1 } },
    { name: "HALLS", sep: true },
    // Big and slow. CATHEDRAL is the device at its limits — full size, full decay, and the longest
    // predelay in the bank, which is the only thing that keeps a tail that long off the downbeat.
    { name: "Big Hall", params: { mix: 0.32, size: 0.85, decay: 0.75, brightness: 0.55, predelay: 0.03, width: 1.2, lowCut: 150, highCut: 10000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0.15, modRate: 0.4, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 0 } },
    { name: "Dark Chamber", params: { mix: 0.3, size: 0.75, decay: 0.7, brightness: 0.3, predelay: 0.02, width: 1, lowCut: 120, highCut: 6000, lowCutRes: 0, highCutRes: 0, drive: 0.45, character: 0.2, modRate: 0.3, postLow: 3, postHigh: -6, duck: 0, freeze: 0, style: 0 } },
    { name: "Cathedral", params: { mix: 0.38, size: 1, decay: 1, brightness: 0.45, predelay: 0.12, width: 1.35, lowCut: 160, highCut: 8000, lowCutRes: 0, highCutRes: 0, drive: 0.25, character: 0.3, modRate: 0.25, postLow: 2, postHigh: -3, duck: 0, freeze: 0, style: 0 } },
    { name: "MOVING", sep: true },
    // Tails that will not sit still. CHORUS TANK runs the modulation ten times faster than anything
    // else here — at 3.5 Hz the tank stops being a room and becomes an ensemble.
    { name: "Ambient Wash", params: { mix: 0.35, size: 0.9, decay: 0.85, brightness: 0.65, predelay: 0.02, width: 1.3, lowCut: 250, highCut: 12000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0.4, modRate: 0.5, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 3 } },
    { name: "Chorus Tank", params: { mix: 0.34, size: 0.7, decay: 0.6, brightness: 0.7, predelay: 0.02, width: 1.3, lowCut: 220, highCut: 13000, lowCutRes: 0.3, highCutRes: 0, drive: 0, character: 0.9, modRate: 3.5, postLow: 0, postHigh: 0, duck: 0, freeze: 0, style: 3 } },
    { name: "DUCKED", sep: true },
    // The tail lives in the gaps. VOCAL DUCK adds the resonant low-cut on top: the wet is band-
    // limited to above the voice AND pulled down under it, so you can run it far wetter than usual.
    { name: "Ducked Verb", params: { mix: 0.34, size: 0.7, decay: 0.65, brightness: 0.6, predelay: 0.015, width: 1.1, lowCut: 180, highCut: 9000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0, modRate: 0.35, postLow: 0, postHigh: 0, duck: 0.6, freeze: 0, style: 0 } },
    { name: "Vocal Duck", params: { mix: 0.4, size: 0.6, decay: 0.55, brightness: 0.65, predelay: 0.025, width: 1.05, lowCut: 320, highCut: 10000, lowCutRes: 0.5, highCutRes: 0, drive: 0, character: 0.1, modRate: 0.35, postLow: -2, postHigh: 1, duck: 0.85, freeze: 0, style: 2 } },
    { name: "HOLD", sep: true },
    // `freeze:1` — the tank stops taking input and holds what it has, forever. An infinite sustain
    // you can mix a new track in under, which is the reverb's single biggest trick.
    { name: "Freeze Tank", params: { mix: 0.5, size: 0.85, decay: 0.9, brightness: 0.6, predelay: 0.01, width: 1.2, lowCut: 200, highCut: 11000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0.2, modRate: 0.4, postLow: 0, postHigh: 0, duck: 0, freeze: 1, style: 0 } },
    { name: "Frozen Air", params: { mix: 0.55, size: 0.95, decay: 0.95, brightness: 0.8, predelay: 0.01, width: 1.45, lowCut: 400, highCut: 16000, lowCutRes: 0, highCutRes: 0, drive: 0, character: 0.35, modRate: 0.8, postLow: -6, postHigh: 3, duck: 0, freeze: 1, style: 3 } },
  ],
  // MOD — chorus/flanger/phaser off one shared LFO. `mode` picks the engine; `rate` is a 0..1 knob
  // (free Hz, ~0.05‥10, or an index into MOD_DIVS when `sync:1`); `depth`×`feedback` set the
  // intensity/resonance; `thru:1` = through-zero flange; `stages` deepens the phaser; `wave:2` =
  // square (stepped sweep); `src` is LFO (0) / ENV (1) / BOTH (2).
  //
  // ★ MAPPED AGAINST ModFx.registerParams(): `width` — the stereo spread of the per-channel LFO
  // phase — was in no preset, so every one of them modulated both channels in lockstep and the
  // device's stereo dimension was off. `tone` never left 0.45‥0.55, the middle tenth of its travel.
  // `wave` only ever took 0 and 2, so the triangle was unreachable from the bank.
  // Grouped by what the modulation is FOR, not by which of the three engines produces it — WIDEN
  // and EXTREME both contain a chorus, and nobody picks one by naming its topology.
  mod: [
    { name: "WIDEN", sep: true },
    // Make one thing sound like several. STEREO SPREAD is the first preset in this bank to put the
    // two channels' LFOs out of phase at all, which is the difference between thicker and WIDER.
    { name: "Lush Chorus", params: { mix: 0.45, mode: 0, rate: 0.35, depth: 0.5, feedback: 0.2, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 0, sync: 0, width: 0 } },
    { name: "Wide Ensemble", params: { mix: 0.5, mode: 0, rate: 0.22, depth: 0.7, feedback: 0.1, tone: 0.55, stages: 6, wave: 0, src: 0, thru: 0, sync: 0, width: 0 } },
    { name: "Stereo Spread", params: { mix: 0.5, mode: 0, rate: 0.18, depth: 0.6, feedback: 0.05, tone: 0.6, stages: 6, wave: 0, src: 0, thru: 0, sync: 0, width: 1 } },
    { name: "SWEEP", sep: true },
    // The moving notch you hear travel. Feedback is the resonance of that notch — it is what turns
    // a sweep into a jet.
    { name: "Jet Flanger", params: { mix: 0.5, mode: 1, rate: 0.5, depth: 0.6, feedback: 0.6, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 0, sync: 0, width: 0 } },
    { name: "Synced Flanger", params: { mix: 0.5, mode: 1, rate: 0.4, depth: 0.85, feedback: 0.65, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 0, sync: 1, width: 0 } },
    { name: "Slow Phaser 8", params: { mix: 0.5, mode: 2, rate: 0.12, depth: 0.8, feedback: 0.6, tone: 0.45, stages: 8, wave: 0, src: 0, thru: 0, sync: 0, width: 0 } },
    { name: "ON THE GRID", sep: true },
    // `sync:1` — the LFO locks to the deck and `rate` indexes MOD_DIVS (4 bar…1/8). A sweep that
    // lands with the phrase is a different instrument from one that drifts against it. BAR SWEEP is
    // the slowest setting the device has, and the only preset using the triangle.
    { name: "Square Phaser", params: { mix: 0.5, mode: 2, rate: 0.8, depth: 0.7, feedback: 0.3, tone: 0.5, stages: 4, wave: 2, src: 0, thru: 0, sync: 1, width: 0 } },
    { name: "Bar Sweep", params: { mix: 0.5, mode: 1, rate: 0, depth: 0.9, feedback: 0.55, tone: 0.3, stages: 6, wave: 1, src: 0, thru: 0, sync: 1, width: 0.6 } },
    { name: "FOLLOW", sep: true },
    // `src:1` — the TRACK's envelope drives the sweep instead of a clock, so the filter moves with
    // the drums. An auto-wah and an envelope chorus are the same idea in two engines.
    { name: "Env Phaser", params: { mix: 0.55, mode: 2, rate: 0.5, depth: 0.8, feedback: 0.5, tone: 0.5, stages: 6, wave: 0, src: 1, thru: 0, sync: 0, width: 0 } },
    { name: "Env Chorus", params: { mix: 0.5, mode: 0, rate: 0.4, depth: 0.75, feedback: 0.15, tone: 0.7, stages: 6, wave: 0, src: 1, thru: 0, sync: 0, width: 0.35 } },
    { name: "EXTREME", sep: true },
    // Where it stops being a treatment. METAL COMB is the feedback knob at the top with the tone
    // fully open — the comb rings hard enough to have a pitch of its own.
    { name: "Through-Zero", params: { mix: 0.5, mode: 1, rate: 0.55, depth: 0.75, feedback: 0.5, tone: 0.5, stages: 6, wave: 0, src: 2, thru: 1, sync: 0, width: 0 } },
    { name: "Fast Vibrato", params: { mix: 0.6, mode: 0, rate: 0.85, depth: 0.9, feedback: 0, tone: 0.5, stages: 6, wave: 0, src: 0, thru: 0, sync: 0, width: 0 } },
    { name: "Metal Comb", params: { mix: 0.6, mode: 1, rate: 0.95, depth: 0.7, feedback: 0.95, tone: 1, stages: 6, wave: 0, src: 0, thru: 0, sync: 0, width: 0.8 } },
  ],
  // CRUSH — bit + sample-rate reduction into a resonant reconstruction filter. `mode` (0 S&H/1 ZERO/
  // 2 VINTAGE/3 JITTER) is the decimator flavour; `bits` (0 clean→1 smashed) and `rate` (downsample)
  // are the two destroyers; `cut`/`res` shape the DAC filter (1=open). `mix` blends grit under the dry.
  //
  // ★ MAPPED AGAINST CrushFx.registerParams(): nothing was MISSING here — every param was stated —
  // but two were barely moved. `res` never left 0.2‥0.5 of 0‥1 and `cut` never went below 0.5, so
  // the reconstruction filter, which is half of what makes a crusher sound like a machine rather
  // than like distortion, was effectively fixed. The FILTER group exists to move exactly those two.
  crush: [
    { name: "GRIT", sep: true },
    // Under the dry, not instead of it. These are the three with a `mix` you would leave up.
    { name: "Gentle Grit", params: { mix: 0.5, mode: 0, bits: 0.3, rate: 0.2, jitter: 0, cut: 0.9, res: 0.2 } },
    { name: "Vintage Sampler", params: { mix: 1, mode: 2, bits: 0.5, rate: 0.55, jitter: 0, cut: 0.7, res: 0.3 } },
    { name: "Silk Crush", params: { mix: 0.3, mode: 2, bits: 0.12, rate: 0.15, jitter: 0, cut: 0.95, res: 0.15 } },
    { name: "LO-FI", sep: true },
    // A specific old machine. The bit depth sets the era and the DAC filter sets the box it came in.
    { name: "8-Bit", params: { mix: 1, mode: 0, bits: 0.55, rate: 0.35, jitter: 0, cut: 1, res: 0.2 } },
    { name: "Telephone", params: { mix: 1, mode: 2, bits: 0.45, rate: 0.3, jitter: 0, cut: 0.5, res: 0.5 } },
    { name: "Radio Sampler", params: { mix: 0.8, mode: 2, bits: 0.38, rate: 0.45, jitter: 0.15, cut: 0.4, res: 0.6 } },
    { name: "DESTROY", sep: true },
    // Both destroyers at once. TOTAL RUIN is the device at its limits, with jitter on top so the
    // aliasing does not sit still.
    { name: "SR Smash", params: { mix: 1, mode: 0, bits: 0.2, rate: 0.75, jitter: 0, cut: 1, res: 0.3 } },
    { name: "Destroy", params: { mix: 1, mode: 0, bits: 0.85, rate: 0.8, jitter: 0, cut: 1, res: 0.5 } },
    { name: "Total Ruin", params: { mix: 1, mode: 3, bits: 1, rate: 1, jitter: 0.3, cut: 1, res: 0.85 } },
    { name: "CHARACTER", sep: true },
    // The two decimator flavours nothing else uses: ZERO holds at zero between samples (buzz), and
    // JITTER wanders the sample clock (wobble).
    { name: "Zero Buzz", params: { mix: 1, mode: 1, bits: 0.6, rate: 0.4, jitter: 0, cut: 0.85, res: 0.4 } },
    { name: "Jitter Wobble", params: { mix: 1, mode: 3, bits: 0.45, rate: 0.4, jitter: 0.6, cut: 0.9, res: 0.3 } },
    { name: "FILTER", sep: true },
    // The reconstruction filter as the instrument. Barely any crushing in either — RESONANT DAC is
    // a screaming peak at the cutoff, DARK CRUSH just closes the lid.
    { name: "Resonant DAC", params: { mix: 1, mode: 0, bits: 0.25, rate: 0.3, jitter: 0, cut: 0.35, res: 1 } },
    { name: "Dark Crush", params: { mix: 1, mode: 2, bits: 0.35, rate: 0.35, jitter: 0, cut: 0.2, res: 0.1 } },
  ],
  // GATE — a tempo-synced amplitude gate. `rate` is a 0..1 knob quantized to [1/4,1/8,1/8T,1/16,
  // 1/16T,1/32] (0=1/4 … 1=1/32); `shape` (0 SQUARE/1 PLUCK/2 RAMP/3 TRI/4 SINE) is the feel; `depth`
  // = how far it ducks; `duty` = open fraction; `smooth` rounds the edges (declick).
  //
  // ★ MAPPED AGAINST GateFx.registerParams(): `align` (phase-lock the cycle to the bar grid) and
  // `shift` (WHERE in the cycle the grid line falls) were in no preset, and between them they are
  // the entire question of where the gate sits against the beat. A gate that can only land ON the
  // grid can only ever do one thing to a track. OFF-GRID is the group that answers it.
  gate: [
    { name: "CHOPS", sep: true },
    // Square, hard, on the grid, at three speeds. The gate as a rhythm rather than a texture.
    { name: "1/8 Stutter", params: { mix: 1, rate: 0.2, depth: 0.9, duty: 0.5, smooth: 0.1, shape: 0, sync: 1, align: 1, shift: 0 } },
    { name: "1/16 Chop", params: { mix: 1, rate: 0.6, depth: 1, duty: 0.5, smooth: 0.08, shape: 0, sync: 1, align: 1, shift: 0 } },
    { name: "1/32 Machine Gun", params: { mix: 1, rate: 1, depth: 1, duty: 0.5, smooth: 0.05, shape: 0, sync: 1, align: 1, shift: 0 } },
    { name: "TRANCE", sep: true },
    // Mostly open with a shaped dip — the pumping that reads as a sidechain rather than as chopping.
    { name: "Trance Pluck", params: { mix: 1, rate: 0.2, depth: 0.9, duty: 0.8, smooth: 0.2, shape: 1, sync: 1, align: 1, shift: 0 } },
    { name: "Ramp Swell", params: { mix: 1, rate: 0.2, depth: 0.85, duty: 0.8, smooth: 0.2, shape: 2, sync: 1, align: 1, shift: 0 } },
    { name: "Sine Pump", params: { mix: 0.9, rate: 0, depth: 0.7, duty: 0.9, smooth: 0.4, shape: 4, sync: 1, align: 1, shift: 0 } },
    { name: "OFF-GRID", sep: true },
    // Where the cycle sits against the beat. OFFBEAT GATE puts the grid line in the middle of the
    // cycle so the gate closes on the AND; DRIFT GATE unlocks it from the bar entirely, so it
    // slides against the track instead of marching with it.
    { name: "Triplet Gate", params: { mix: 1, rate: 0.4, depth: 0.9, duty: 0.5, smooth: 0.12, shape: 0, sync: 1, align: 1, shift: 0 } },
    { name: "Offbeat Gate", params: { mix: 1, rate: 0.2, depth: 0.95, duty: 0.5, smooth: 0.1, shape: 0, sync: 1, align: 1, shift: 0.5 } },
    { name: "Drift Gate", params: { mix: 1, rate: 0.35, depth: 0.85, duty: 0.55, smooth: 0.18, shape: 3, sync: 1, align: 0, shift: 0 } },
    { name: "SOFT", sep: true },
    // Rounded enough that it reads as movement, not as an edit.
    { name: "Tri Wobble", params: { mix: 1, rate: 0, depth: 0.8, duty: 0.95, smooth: 0.3, shape: 3, sync: 1, align: 1, shift: 0 } },
    { name: "Free Tremolo", params: { mix: 1, rate: 0.45, depth: 0.8, duty: 0.5, smooth: 0.35, shape: 4, sync: 0, align: 1, shift: 0 } },
    { name: "STABS", sep: true },
    // Mostly CLOSED — the inverse of TRANCE. A narrow duty turns the track into short bursts, and
    // REVERSE STAB puts the ramp the other way up so each burst swells into its own edge.
    { name: "Short Stab", params: { mix: 1, rate: 0.6, depth: 1, duty: 0.2, smooth: 0.02, shape: 0, sync: 1, align: 1, shift: 0 } },
    { name: "Reverse Stab", params: { mix: 1, rate: 0.2, depth: 1, duty: 0.3, smooth: 0.06, shape: 2, sync: 1, align: 1, shift: 0.75 } },
  ],
  // NOISE — a riser/uplifter GENERATOR (adds a swept noise layer on top; dry passes through). `type`
  // (0 WHITE/1 PINK/2 TONAL); `rise:1` = tempo-synced auto-build over `bars` (the pad-throw sweeps up),
  // `rise:0` = manual gate you ride by hand at `sweep`. `res` = sweep resonance; `tone` = post brightness.
  //
  // ★ THE WORST MAPPING IN THE BANK — SIX of NoiseFx's params were in no preset at all: `dir` (a
  // riser that goes DOWN is a downlifter, which is the other half of every transition), `curve` (the
  // build's shape), `snap` (quantise the build's END to the bar), `width` (stereo decorrelation),
  // `duck` (pull the DRY down under the build) and `impact` (the hit on release). Half the device
  // could not be reached from its own bank. All twelve state all of them now.
  noise: [
    { name: "RISERS", sep: true },
    // The tempo-synced build. `bars` is the whole identity — you pick the one that fits the phrase
    // you are in, throw it, and it lands on the bar.
    { name: "4-Bar Riser", params: { mix: 0.5, type: 0, sweep: 0.3, res: 0.4, tone: 0.8, rise: 1, bars: 4, dir: 0, curve: 0.5, snap: 1, width: 0, duck: 0, impact: 0 } },
    { name: "8-Bar Build", params: { mix: 0.45, type: 1, sweep: 0.3, res: 0.3, tone: 0.75, rise: 1, bars: 8, dir: 0, curve: 0.5, snap: 1, width: 0, duck: 0, impact: 0 } },
    { name: "2-Bar Lift", params: { mix: 0.5, type: 0, sweep: 0.3, res: 0.5, tone: 0.85, rise: 1, bars: 2, dir: 0, curve: 0.5, snap: 1, width: 0, duck: 0, impact: 0 } },
    { name: "DROPS", sep: true },
    // `dir:1` — the same build, downward. This is what goes UNDER the first bar of the new track
    // while the riser was what went over the last bar of the old one.
    { name: "Downlifter", params: { mix: 0.5, type: 1, sweep: 0.3, res: 0.45, tone: 0.6, rise: 1, bars: 2, dir: 1, curve: 0.3, snap: 1, width: 0.5, duck: 0.3, impact: 0.4 } },
    { name: "Sub Drop", params: { mix: 0.6, type: 2, sweep: 0.25, res: 0.7, tone: 0.3, rise: 1, bars: 1, dir: 1, curve: 0.7, snap: 1, width: 0.3, duck: 0.5, impact: 0.8 } },
    { name: "IMPACT", sep: true },
    // The hit at the END. `impact` fires on release and `duck` clears room for it, which is the
    // difference between a riser that stops and a riser that ARRIVES.
    { name: "1-Bar Snap", params: { mix: 0.55, type: 0, sweep: 0.3, res: 0.5, tone: 0.85, rise: 1, bars: 1, dir: 0, curve: 0.5, snap: 1, width: 0, duck: 0, impact: 0 } },
    { name: "Impact Hit", params: { mix: 0.6, type: 0, sweep: 0.35, res: 0.55, tone: 0.7, rise: 1, bars: 1, dir: 0, curve: 0.8, snap: 1, width: 0.2, duck: 0.7, impact: 1 } },
    { name: "MANUAL", sep: true },
    // `rise:0` — no clock. The sweep is a knob you ride, which is the only way to build over
    // something that is not a whole number of bars away.
    { name: "Manual Sweep", params: { mix: 0.5, type: 0, sweep: 0.5, res: 0.7, tone: 0.9, rise: 0, bars: 4, dir: 0, curve: 0.5, snap: 1, width: 0, duck: 0, impact: 0 } },
    { name: "White Wash", params: { mix: 0.4, type: 0, sweep: 0.1, res: 0.2, tone: 0.7, rise: 0, bars: 4, dir: 0, curve: 0.5, snap: 1, width: 0, duck: 0, impact: 0 } },
    { name: "Pink Air", params: { mix: 0.35, type: 1, sweep: 0.6, res: 0.3, tone: 0.6, rise: 0, bars: 4, dir: 0, curve: 0.5, snap: 1, width: 0, duck: 0, impact: 0 } },
    { name: "TEXTURE", sep: true },
    // A layer rather than a gesture. WIDE AIR is the only preset that decorrelates the two channels
    // and the only one with `snap:0` — it is not landing on anything, so it need not.
    { name: "Tonal Uplifter", params: { mix: 0.5, type: 2, sweep: 0.3, res: 0.6, tone: 0.8, rise: 1, bars: 4, dir: 0, curve: 0.5, snap: 1, width: 0, duck: 0, impact: 0 } },
    { name: "Wide Air", params: { mix: 0.35, type: 1, sweep: 0.45, res: 0.25, tone: 0.65, rise: 0, bars: 4, dir: 0, curve: 0.5, snap: 0, width: 1, duck: 0.4, impact: 0 } },
  ],
  // EQ — the per-deck parametric channel EQ (Eq3). No `mix` in its param bus; gains are dB in the
  // ASYMMETRIC DJ range −26…+6 (big cuts, modest boosts). `*Shape` sets each band's filter (0 BELL/
  // 1 LO-SH/2 HI-SH/3 NOTCH); `hpFreq`/`lpFreq` are the sweepable cut filters (parked at 20/20000 = off).
  // EQ — the channel EQ, and (since it took the 8th FX pad) a PERFORMANCE curve. These are all
  // THROWS: hold the pad, the curve slams in; let go, your ride comes back. So every one of them
  // is a gesture you'd hear from the back of the room — not a mastering nudge. (The first bank was
  // 5 tone-shaping curves averaging ±3 dB; on a pad that's a dead button.)
  //   • band gains reach ±40/+12 now, so a "kill" is a real kill (the low shelf at −40 is GONE).
  //   • `out` is the curve's own output trim: a preset that guts half the spectrum pays itself
  //     back here, so throws land at roughly the level you left. Values below are measured in
  //     fxlab against a full-scale tone, not guessed.
  //   • shapes: 0 = bell, 1 = low-shelf, 2 = high-shelf, 3 = notch.
  eq: [
    // ★ THE DEFAULT ARRANGEMENT, grouped by WHAT YOU ARE DOING when you reach for it — not by which
    // filter it happens to use. Seven headings of two to four, so the menu opens as seven rows you
    // can read at a glance and each section's window is one look rather than a scroll. It was six
    // groups where the last one held ten, which is a list with a lid on it. This is the arrangement
    // a user INHERITS and can then rearrange freely; nothing here is binding.
    { name: "MIX & SWAP", sep: true },
    // The transition itself — what you hold down while two tracks are playing. The two KILLS are the
    // classic swap; the SPLIT pair is the same idea done as a frequency divide, one preset per deck,
    // summing back to roughly the original.
    { name: "Bass Kill", params: { low: -40, mid: 0, high: 0, lowFreq: 90, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    { name: "High Kill", params: { low: 0, mid: 0, high: -40, lowFreq: 200, midFreq: 1000, highFreq: 6000, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    { name: "Split Low", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 900, lpQ: 0.7, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 1 } },
    { name: "Split High", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 900, hpQ: 0.7, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 1 } },
    { name: "TONE MATCH", sep: true },
    // Making a bright track and a dark one sit together. The smallest moves in the bank and the ones
    // you reach for most — nothing here removes anything, it only leans.
    { name: "Tilt Warm", params: { low: 4, mid: 0, high: -4, lowFreq: 250, midFreq: 1000, highFreq: 4000, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: -0.5 } },
    { name: "Tilt Bright", params: { low: -4, mid: 0, high: 4, lowFreq: 250, midFreq: 1000, highFreq: 4000, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: -0.5 } },
    { name: "Mud Cut", params: { low: 0, mid: -8, high: 0, lowFreq: 200, midFreq: 300, highFreq: 3200, midQ: 1.6, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0.5 } },
    { name: "CLEAN UP", sep: true },
    // Fixing the FILE, not the mix. Boring on purpose, and the only presets here you would leave on
    // for a whole track rather than throw and undo.
    { name: "Rumble Guard", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 35, hpQ: 0.5, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    { name: "Tame Harsh", params: { low: 0, mid: -7, high: 0, lowFreq: 200, midFreq: 3800, highFreq: 3200, midQ: 3, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0.5 } },
    { name: "De-Cymbal", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 9000, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 3, lowQ: 1, highQ: 5, out: 0 } },
    { name: "VOICES", sep: true },
    // Anything aimed at a vocal. TELEPHONE is the wide band-limit, RADIO the tight one, and VOCAL
    // FOCUS is the opposite move — clear the rumble and push the presence instead of narrowing.
    { name: "Telephone", params: { low: 0, mid: 6, high: 0, lowFreq: 200, midFreq: 1500, highFreq: 3200, midQ: 1, hpFreq: 500, hpQ: 0.9, lpFreq: 3000, lpQ: 0.9, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    { name: "Radio", params: { low: 0, mid: 5, high: 0, lowFreq: 200, midFreq: 1400, highFreq: 3200, midQ: 2, hpFreq: 800, hpQ: 1.5, lpFreq: 2200, lpQ: 1.5, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 1.5 } },
    { name: "Vocal Focus", params: { low: 0, mid: 5, high: 2, lowFreq: 200, midFreq: 2600, highFreq: 8000, midQ: 1.4, hpFreq: 180, hpQ: 0.7, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: -1 } },
    { name: "PARKS", sep: true },
    // A resonant cutoff dropped on the track and HELD there. Both live on the sweepable HP/LP cuts,
    // where the resonance is doing as much work as the cutoff.
    { name: "Sub Drop", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 320, lpQ: 5, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 2 } },
    { name: "Riser", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 1000, hpQ: 8, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    { name: "HOLLOW", sep: true },
    // Take something out of the middle and leave the ends. MID SCOOP is the broad version, DEEP NOTCH
    // the surgical one, KICK NOTCH the one that goes after a single drum and leaves the sub under it.
    { name: "Mid Scoop", params: { low: 0, mid: -14, high: 0, lowFreq: 200, midFreq: 800, highFreq: 3200, midQ: 0.7, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 2, lowQ: 1, highQ: 1, out: 1 } },
    { name: "Deep Notch", params: { low: 0, mid: 0, high: 0, lowFreq: 200, midFreq: 1000, highFreq: 3200, midQ: 1.2, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 3, highShape: 2, lowQ: 1, highQ: 1, out: 0 } },
    { name: "Kick Notch", params: { low: 0, mid: 0, high: 0, lowFreq: 120, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 3, midShape: 0, highShape: 2, lowQ: 4, highQ: 1, out: 0 } },
    { name: "LIFTS", sep: true },
    // The two BELL boosts — the band shapes nothing else uses. A shelf turns a whole end of the
    // spectrum up; these put a resonant bump at one spot and pay for it with the output trim.
    { name: "Sub Bump", params: { low: 12, mid: 0, high: 0, lowFreq: 60, midFreq: 1000, highFreq: 3200, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 0, midShape: 0, highShape: 2, lowQ: 2.5, highQ: 1, out: -3 } },
    { name: "Air Lift", params: { low: 0, mid: 0, high: 12, lowFreq: 200, midFreq: 1000, highFreq: 11000, midQ: 0.9, hpFreq: 20, hpQ: 0.3, lpFreq: 20000, lpQ: 0.3, lowShape: 1, midShape: 0, highShape: 0, lowQ: 1, highQ: 1.2, out: -1 } },
  ],
};

/** The built-in factory bank for an effect kind (read-only; [] if none seeded yet). */
export function factoryFxRows(kind: string): FxRow[] {
  return foldRows(kind === CHAIN_KIND ? FACTORY_CHAINS : (FACTORY_PRESETS[kind] ?? []));
}
/** The factory bank's PRESETS alone — the shape every existing caller wants. */
export function factoryFxPresets(kind: string): FxPreset[] {
  return leavesOf(factoryFxRows(kind)).filter((r): r is FxPreset => !isRef(r) && "params" in r);
}

const KEY = (kind: string) => `htl:fxpreset:${kind}`;

/** The bank's PRESETS alone, resolved and in arrangement order. */
export function loadFxPresets(kind: string): FxPreset[] {
  return leavesOf(resolveFxRows(kind))
    .map((r) => presetOf(kind, r))
    .filter((p): p is FxPreset => !!p);
}

/** Find a leaf by the name it presents, ref or owned. */
function pathOfName(rows: FxRow[], name: string): FxPath | null {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (isGroup(r)) {
      const j = r.items.findIndex((l) => leafName(l) === name);
      if (j >= 0) return [i, j];
    } else if (leafName(r) === name) return [i];
  }
  return null;
}

/** Save the current settings under a name. A same-name row is REPLACED IN PLACE rather than dropped
 *  and re-appended — once the list has an order you chose, overwriting must not also move it. */
export function saveFxPreset(kind: string, name: string, params: Record<string, number>): FxPreset[] {
  const clean = name.trim();
  if (!clean) return loadFxPresets(kind);
  const rows = ensureArrangement(kind);
  const path = pathOfName(rows, clean);
  if (path) {
    if (path.length === 1) rows[path[0]] = { name: clean, params };
    else (rows[path[0]] as FxGroup).items[path[1]] = { name: clean, params };
  } else rows.push({ name: clean, params });
  saveFxRows(kind, rows);
  return loadFxPresets(kind);
}

export function renameFxPreset(kind: string, oldName: string, newName: string): FxPreset[] {
  const clean = newName.trim();
  if (!clean) return loadFxPresets(kind);
  const path = pathOfName(ensureArrangement(kind), oldName);
  // Renaming a factory preset materialises it: the name is part of what you are changing, and the
  // shipped one keeps its own so a revert still has something to point at.
  if (path) materialiseFxRow(kind, path, { name: clean });
  return loadFxPresets(kind);
}

export function deleteFxPreset(kind: string, name: string): FxPreset[] {
  const path = pathOfName(ensureArrangement(kind), name);
  if (path) deleteFxRow(kind, path);
  return loadFxPresets(kind);
}

export interface ChainPreset {
  name: string;
  stems: number;
  kinds: string[];
}

// ★ THE CHAIN BANK IS A BANK. It was a flat array under its own key with its own four functions —
// yours, then a separate read-only factory block, no sections, no reordering, no revert — which is
// exactly the model the effect banks left behind. It is a `kind` in the arrangement engine now
// (CHAIN_KIND), so it inherits sections, drag order, references, tombstones, revert and
// restore-factory from the same code, and every rule proved on the preset menu applies here by
// construction rather than by being ported again.
export const CHAIN_KIND = "chain";

// Each names the stems by mask (1=DRUM 2=BASS 4=VOICE 8=INST) and the devices in signal order.
// Grouped by WHICH PART OF THE TRACK you are treating, which is how anyone picks a stem chain.
export const FACTORY_CHAINS: (FxLeaf | FxSep)[] = [
  { name: "DRUMS", sep: true },
  { name: "Drum Chop", stems: 1, kinds: ["gate", "crush"] },
  { name: "Drum Glue", stems: 1, kinds: ["comp", "saturator"] },
  { name: "BASS", sep: true },
  { name: "Bass Grit", stems: 2, kinds: ["saturator", "comp"] },
  { name: "Bass Tight", stems: 2, kinds: ["comp", "eq"] },
  { name: "VOCALS", sep: true },
  { name: "Vocal Air", stems: 4, kinds: ["reverb", "delay"] },
  { name: "Vocal Throw", stems: 4, kinds: ["delay", "mod"] },
  { name: "Acapella Filter", stems: 4, kinds: ["eq"] },
  { name: "MUSIC", sep: true },
  { name: "Music Wash", stems: 8, kinds: ["reverb", "mod"] },
  { name: "Music Crush", stems: 8, kinds: ["crush", "eq"] },
  { name: "EVERYTHING ELSE", sep: true },
  { name: "Everything But Drums", stems: 0b1110, kinds: ["gate"] },
  { name: "Build Bus", stems: 0b1110, kinds: ["noise", "reverb"] },
];

/** The chain bank's rows, resolved — sections, refs, tombstones and all. */
export function chainRows(): FxRow[] {
  migrateChains();
  return resolveFxRows(CHAIN_KIND);
}
export function factoryChainPresets(): ChainPreset[] {
  return leavesOf(factoryFxRows(CHAIN_KIND)).filter((r): r is ChainPreset => !isRef(r) && "kinds" in r);
}

// ★ THE OLD KEY, READ ONCE. Saved chains lived in a bare array at `htl:chainpresets`; the bank
// lives at the same `htl:fxpreset:<kind>` every effect uses. Migrating on read (not on write) means
// a user who never opens the chain menu still keeps their chains, and the old key is left in place
// rather than deleted — a migration that destroys its own source cannot be re-run or inspected.
const OLD_CHAIN_KEY = "htl:chainpresets";
let migrated = false;
function migrateChains() {
  if (migrated) return;
  migrated = true;
  try {
    if (loadFxBank(CHAIN_KIND).rows.length) return; // already a bank
    const raw = localStorage.getItem(OLD_CHAIN_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    const mine: FxRow[] = (Array.isArray(arr) ? arr : []).filter(validLeaf).map((p) => p as FxLeaf);
    if (!mine.length) return;
    // Theirs first, then the shipped arrangement — the same order resolve() gives a legacy bank.
    saveFxBank(CHAIN_KIND, { rows: [...mine, ...factoryFxRows(CHAIN_KIND)], gone: [] });
  } catch {
    /* unreadable old key — the factory arrangement is a fine place to start */
  }
}

/** Every chain preset the bank holds, resolved and in arrangement order — the shape the old flat
 *  API returned, so callers that only want a list are unchanged. */
export function loadChainPresets(): ChainPreset[] {
  return leavesOf(chainRows())
    .map(chainOf)
    .filter((p): p is ChainPreset => !!p);
}

export function saveChainPreset(name: string, stems: number, kinds: string[]): ChainPreset[] {
  const clean = name.trim();
  if (!clean) return loadChainPresets();
  const rows = ensureArrangement(CHAIN_KIND);
  const body: FxLeaf = { name: clean, stems, kinds: [...kinds] };
  const at = pathOfName(rows, clean); // overwrite a same-name preset, wherever it sits
  if (at) {
    if (at.length === 1) rows[at[0]] = body;
    else (rows[at[0]] as FxGroup).items[at[1]] = body;
  } else rows.push(body);
  saveFxRows(CHAIN_KIND, rows);
  return loadChainPresets();
}

export function deleteChainPreset(name: string): ChainPreset[] {
  const at = pathOfName(ensureArrangement(CHAIN_KIND), name);
  if (at) deleteFxRow(CHAIN_KIND, at);
  return loadChainPresets();
}

export function renameChainPreset(oldName: string, newName: string): ChainPreset[] {
  const clean = newName.trim();
  const at = pathOfName(ensureArrangement(CHAIN_KIND), oldName);
  // materialiseFxRow is the rename: a factory chain renamed becomes YOURS, and the shipped one
  // keeps its own name so a revert still has something to point at.
  if (clean && at) materialiseFxRow(CHAIN_KIND, at, { name: clean });
  return loadChainPresets();
}
