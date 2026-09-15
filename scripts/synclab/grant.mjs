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
// How long to WAIT for the far side to show up, separate from how long to hold once it has.
// These were one number and it broke the handshake: the wait was hard-coded to 60 s while --hold
// applied only AFTER a successful grant, so "my window is open for 420 s" was false — the process
// aborted at 60 s if the peer was still booting. The waiting half is the half that has to be
// patient, because the other agent is mid-turn and cannot see this clock.
const WAIT = +arg("wait", 600);

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
console.log(`[grant] loaded ${URL_} — waiting up to ${WAIT}s for a second account, then holding ${HOLD}s`);

// RUN GATE, same law as synclab's: refuse to grant into an empty room. A grant issued to nobody
// looks identical to a grant that worked, from this side.
let peers = [];
for (let i = 0; i < WAIT; i++) {
  peers = await page.evaluate(() => window.__g.peers);
  // Distinct ACCOUNTS, not array length: peers.length >= 2 is satisfied by two devices of ONE
  // account, which is how a solo agent with one leftover tab passes a "second peer is really
  // here" check and measures its own empty room.
  if (new Set(peers.map((p) => p.name).filter(Boolean)).size >= 2) break;
  await sleep(1000);
}
const you = await page.evaluate(() => window.__g.you);
console.log(`[grant] you=${you} peers=${JSON.stringify(peers.map((p) => `${p.name}:${p.id}${p.host ? "(host)" : ""} ${p.joined ? "joined" : "PENDING"} decks=${JSON.stringify(p.decks)}`))}`);
if (new Set(peers.map((p) => p.name).filter(Boolean)).size < 2) {
  console.error(`[grant] ABORT — only ${new Set(peers.map((p) => p.name).filter(Boolean)).size} distinct account(s) present (${peers.length} device rows). Nobody to grant to.`);
  await browser.close();
  process.exit(3);
}

// TARGET A DIFFERENT ACCOUNT, not merely a different DEVICE id. Same-account multi-device is the
// supported "control extension" model, so my own stale headless windows are legitimately present
// and legitimately NOT a second DJ. Filtering on `p.id !== you` alone, this tool granted a ghost of
// my own account on a live run — the roster read ["UserB:d-…", "UserB:d-…"], one joined, and a
// read-back would then have confirmed decks:"AB" on a device with nobody behind it. A read-back is
// not a positive control when the thing it reads back can be the verifier.
const meName = (peers.find((p) => p.id === you) || {}).name ?? null;
const mine = peers.filter((p) => p.name === meName);
if (mine.length > 1) console.error(`[grant] NOTE — ${mine.length} devices on my own account (${meName}); ignoring my own ghosts: ${JSON.stringify(mine.filter((p) => p.id !== you).map((p) => p.id))}`);
// NOT filtered on `joined` any more: a pending guest is precisely the case that needs approving
// first. Filtering it out here is what made this tool look at a knocking peer and see an empty room.
const targets = peers.filter((p) => p.id !== you && p.name && p.name !== meName);
if (!targets.length) {
  console.error(`[grant] ABORT — no peer on a DIFFERENT account than mine (${meName}). Roster: ${JSON.stringify(peers)}`);
  await browser.close();
  process.exit(3);
}

// ★ APPROVE BEFORE GRANT — TWO HOST ACTIONS, NOT ONE. room.ts:425 refuses a grant whose target
// is not joined (`if (!target || !this.isLive(target) || !this.isJoined(target)) break;`) and the
// refusal is a bare break: a grant to a PENDING device is a silent no-op, the same shape as the
// intent drop. The read-back would then correctly report "not confirmed" and send the reader
// hunting the grant path when the fault is one step earlier.
//
// Why a guest is pending at all, since room.ts:387 admits `aj.invited` directly: `invited` is a
// Worker-set URL flag (room.ts:297, "a push-invite grant was consumed → auto-admit"), so it is
// true only on the connection that CONSUMED the invite code. Re-run the guest with the same code
// and it arrives knocking instead — which is the normal state of any repeat harness run.
// Approval persists server-side (room.ts:436-441), so approving is also the durable fix.
const pending = targets.filter((p) => !p.joined);
for (const t of targets) {
  if (!t.joined) {
    await page.evaluate((id) => window.__g.ws?.send(JSON.stringify({ t: "approve", to: id })), t.id);
    console.log(`[grant] → approved ${t.name} (${t.id}) — was PENDING`);
  }
}
// Wait for the approval to actually land before granting, rather than assuming ordering: the
// grant's precondition is the approval's RESULT, so sending both back-to-back re-creates the
// silent drop this step exists to avoid.
if (pending.length) {
  let joined = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const now = await page.evaluate(() => window.__g.peers);
    if (pending.every((t) => now.find((p) => p.id === t.id)?.joined)) { joined = true; break; }
  }
  if (!joined) {
    const now = await page.evaluate(() => window.__g.peers);
    console.error(`[grant] ABORT — approval did not land; target still not joined. Roster: ${JSON.stringify(now)}`);
    await browser.close();
    process.exit(4);
  }
  console.log(`[grant] approval confirmed — ${pending.map((t) => t.name).join(", ")} now joined`);
}
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
