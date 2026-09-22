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
//
//   node scripts/ytclient-watch.mjs           # exit 0 = quiet, 1 = something to read
//   node scripts/ytclient-watch.mjs --json

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_base.py";
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
const block = visionosBlock(await res.text());
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
const fired = poToken || requiresJs || drift.length > 0 || unreadable.length > 0;

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
  const receipt = { when: new Date().toISOString(), fired, poToken, requiresJs, jsKeyPresent, drift, unreadable, ours: mine, upstream: up };
  writeFileSync(resolve(HERE, "ytclient-watch.last.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`  recorded → scripts/ytclient-watch.last.json (${fired ? "FIRED" : "quiet"}, ${receipt.when})`);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ fired, poToken, requiresJs, jsKeyPresent, drift, unreadable, ours: mine, upstream: up }, null, 2));
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
const verdict = fired
  ? unreadable.length && !poToken && !requiresJs && !drift.length
    ? "CANNOT ANSWER — a field went unreadable, so this run proves nothing about the fields it could not read. Fix the watch, then re-run."
    : "SOMETHING TO READ — see above. CLIENT_CASCADE has ONE entry, so this is a design question, not a config change."
  : "QUIET — no gate, no drift, every field readable. Nothing to do.";
console.log(`\n  ${verdict}\n`);
process.exit(fired ? 1 : 0);
