// WHAT POPULATION DOES THE BOTH-DECK SCAN DRAW FROM, AND WHAT POPULATION IS ITS INVARIANT ABOUT?
//
// src/App/bothDeckActionScan.test.ts has been widened seven times (ae3aed5, 35575b5, …). Each
// widening was correct and each found something real. The thread (ba5eb70e) records that turn seven
// was the first where the LOOP ITSELF was invisible, and that the two statements above App.tsx:1446
// do the same thing to both decks with no loop at all — "which no loop-shaped scan can ever catch".
//
// That is a statement about POPULATIONS, and populations are countable. This counts them.
//
// RUN IT, DO NOT REMEMBER IT: the numbers move with the file, and a remembered number is how the
// last four of these went wrong. `node scripts/deckscan/coverage.mjs`
//
// ★ WHAT THIS DOES NOT SAY, stated first because the aggregate invites it: the ungated count is NOT
// a defect count. The snapshot appliers must be ungated BY CONSTRUCTION — they apply authority
// received from the room, they do not exercise it, and a follower that refused them would stop
// following. The number measures INSTRUMENT COVERAGE, not defects.

import { readFileSync } from "node:fs";

const app = readFileSync("src/App.tsx", "utf8");
const deckSrc = readFileSync("src/htl/audio/Deck.ts", "utf8");

/** Deck's public writers, by the class's own declaration — `get`/`readonly` is a read, the rest
 *  is a write. Same derivation the scan under test uses, deliberately: a different one here would
 *  be measuring a different instrument. */
function deckWriters() {
  const body = deckSrc.slice(deckSrc.indexOf("export class Deck"));
  const out = new Set();
  for (const m of body.matchAll(/^  (?!private |protected |\/\/|\*|\/\*)(readonly\s+|get\s+|set\s+)?([a-zA-Z_]\w*)\s*[(=:]/gm)) {
    const [, kind, name] = m;
    if (name === "constructor" || kind?.startsWith("get") || kind?.startsWith("readonly")) continue;
    out.add(name);
  }
  return [...out];
}

/** Identifiers App.tsx binds to a deck, plus the inline `engine.deck(id).` form. */
function receivers() {
  const r = new Set(["deck"]);
  for (const m of app.matchAll(/(?:const|let)\s+(\w+)\s*=\s*\w+\.(?:deck\s*\([^)]*\)|deckA|deckB)/g)) r.add(m[1]);
  for (const m of app.matchAll(/\(\s*(\w+)\s*:\s*DeckRef/g)) r.add(m[1]);
  for (const m of app.matchAll(/for \((?:const|let) (\w+) of \[\s*\w+\.deckA\s*,\s*\w+\.deckB\s*\]\)/g)) r.add(m[1]);
  return [...r];
}

const lines = app.split("\n");
const owners = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*[:=]/);
  if (m) owners.push({ line: i + 1, name: m[1] || m[2] });
}
const ownerOf = (n) => {
  let o = "(top level)";
  for (const x of owners) {
    if (x.line <= n) o = x.name;
    else break;
  }
  return o;
};

const W = deckWriters();
const R = receivers();
const TOUCH = "\\s*(?:\\(|=(?!=))"; // `===` is not an assignment — the scan learned this the hard way
const sites = [];
for (let i = 0; i < lines.length; i++) {
  const L = lines[i];
  for (const w of W) {
    const inline = new RegExp(`\\w+\\.deck(?:\\s*\\([^)]*\\)|A|B)\\.${w}${TOUCH}`);
    if (inline.test(L) || R.some((r) => new RegExp(`\\b${r}\\.${w}${TOUCH}`).test(L))) {
      sites.push({ line: i + 1, w, owner: ownerOf(i + 1) });
      break;
    }
  }
}

// The loops the scan under test actually examines — its whole population.
const loopForms = [
  /\(\["A",\s*"B"\][^)]*\)\.forEach\(\((\w+)\)\s*=>\s*/g,
  /for \((?:const|let) (\w+) of \(?\["A",\s*"B"\][^)]*\)?\)\s*/g,
  /for \((?:const|let) (\w+) of \[\s*\w+\.deckA\s*,\s*\w+\.deckB\s*\]\)\s*/g,
];
let loops = 0;
for (const re of loopForms) for (let m = re.exec(app); m; m = re.exec(app)) loops++;

const by = {};
for (const s of sites) (by[s.owner] ||= []).push(s);

console.log(`Deck public writers declared        ${String(W.length).padStart(4)}`);
console.log(`deck-mutation sites in App.tsx      ${String(sites.length).padStart(4)}`);
console.log(`both-deck LOOPS the scan examines   ${String(loops).padStart(4)}   <- its entire population\n`);
console.log("sites  owner");
for (const [o, hs] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${String(hs.length).padStart(5)}  ${o}`);
}
console.log(
  "\nThe appliers (applyDeckRack / applyDeckControls / applyDeckStems) MUST stay ungated: they write\n" +
    "the room's authoritative state into this device's decks. A drive-permission guard at the MUTATOR\n" +
    "would refuse them and a follower would stop following — so drive permission is a property of the\n" +
    "CALLER'S INTENT (originating a change vs applying one received), which is not a fact about the\n" +
    "deck, the method, or the syntax around it. deckSnapshot's sites are read-only methods the\n" +
    "writer split cannot tell from writes; it errs loud, by design.",
);
