#!/usr/bin/env node
// GRANT — the host hands a guest the decks, from a headless side.
//
// Why this exists as its own file: synclab.mjs is Deckard's instrument and we share this tree, so
// this is a new path rather than an edit to theirs. It does ONE thing synclab cannot — act as the
// HOST and issue {t:"grant"}.
//
// WHY IT IS NEEDED, established from source rather than guessed: a guest who merely JOINS holds
// decks:"" (room.ts:343, `decks: granted ? "AB" : ""`), and canDriveIntent returns false for ""
// (protocol.ts:344) — so an ungranted guest drives nothing. That gate is DELIBERATE and covered by
// 13 assertions in protocol.test.ts; it is not the bug. The consequence for US is narrower: any
// two-party run where the host never granted has measured the UNGRANTED path, and a delivery
// number from that run describes a room where one side was never allowed to speak.
//
// The client refuses to emit at all in that state (App.tsx:2332, `if (room.controlling)`) and locks
// the board (App.tsx:2383), so the guest is TOLD — this is not a silent-divergence bug. It just
// means the granted run is a different run, and it is the one worth measuring.
//
// The grant is host-only (room.ts:422 isHostDevice) and addresses a DEVICE id, not a name — the
// presence payload carries peers[].id, which synclab's recorder deliberately collapses to names.
// So this keeps the ids.

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

function findChrome() {
  const cache = resolve(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    for (const d of readdirSync(cache).filter((x) => x.startsWith("chromium")).sort().reverse()) {
      for (const rel of ["chrome-linux64/chrome", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/chrome"]) {
        const p = resolve(cache, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/snap/bin/chromium", "/usr/bin/chromium"]) if (existsSync(p)) return p;
  return null;
}

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URL_ = arg("url", "http://localhost:8787/");
const SID = arg("sid", null);
const HOLD = +arg("hold", 180);

// Stash the room socket and keep FULL peer records (id included). synclab's recorder maps peers to
// names for readability; a grant needs the id, so this one keeps both.
const HOOK = `
window.__g = { peers: [], you: null, ws: null, sent: [], got: [] };
const O = window.WebSocket;
function P(url, protocols) {
  const ws = protocols === undefined ? new O(url) : new O(url, protocols);
  if (String(url).includes("/api/room")) {
    window.__g.ws = ws;
    ws.addEventListener("message", (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.t === "welcome" && m.you) window.__g.you = m.you;
        if (Array.isArray(m.peers)) window.__g.peers = m.peers.map((p) => ({ id: p.id, name: p.name, host: !!p.host, controlling: !!p.controlling, decks: p.decks ?? "", joined: !!p.joined }));
        if (m.t === "error") window.__g.got.push(m.message);
      } catch {}
    });
  }
  return ws;
}
P.prototype = O.prototype;
for (const k of ["CONNECTING","OPEN","CLOSING","CLOSED"]) P[k] = O[k];
window.WebSocket = P;
`;

const exe = findChrome();
if (!exe) { console.error("grant: no Chromium found."); process.exit(2); }

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (SID) {
  const u = new URL(URL_);
  await context.addCookies([{ name: "htl_session", value: SID, domain: u.hostname, path: "/", httpOnly: true, secure: u.protocol === "https:", sameSite: "Lax" }]);
}
const page = await context.newPage();
await page.addInitScript(HOOK);
await page.addInitScript(`try { localStorage.setItem("htl_room_engage", JSON.stringify({ joined: true, control: true, listen: true, ts: Date.now() })); } catch {}`);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log(`[grant] loaded ${URL_}`);

// RUN GATE, same law as synclab's: refuse to grant into an empty room. A grant issued to nobody
// looks identical to a grant that worked, from this side.
let peers = [];
for (let i = 0; i < 60; i++) {
  peers = await page.evaluate(() => window.__g.peers);
  if (peers.length >= 2) break;
  await sleep(1000);
}
const you = await page.evaluate(() => window.__g.you);
console.log(`[grant] you=${you} peers=${JSON.stringify(peers.map((p) => `${p.name}:${p.id}${p.host ? "(host)" : ""} decks=${JSON.stringify(p.decks)}`))}`);
if (peers.length < 2) {
  console.error(`[grant] ABORT — only ${peers.length} peer(s). Nobody to grant to.`);
  await browser.close();
  process.exit(3);
}

const targets = peers.filter((p) => p.id !== you && p.joined);
if (!targets.length) { console.error("[grant] ABORT — no joined peer other than me."); await browser.close(); process.exit(3); }

for (const t of targets) {
  await page.evaluate((id) => { window.__g.ws?.send(JSON.stringify({ t: "grant", to: id, on: true })); window.__g.sent.push(id); }, t.id);
  console.log(`[grant] → granted ${t.name} (${t.id})`);
}

// VERIFY BY READ-BACK, not by the fact that send() returned. The server patches the target's
// attachment and re-broadcasts presence; if decks does not become "AB" there, the grant did not
// land and every number after it would be measured on the ungranted path anyway.
let ok = false;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  const now = await page.evaluate(() => window.__g.peers);
  const t = now.filter((p) => p.id !== you);
  if (t.length && t.every((p) => p.decks === "AB" && p.controlling)) { ok = true; console.log(`[grant] CONFIRMED — ${t.map((p) => `${p.name} decks=AB controlling=true`).join(", ")}`); break; }
}
if (!ok) {
  const now = await page.evaluate(() => window.__g.peers);
  console.error(`[grant] NOT CONFIRMED — peers read back: ${JSON.stringify(now)}`);
}
const errs = await page.evaluate(() => window.__g.got);
if (errs.length) console.error(`[grant] server errors: ${JSON.stringify(errs)}`);

console.log(`[grant] holding the room ${HOLD}s — drive the guest side now.`);
await sleep(HOLD * 1000);
await browser.close();
console.log("[grant] done.");
