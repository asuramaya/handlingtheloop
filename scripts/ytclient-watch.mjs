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
//
//   node scripts/ytclient-watch.mjs           # exit 0 = quiet, 1 = something to read
//   node scripts/ytclient-watch.mjs --json

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = "https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/yt_dlp/extractor/youtube/_base.py";
const OURS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "server", "youtube.ts");

/** The visionos entry, sliced from the INNERTUBE_CLIENTS table by brace depth (no Python parser). */
function visionosBlock(py) {
  const at = py.indexOf("'visionos':");
  if (at === -1) return null;
  let depth = 0;
  for (let i = py.indexOf("{", at); i < py.length; i++) {
    if (py[i] === "{") depth++;
    else if (py[i] === "}" && --depth === 0) return py.slice(at, i + 1);
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

const drift = Object.keys(mine).filter((k) => mine[k] && up[k] && mine[k] !== up[k]);
const fired = poToken || requiresJs || drift.length > 0;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ fired, poToken, requiresJs, jsKeyPresent, drift, ours: mine, upstream: up }, null, 2));
  process.exit(fired ? 1 : 0);
}

console.log("\n  YTCLIENT-WATCH — yt-dlp master, INNERTUBE_CLIENTS['visionos'] (thread 6c430b35)\n");
console.log(`   GVS_PO_TOKEN_POLICY   ${poToken ? "★ PRESENT — the gate we fear" : "absent"}`);
console.log(`   REQUIRE_JS_PLAYER     ${requiresJs ? "★ True — a JS player is now required" : jsKeyPresent ? "False (key present — a flip is one word)" : "absent"}`);
for (const k of Object.keys(mine)) {
  const same = mine[k] === up[k];
  console.log(`   ${k.padEnd(12)}          ${same ? "matches" : `★ DRIFT  ours ${JSON.stringify(mine[k])}  upstream ${JSON.stringify(up[k])}`}`);
}
console.log(`\n  ${fired ? "SOMETHING TO READ — see above. CLIENT_CASCADE has ONE entry, so this is a design question, not a config change." : "QUIET — no gate, no drift. Nothing to do."}\n`);
process.exit(fired ? 1 : 0);
