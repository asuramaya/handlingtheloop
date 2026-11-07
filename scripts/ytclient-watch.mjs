#!/usr/bin/env node
// YTCLIENT-WATCH — the tripwire on xxit's ONLY streaming client, run instead of remembered.
//
// server/youtube.ts's CLIENT_CASCADE is literally [CLIENTS.VISIONOS]: one entry, no eligible second
// client. If YouTube gates that client the way it gated ANDROID_VR, streaming stops and the answer
// is a design change (a cipher/JS-player path, or a PO-token provider), not "add a client". So the
// early warning is worth having, and thread 6c430b35 has carried it as a MANUAL check — which had
// gone five days without one, because a watch that depends on somebody remembering is a watch that
// decays.
//
// WHAT IT COMPARES, and both sides are DERIVED so neither can go stale:
//   • upstream  — yt-dlp master's INNERTUBE_CLIENTS['visionos'] block, fetched
//   • ours      — the pinned constants parsed out of server/youtube.ts
//
// THREE WAYS THIS FIRES, and the third is the one the manual check could not have caught:
//   1. GVS_PO_TOKEN_POLICY appears on the entry        → the gate we fear
//   2. REQUIRE_JS_PLAYER becomes True                  → a JS player is now required
//   3. our pinned version/UA/device fields DRIFT from upstream's → YouTube may already be rejecting
//      what we send, with neither flag having moved. Found by doing the check by hand on
//      2026-09-22: the two flags are not the whole exposure.
//   4. a field becomes UNREADABLE on either side → the watch has gone blind and says so. A checker
//      that goes quiet when it loses sight of its subject is worse than no checker, because the
//      silence reads as health.
//   5. the ELIGIBLE-CLIENT SET changes in EITHER direction → added 2026-10-31. Shrinking means no
//      client is left; GROWING means a real fallback finally exists and CLIENT_CASCADE should stop
//      being one rung. server/youtube.ts used to carry that roster as a comment and it went stale
//      twice, the conclusion holding both times — so the roster is derived here now and the comment
//      defers to this script. Also fires if the table parse comes back implausibly small, because
//      an under-parse of this table does not read as broken: it reads as "ELIGIBLE: NOBODY".
//
//   node scripts/ytclient-watch.mjs           # exit 0 = quiet, 1 = something to read
//   node scripts/ytclient-watch.mjs --json
//   YTCLIENT_WATCH_SRC=http://… node scripts/ytclient-watch.mjs   # plant against the fire paths

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_base.py";
// A TRIPWIRE YOU CANNOT PLANT AGAINST IS A TRIPWIRE YOU ARE TAKING ON TRUST, and the fire paths
// here are by construction never exercised by a real run — a quiet run proves only that the quiet
// branch works. YTCLIENT_WATCH_SRC points the fetch at a mutated copy so each firing condition can
// be made to happen on purpose. It is recorded on the receipt whenever it is set, so a planted run
// can never be mistaken afterwards for a reading of yt-dlp master.
const SRC = process.env.YTCLIENT_WATCH_SRC || UPSTREAM;
const HERE = dirname(fileURLToPath(import.meta.url));
const OURS = resolve(HERE, "..", "server", "youtube.ts");

/** The visionos entry, sliced from the INNERTUBE_CLIENTS table by brace depth (no Python parser).
 *  Braces inside STRING VALUES are skipped — a UA or device string containing one would otherwise
 *  throw the depth count off and return the wrong block, which is the failure mode that looks like
 *  a successful read (Metron's note on 60b7f28). */
function visionosBlock(py) {
  const at = py.indexOf("'visionos':");
  if (at === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = py.indexOf("{", at); i < py.length; i++) {
    const c = py[i];
    if (quote) {
      if (c === "\\") i++; // escaped char inside the string — skip it
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return py.slice(at, i + 1);
  }
  return null;
}

/** The WHOLE INNERTUBE_CLIENTS table, name -> block, sliced by the same brace-depth/quote-aware
 *  scan visionosBlock uses. Full-line Python comments are stripped first: the table carries
 *  `# mweb has 'ultralow' formats`, and one apostrophe in a comment would open a string the scanner
 *  never closes, swallowing every key after it — a parse that fails by returning FEWER clients,
 *  which is exactly the shape that reads as a successful run. */
function clientTable(py) {
  const src = py.replace(/^[ \t]*#.*$/gm, "");
  const at = src.indexOf("INNERTUBE_CLIENTS = {");
  if (at === -1) return null;
  const out = new Map();
  let depth = 0;
  let quote = null;
  let name = null;
  let blockStart = -1;
  for (let i = src.indexOf("{", at); i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      if (depth === 1 && name === null) {
        let j = i + 1;
        let s = "";
        for (; j < src.length; j++) {
          if (src[j] === "\\") { j++; continue; }
          if (src[j] === c) break;
          s += src[j];
        }
        if (/^:\s*\{/.test(src.slice(j + 1, j + 5))) name = s;
        i = j;
        continue;
      }
      quote = c;
      continue;
    }
    if (c === "{") { if (++depth === 2 && name !== null) blockStart = i; continue; }
    if (c === "}") {
      if (--depth === 1 && name !== null) { out.set(name, src.slice(blockStart, i + 1)); name = null; }
      if (depth === 0) break;
    }
  }
  return out;
}

const pick = (src, re) => src.match(re)?.[1] ?? null;

const ours = readFileSync(OURS, "utf8");
const mine = {
  version: pick(ours, /const VISIONOS_VERSION = "([^"]+)"/),
  ua: pick(ours, /const VISIONOS_UA =\s*\n?\s*"([^"]+)"/),
  deviceModel: pick(ours, /deviceModel: "(RealityDevice[^"]*)"/),
  osVersion: pick(ours, /osName: "visionOS", osVersion: "([^"]+)"/),
};

const res = await fetch(SRC);
if (!res.ok) {
  console.error(`ytclient-watch: could not fetch upstream (${res.status}). NOT a pass — try again.`);
  process.exit(1);
}
const py = await res.text();
const block = visionosBlock(py);
if (!block) {
  console.error("ytclient-watch: ★ the 'visionos' entry is GONE from yt-dlp master. That is the loudest possible signal.");
  process.exit(1);
}

const up = {
  version: pick(block, /'clientVersion':\s*'([^']+)'/),
  ua: pick(block, /'userAgent':\s*'([^']+)'/),
  deviceModel: pick(block, /'deviceModel':\s*'([^']+)'/),
  osVersion: pick(block, /'osVersion':\s*'([^']+)'/),
};
const poToken = /GVS_PO_TOKEN_POLICY/.test(block);
const requiresJs = /'REQUIRE_JS_PLAYER':\s*True/.test(block);
const jsKeyPresent = /'REQUIRE_JS_PLAYER'/.test(block);

// ★ A WATCH THAT CANNOT SEE ITS SUBJECT MUST FIRE. The first version excluded a null from `drift`
// (`mine[k] && up[k] && …`), so a regex that stopped matching server/youtube.ts produced null,
// null was not a drift, and the script exited 0 — while PRINTING "★ DRIFT ours null". Two
// instruments, opposite answers, neither wrong by its own code, and the exit code is the half a cron
// reads. Worse, when a field went unreadable on BOTH sides, `null === null` printed "matches".
// Caught by Metron on review and reproduced against an unmodified copy of the script.
//
// This is the same category as the fetch failure and the missing upstream entry, both of which the
// first version already refused to treat as a pass — and it is the LIKELIER event, because nobody
// edits youtube.ts intending to blind the watch. WHICH side went unreadable is reported, because
// "ours" means our file moved and "upstream" means yt-dlp's table changed shape: different
// problems, different next steps.
const unreadable = Object.keys(mine).filter((k) => !mine[k] || !up[k]);
const drift = Object.keys(mine).filter((k) => mine[k] && up[k] && mine[k] !== up[k]);

// ★ THE FIFTH CONDITION: WHO ELSE IS ELIGIBLE — DERIVED, because the pinned copy of this roster
// drifted twice. server/youtube.ts carried the two sets as a comment, which 9523844 corrected on
// 2026-09-09 after it had gone stale, under a line admitting "the roster is a closed-world claim
// and a reader counts candidates off it". By 2026-10-31 it was stale AGAIN — upstream had grown a
// 14th client, `tv_samsung`, un-gated but JS-player-bound. The conclusion held both times, so a
// reader checking only the conclusion saw nothing wrong, and that is the whole problem: the
// CONCLUSION is what the comment is for, and it was being underwritten by a roster nobody re-derived.
// So the roster lives here now and the comment points at this script. Same move as the receipt:
// the fix for a fact that decays is not a more careful author, it is deriving it on every run.
//
// WHAT FIRES, and it is only the intersection:
//   • eligible set SHRINKS below {visionos} → streaming has no client at all
//   • eligible set GROWS → ★ GOOD news, and the kind a quiet watch would bury: a genuine second
//     rung exists and CLIENT_CASCADE (one entry) should get it. A watch that only fires on bad
//     news cannot tell you the architectural question has stopped being architectural.
// The two INPUT sets are printed and recorded every run but do NOT fire: `tv_samsung` appearing
// changes neither the conclusion nor the exposure, and a watch that exits non-zero on every
// upstream addition gets ignored, which costs more than the staleness it was guarding.
const NEEDS = { js: "'REQUIRE_JS_PLAYER': False", po: "GVS_PO_TOKEN_POLICY" };
const EXPECTED_ELIGIBLE = ["visionos"];
const table = clientTable(py);
// A parse that returns too little looks like a clean answer. The table has carried 13-14 clients
// across every check on this thread; anything under 10 means the scan lost the table, not that
// YouTube deleted it.
const tableBlind = !table || table.size < 10;
const noJs = tableBlind ? [] : [...table].filter(([, v]) => v.includes(NEEDS.js)).map(([k]) => k).sort();
const noPo = tableBlind ? [] : [...table].filter(([, v]) => !v.includes(NEEDS.po)).map(([k]) => k).sort();
const eligible = noJs.filter((k) => noPo.includes(k));
const rosterChanged = !tableBlind
  && (eligible.length !== EXPECTED_ELIGIBLE.length || eligible.some((k, i) => k !== EXPECTED_ELIGIBLE[i]));
if (tableBlind) unreadable.push("INNERTUBE_CLIENTS table");

const fired = poToken || requiresJs || drift.length > 0 || unreadable.length > 0 || rosterChanged;

// ★ THE RECEIPT, because the thread's own "Last checked 2026-09-17" is a hand-written date and this
// script exists precisely because hand-written watch state decays. `--record` writes what the run
// actually found, next to the script, so the next reader learns WHEN it last ran and WHAT it said
// from the run itself rather than from somebody's memory of it.
//
// Deliberately NOT wired into the test gate. A staleness check that fails `pnpm test` would block a
// deploy on a non-problem at the worst possible moment, and deploy.sh runs the suite as its own
// pre-deploy gate — a watch that breaks deploys is a worse instrument than one that decays. The
// receipt is for reading; firing is still what exits non-zero.
if (process.argv.includes("--record")) {
  const receipt = { when: new Date().toISOString(), ...(SRC === UPSTREAM ? {} : { plantedSource: SRC }), fired, poToken, requiresJs, jsKeyPresent, drift, unreadable, rosterChanged, eligible, noJs, noPo, clients: table ? table.size : 0, ours: mine, upstream: up };
  writeFileSync(resolve(HERE, "ytclient-watch.last.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`  recorded → scripts/ytclient-watch.last.json (${fired ? "FIRED" : "quiet"}, ${receipt.when})`);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ fired, poToken, requiresJs, jsKeyPresent, drift, unreadable, rosterChanged, eligible, noJs, noPo, clients: table ? table.size : 0, ours: mine, upstream: up }, null, 2));
  process.exit(fired ? 1 : 0);
}

console.log("\n  YTCLIENT-WATCH — yt-dlp master, INNERTUBE_CLIENTS['visionos'] (thread 6c430b35)\n");
console.log(`   GVS_PO_TOKEN_POLICY   ${poToken ? "★ PRESENT — the gate we fear" : "absent"}`);
console.log(`   REQUIRE_JS_PLAYER     ${requiresJs ? "★ True — a JS player is now required" : jsKeyPresent ? "False (key present — a flip is one word)" : "absent"}`);
for (const k of Object.keys(mine)) {
  const blind = !mine[k] || !up[k];
  const where = !mine[k] && !up[k] ? "BOTH sides" : !mine[k] ? "OURS (server/youtube.ts moved)" : "UPSTREAM (yt-dlp's table changed shape)";
  const verdict = blind
    ? `★ UNREADABLE — ${where}. This watch cannot answer for this field.`
    : mine[k] === up[k]
      ? "matches"
      : `★ DRIFT  ours ${JSON.stringify(mine[k])}  upstream ${JSON.stringify(up[k])}`;
  console.log(`   ${k.padEnd(12)}          ${verdict}`);
}
if (tableBlind) {
  console.log(`\n   eligible clients     ★ UNREADABLE — parsed ${table ? table.size : 0} clients from INNERTUBE_CLIENTS. The scan lost the table; this run proves nothing about who else is eligible.`);
} else {
  console.log(`\n   REQUIRE_JS_PLAYER: False  →  ${noJs.join(", ")}`);
  console.log(`   no GVS_PO_TOKEN_POLICY    →  ${noPo.join(", ")}`);
  console.log(
    `   ELIGIBLE (both)           →  ${eligible.join(", ") || "NOBODY"}${
      rosterChanged
        ? eligible.length > EXPECTED_ELIGIBLE.length
          ? "   ★ GREW — a real second rung exists. CLIENT_CASCADE has one entry; this is the good news this watch was also built to catch."
          : "   ★ SHRANK — xxit has no eligible streaming client."
        : "   (unchanged — visionos alone)"
    }`,
  );
  console.log(`   (${table.size} clients in the table, derived this run — not a pinned list)`);
}

const verdict = fired
  ? unreadable.length && !poToken && !requiresJs && !drift.length && !rosterChanged
    ? "CANNOT ANSWER — a field went unreadable, so this run proves nothing about the fields it could not read. Fix the watch, then re-run."
    : "SOMETHING TO READ — see above. CLIENT_CASCADE has ONE entry, so this is a design question, not a config change."
  : "QUIET — no gate, no drift, every field readable. Nothing to do.";
console.log(`\n  ${verdict}\n`);
process.exit(fired ? 1 : 0);
