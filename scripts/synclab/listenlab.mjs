#!/usr/bin/env node
// LISTENLAB — what reaches the CROWD, and whether it converges.
//
// ★ WHY --compare CANNOT BE POINTED AT A LISTENER. A listener does not get the performer relay.
// room.ts splits deliberately: writers and invited guests get every intent immediately ("instant
// mixing feel"), while the anonymous crowd gets a DIGEST — `jog` dropped outright as gestural and
// non-reconstructable, COALESCE_KINDS (control, crossfade, stemGain, fxParam) collapsed to
// last-value-per-key at ~20 Hz. So frame parity is the WRONG question: a large deficit is the
// design working, and EQUAL COUNTS WOULD MEAN THE DIGEST IS BROKEN. Aiming the performer's
// delivery instrument here produces a confident "sync is failing" that is exactly backwards.
//
// The right questions are two, and they are different in kind:
//   1. STATE CONVERGENCE — does the listener's FINAL value per control equal the performer's final
//      value? Coalescing may drop every intermediate frame; it must never lose the last one.
//   2. COALESCING RATIO — reported AS A RATIO, never as a pass or a fail, because there is no
//      correct number. It characterises; it does not judge.
//
// ★ THE POSITIVE CONTROL, AND IT IS NOT OPTIONAL (Deckard's rule, and the reason this file has one
// before it has a result). A convergence checker that always says "converged" is the same defect as
// the delivery checker that always said 4/4 — the instrument must be handed something it MUST fail
// on. So every run drives TWO controls:
//   • a SWEEP whose final value MUST arrive  → if it is missing, sync is broken;
//   • a JOG, which room.ts:665 drops for listeners by design → if the instrument reports it as
//     DELIVERED, the instrument is lying and the run aborts rather than yielding a green nobody
//     should trust.
// Both must come out right or no numbers are printed.
//
// SCOPE, stated so it is not oversold: this drives intents over the host's own room socket rather
// than through the UI. It therefore tests the SERVER's digest path — which is exactly what
// digestKey governs — and says nothing about the client's emit path. That is the intended scope,
// not a shortcut.

import { chromium } from "playwright-core";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
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
const HANDLE = arg("handle", null); // the host's @handle — how a public listener tunes in
const OUT = arg("out", "listenlab.json");
const SWEEP = +arg("sweep", 40); // frames per swept control
// JOIN-STORM MODE: how many listeners to admit in sequence, measuring what each one is handed on
// arrival. 0 = the ordinary convergence run.
const JOINERS = +arg("joiners", 0);
const FAT = +arg("fat", 0); // bytes of SYNTHETIC stemview to park in lastStemView before joining
const GAP = +arg("gap", 10); // ms between sweep frames — well under DIGEST_FLUSH_MS so it coalesces

if (!HANDLE) { console.error("listenlab: --handle <hostHandle> is required (a public listener tunes in by @handle)"); process.exit(2); }

// Host hook: keep the room socket so intents can be driven over the real protocol, and keep the
// welcome so we know our own device id.
const HOST_HOOK = `
window.__h = { ws: null, you: null, peers: [], publicOn: null };
const O = window.WebSocket;
function P(u, p) {
  const ws = p === undefined ? new O(u) : new O(u, p);
  if (String(u).includes("/api/room")) {
    window.__h.ws = ws;
    ws.addEventListener("message", (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.t === "welcome") { window.__h.you = m.you; if (m.public !== undefined) window.__h.publicOn = m.public; }
        if (m.t === "presence" && m.public !== undefined) window.__h.publicOn = m.public;
        if (Array.isArray(m.peers)) window.__h.peers = m.peers.map((x) => ({ id: x.id, name: x.name, decks: x.decks ?? "", controlling: !!x.controlling }));
      } catch {}
    });
  }
  return ws;
}
P.prototype = O.prototype;
for (const k of ["CONNECTING","OPEN","CLOSING","CLOSED"]) P[k] = O[k];
window.WebSocket = P;
`;

// Listener hook: a RAW socket on the public plane. No session cookie — an anonymous listener is
// what the crowd actually is, and using the real ?room=<handle> entry is what makes the DO set
// pub=1 (which it will not accept from the client; the Worker sets it).
const LISTEN_HOOK = (handle) => `
window.__l = { frames: [], sockets: [], t0: Date.now() };
(() => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const dev = "listen-" + Math.random().toString(36).slice(2, 10);
  const u = proto + "://" + location.host + "/api/room?device=" + dev + "&name=Crowd&kind=Listener&room=" + encodeURIComponent(${JSON.stringify(handle)});
  const ws = new WebSocket(u);
  window.__l.sockets.push({ event: "new", at: Date.now() });
  ws.addEventListener("open", () => window.__l.sockets.push({ event: "open", at: Date.now() }));
  ws.addEventListener("close", (e) => window.__l.sockets.push({ event: "close", code: e.code, at: Date.now() }));
  ws.addEventListener("error", () => window.__l.sockets.push({ event: "error", at: Date.now() }));
  ws.addEventListener("message", (e) => {
    try {
      const m = JSON.parse(e.data);
      window.__l.frames.push({ t: m.t, kind: m.intent?.kind, deck: m.intent?.deck, param: m.intent?.param, chain: m.intent?.chain, fx: m.intent?.fx, slot: m.intent?.slot, value: m.intent?.value, seq: m.seq, at: Date.now(), bytes: e.data.length });
    } catch {}
  });
})();
`;

const exe = findChrome();
if (!exe) { console.error("listenlab: no Chromium found."); process.exit(2); }

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });

// ── HOST ───────────────────────────────────────────────────────────────────────────────────────
const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (SID) {
  const u = new URL(URL_);
  await hostCtx.addCookies([{ name: "htl_session", value: SID, domain: u.hostname, path: "/", httpOnly: true, secure: u.protocol === "https:", sameSite: "Lax" }]);
}
const host = await hostCtx.newPage();
await host.addInitScript(HOST_HOOK);
await host.addInitScript(`try { localStorage.setItem("htl_room_engage", JSON.stringify({ joined: true, control: true, listen: true, ts: Date.now() })); } catch {}`);
await host.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log(`[listenlab] host loaded ${URL_}`);

let you = null;
for (let i = 0; i < 40; i++) { you = await host.evaluate(() => window.__h.you); if (you) break; await sleep(500); }
if (!you) { console.error("[listenlab] ABORT — host socket never produced a welcome."); await browser.close(); process.exit(3); }
console.log(`[listenlab] host device ${you}`);

// OPEN THE ROOM. A public listener is admitted only if the host opened it (worker/index.ts: "the
// DO admits them read-only only if the host opened the room").
await host.evaluate(() => window.__h.ws?.send(JSON.stringify({ t: "public", on: true })));
let pub = null;
for (let i = 0; i < 20; i++) { await sleep(500); pub = await host.evaluate(() => window.__h.publicOn); if (pub) break; }
console.log(`[listenlab] room public: ${pub}`);
if (!pub) { console.error("[listenlab] ABORT — room did not report public:true, so a listener cannot be admitted."); await browser.close(); process.exit(3); }

// ── JOIN-STORM MODE ────────────────────────────────────────────────────────────────────────────
// ★ THE PATH THIS MEASURES, and why it is NOT the lyrics pattern again. I claimed stemview was a
// second instance of "the disk learned to coalesce and the wire did not". That was FALSE and
// Deckard disproved it from my own file: room.ts gates the stemview RELAY at 2000 ms per
// sender:deck with a 400,000-char cap, and since relay() calls pushToRelays first, that gate
// governs the peer fan-out AND the D2 crowd shards. Ceiling 1.0 frame/s per controlling sender,
// so ~400 KB/s worst case steady. The stream is bounded.
//
// sendCatchUp (room.ts:1186) is NOT. It writes BOTH decks' lastStemView and lastLyrics to a socket
// with no rate limit and no per-socket budget, from four call sites — including line 357, which
// fires for EVERY anonymous public listener at admission. So the multiplier is CROWD SIZE:
//
//     N joiners  ⇒  N × up to 800 KB (2 decks × the 400 KB cap), ungated.
//
// Join-time amplification, not a stream. It is also the gap in MY OWN lyrics fix: the 400 ms relay
// throttle bounds the steady fan-out and does nothing about the copy handed to each new arrival.
//
// ★ POSITIVE CONTROL FOR THIS MODE, and it is a different control from the jog: run the SAME join
// against an EMPTY lastStemView and a FAT one. If both report the same bytes-per-joiner, the
// instrument is not measuring catch-up at all and the numbers mean nothing. A join-cost checker
// that cannot tell a fat room from an empty one is the 4/4 matcher again.
//
// The fat payload is SYNTHETIC and labelled as such wherever it is reported: it exercises the
// mechanism and bounds it, and it is NOT a claim about the size of a real stem separation.
async function joinOnce(label) {
  const ctx = await browser.newContext({ viewport: { width: 400, height: 300 } }); // NO cookie — anonymous
  const pg = await ctx.newPage();
  await pg.addInitScript(LISTEN_HOOK(HANDLE));
  await pg.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
  let ok = false;
  for (let i = 0; i < 40; i++) {
    const sk = await pg.evaluate(() => window.__l.sockets);
    if (sk.some((x) => x.event === "open")) { ok = true; break; }
    if (sk.some((x) => x.event === "close" || x.event === "error")) break;
    await sleep(250);
  }
  if (!ok) { await ctx.close(); return null; }
  await sleep(2500); // let the catch-up burst land
  const fr = await pg.evaluate(() => window.__l.frames);
  await ctx.close();
  const bytes = fr.reduce((n, f) => n + (f.bytes || 0), 0);
  const stem = fr.filter((f) => f.t === "stemview");
  const lyr = fr.filter((f) => f.t === "lyrics");
  return { label, frames: fr.length, bytes, stemFrames: stem.length, stemBytes: stem.reduce((n, f) => n + (f.bytes || 0), 0), lyricsFrames: lyr.length };
}

if (JOINERS > 0) {
  const results = { empty: [], fat: [] };
  // BASELINE: join an empty-ish room first, so the fat case has something it must differ from.
  console.log(`\n[listenlab] join-storm — BASELINE (no synthetic stemview parked)`);
  for (let i = 0; i < JOINERS; i++) {
    const r = await joinOnce(`empty#${i + 1}`);
    if (!r) { console.error("[listenlab] ABORT — a baseline listener socket never opened."); await browser.close(); process.exit(3); }
    results.empty.push(r);
    console.log(`    ${r.label}: ${r.frames} frames · ${(r.bytes / 1024).toFixed(1)} KB · stemview ${r.stemFrames} (${(r.stemBytes / 1024).toFixed(1)} KB) · lyrics ${r.lyricsFrames}`);
  }

  if (FAT > 0) {
    // Park a SYNTHETIC stemview in lastStemView. Sent as a normal stemview from the controlling
    // host, so it goes through the real size/rate gate rather than around it.
    console.log(`\n[listenlab] parking a SYNTHETIC stemview of ~${(FAT / 1024).toFixed(0)} KB per deck (NOT a real separation)`);
    for (const deck of ["A", "B"]) {
      await host.evaluate(({ d, n }) => {
        const view = { synthetic: true, pad: "x".repeat(n) };
        window.__h.ws?.send(JSON.stringify({ t: "stemview", deck: d, view }));
      }, { d: deck, n: FAT });
      await sleep(2100); // clear the 2000ms per sender:deck gate
    }
    await sleep(500);
    console.log(`[listenlab] join-storm — FAT room`);
    for (let i = 0; i < JOINERS; i++) {
      const r = await joinOnce(`fat#${i + 1}`);
      if (!r) { console.error("[listenlab] ABORT — a fat-case listener socket never opened."); await browser.close(); process.exit(3); }
      results.fat.push(r);
      console.log(`    ${r.label}: ${r.frames} frames · ${(r.bytes / 1024).toFixed(1)} KB · stemview ${r.stemFrames} (${(r.stemBytes / 1024).toFixed(1)} KB) · lyrics ${r.lyricsFrames}`);
    }
  }

  const sum = (a) => a.reduce((n, r) => n + r.bytes, 0);
  const avg = (a) => (a.length ? sum(a) / a.length : 0);
  console.log(`\n  JOIN COST — what the room hands each arrival`);
  console.log(`    baseline: ${results.empty.length} joiners · ${(avg(results.empty) / 1024).toFixed(1)} KB each · ${(sum(results.empty) / 1024).toFixed(1)} KB total`);
  if (results.fat.length) {
    console.log(`    fat:      ${results.fat.length} joiners · ${(avg(results.fat) / 1024).toFixed(1)} KB each · ${(sum(results.fat) / 1024).toFixed(1)} KB total   [SYNTHETIC payload]`);
    const ratio = avg(results.empty) > 0 ? avg(results.fat) / avg(results.empty) : Infinity;
    console.log(`\n  POSITIVE CONTROL — a fat room MUST cost a joiner more than an empty one`);
    console.log(`    ratio fat/empty = ${Number.isFinite(ratio) ? ratio.toFixed(2) : "∞"}`);
    if (Number.isFinite(ratio) && ratio < 1.5) {
      console.error(`\n  ABORT — the control FAILED: parking ~${(FAT / 1024).toFixed(0)} KB per deck did not measurably change what a joiner is handed. This instrument cannot tell a fat room from an empty one, so its join-cost numbers mean nothing.`);
      writeFileSync(OUT, JSON.stringify({ mode: "join-storm", handle: HANDLE, fatBytes: FAT, results }, null, 1));
      await browser.close();
      process.exit(4);
    }
    console.log(`    → the instrument CAN distinguish them, so the per-joiner cost above is trustworthy`);
  }
  writeFileSync(OUT, JSON.stringify({ mode: "join-storm", handle: HANDLE, fatBytes: FAT, results }, null, 1));
  console.log(`\n  wrote ${OUT}`);
  console.log(`  NOTE: sendCatchUp is ungated (room.ts:1186) — no rate limit, no per-socket budget — so this cost is LINEAR in crowd size and is join-time amplification, not a stream.`);
  await browser.close();
  process.exit(0);
}

// ── LISTENER ───────────────────────────────────────────────────────────────────────────────────
const lisCtx = await browser.newContext({ viewport: { width: 800, height: 600 } }); // NO cookie — anonymous
const lis = await lisCtx.newPage();
await lis.addInitScript(LISTEN_HOOK(HANDLE));
await lis.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
let open = false;
for (let i = 0; i < 40; i++) {
  const s = await lis.evaluate(() => window.__l.sockets);
  if (s.some((x) => x.event === "open")) { open = true; break; }
  if (s.some((x) => x.event === "close" || x.event === "error")) break;
  await sleep(500);
}
const socks = await lis.evaluate(() => window.__l.sockets);
if (!open) { console.error(`[listenlab] ABORT — listener socket never opened: ${JSON.stringify(socks)}`); await browser.close(); process.exit(3); }
console.log(`[listenlab] listener socket OPEN on ?room=${HANDLE}`);
await sleep(1000);

// ── DRIVE ──────────────────────────────────────────────────────────────────────────────────────
// TWO swept controls that MUST NOT collide (this is the digestKey fix under test: same deck, same
// param name `mix`, different chain+fx — they shared a key before and one of them froze), plus the
// JOG that MUST be dropped.
const A = { kind: "fxParam", deck: "A", slot: 0, param: "mix", chain: "master", fx: "reverb" };
const B = { kind: "fxParam", deck: "A", slot: 1, param: "mix", chain: "vocals", fx: "delay" };
const sent = [];
const send = async (intent) => {
  await host.evaluate((i) => window.__h.ws?.send(JSON.stringify({ t: "intent", intent: i })), intent);
  sent.push({ ...intent, at: Date.now() });
};
console.log(`[listenlab] sweeping ${SWEEP} frames each on master/reverb and vocals/delay, ${GAP}ms apart`);
for (let i = 1; i <= SWEEP; i++) {
  await send({ ...A, value: Math.round((i / SWEEP) * 1000) / 1000 });
  await send({ ...B, value: Math.round((1 - i / SWEEP) * 1000) / 1000 });
  await sleep(GAP);
}
// ★ THE POSITIVE CONTROL: jog is dropped for listeners by design (room.ts: `if (kind === "jog") break;`).
const JOGV = 0.4242;
await send({ kind: "jog", deck: "A", value: JOGV });
await sleep(2000); // well past DIGEST_FLUSH_MS so the trailing flush lands

const frames = await lis.evaluate(() => window.__l.frames);
writeFileSync(OUT, JSON.stringify({ handle: HANDLE, hostDevice: you, sent, frames }, null, 1));

// ── REPORT ─────────────────────────────────────────────────────────────────────────────────────
const got = frames.filter((f) => f.t === "intent");
const key = (f) => `${f.kind}:${f.deck ?? ""}:${f.chain ?? ""}/${f.fx ?? ""}:${f.param ?? ""}`;
const lastSent = new Map(), lastGot = new Map();
for (const s of sent) if (s.kind !== "jog") lastSent.set(key(s), s.value);
for (const g of got) if (g.kind !== "jog") lastGot.set(key(g), g.value);

console.log(`\nlistenlab — ${HANDLE}`);
console.log(`  sent ${sent.length} intents · listener received ${got.length} intents (${frames.length} frames total)`);

// POSITIVE CONTROL FIRST. No numbers are printed unless it passes.
const jogLeaked = got.some((g) => g.kind === "jog");
console.log(`\n  POSITIVE CONTROL — jog must be DROPPED for listeners (room.ts drops it by design)`);
console.log(`    jog frames reaching the listener: ${got.filter((g) => g.kind === "jog").length}  → ${jogLeaked ? "LEAKED" : "dropped, as designed"}`);
if (jogLeaked) {
  console.error(`\n  ABORT — the control FAILED: a jog reached the listener. Either the digest changed or this instrument is measuring the wrong socket. No convergence numbers printed, because a checker that cannot detect a drop cannot be trusted to report one.`);
  await browser.close();
  process.exit(4);
}

// STATE CONVERGENCE — the claim that matters.
let converged = 0, diverged = 0;
console.log(`\n  STATE CONVERGENCE — the final value per control must match`);
for (const [k, v] of lastSent) {
  const g = lastGot.get(k);
  const ok = g !== undefined && Math.abs(g - v) < 1e-9;
  if (ok) converged++; else diverged++;
  console.log(`    ${ok ? "OK  " : "MISS"} ${k.padEnd(40)} sent ${v}  listener ${g === undefined ? "(never arrived)" : g}`);
}

// COALESCING — a RATIO, not a verdict. There is no correct number here.
const sweptSent = sent.filter((s) => s.kind !== "jog").length;
console.log(`\n  COALESCING RATIO — characterisation, NOT a pass/fail`);
console.log(`    ${sweptSent} sent → ${got.length} delivered = ${sweptSent ? (got.length / sweptSent).toFixed(3) : "—"} (a LOW ratio is the digest working; 1.000 would mean it is not coalescing at all)`);
console.log(`\n  wrote ${OUT}`);
console.log(`  VERDICT: ${diverged === 0 ? "CONVERGED on every control" : `${diverged} control(s) DIVERGED`} — control passed, so this verdict is trustworthy.`);

await browser.close();
process.exit(diverged === 0 ? 0 : 5);
