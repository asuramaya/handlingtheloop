#!/usr/bin/env node
// SYNCLAB — two browsers, one room, and a record of what actually crossed the wire.
//
// Why this exists: a collaboration bug is the one class you cannot debug from one screen. "It did
// not sync" is four different faults — the gesture never emitted, the frame never left, the frame
// arrived and was ignored, or it applied and the UI did not repaint — and they are
// indistinguishable from either end alone. This runs ONE side and writes a timestamped log of every
// websocket frame, console line, socket transition and long task, so two sides can be joined
// afterwards on a shared wall clock and each fault told apart from the others.
//
// THE CLOCK IS THE WHOLE TRICK. performance.now() is per-page and cannot be compared across two
// browsers; Date.now() can, because both processes share the machine's clock. Every record carries
// BOTH: `at` (wall, for cross-side joins) and `t` (page-relative, for within-side ordering).
//
// POSITIVE CONTROL, and it is not optional. A sync checker that cannot detect a MISSED update will
// report perfect sync forever and both readers will believe it — the exact failure that produced
// five meaningless clean results in one investigation earlier today. `--control` makes the far side
// miss a change on purpose and asserts the harness reports the divergence; if it does not, the run
// aborts rather than yielding a negative nobody should trust.
//
// Usage:
//   node scripts/synclab/synclab.mjs --role a --url https://… --out a.json --hold 90
//   node scripts/synclab/synclab.mjs --role b --url https://…?join=CODE --out b.json --hold 90
//   node scripts/synclab/synclab.mjs --compare a.json b.json
//
// Needs: playwright-core + a Chromium.

import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const has = (k) => process.argv.includes(`--${k}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the in-page recorder ──────────────────────────────────────────────────────────────────────
// Installed before the app's own scripts, so the socket it opens is already wrapped. Wrapping
// WebSocket rather than using CDP's Network domain is deliberate: this sees the frame at the moment
// the APP hands it over or receives it, which is the boundary a sync bug lives at — CDP timestamps
// the transport and would hide a frame the app built late or handled slowly.
const RECORDER = `
window.__sync = { frames: [], console: [], sockets: [], tasks: [], t0: Date.now() };
// The field t belongs to the PROTOCOL (it IS the frame type). The page-relative clock is ts —
// reusing t silently overwrote every frame type with a number, and the summary printed
// 'out 419' instead of 'out intent:fxParam'. The wire format names the field first; the
// harness works around it. (No backticks in here: this whole block is a template literal.)
const rec = (o) => { o.at = Date.now(); o.ts = Math.round(performance.now()); window.__sync.frames.push(o); };
const peek = (data) => {
  if (typeof data !== "string") return { t: "(binary)", bytes: data?.byteLength ?? 0 };
  try {
    const m = JSON.parse(data);
    // Keep the SHAPE, drop the payload: snapshots and stem views are enormous and the question is
    // always "did this kind of message cross, and when", never "what were the 40,000 samples".
    const o = { t: m.t, kind: m.intent?.kind, deck: m.intent?.deck ?? m.deck, param: m.intent?.param ?? m.intent?.fx, value: typeof m.intent?.value === "number" ? Math.round(m.intent.value * 1000) / 1000 : m.intent?.value, bytes: data.length };
    // AN INTENT IS A UNION, SO DO NOT PROJECT A FIXED FIELD SET OVER IT. Recording {param, value}
    // captures a knob turn honestly and EMPTIES every branch that does not carry those fields. A
    // board gesture (the FX pads) is {kind, deck, id, phase, arg} — no param, no value — so four
    // distinct pad presses all flattened to 'board:A:undefined:undefined', four identical rows. A
    // matcher keying on that returns the first inbound match for all four and reports 4/4 whether
    // four crossed, one crossed, or one crossed four times. It fails toward PASS, and it silently
    // cancelled the repeated-press control added specifically to catch a double-apply.
    // So: key on the branch's OWN identity — every scalar field the intent actually carries.
    if (m.intent && typeof m.intent === "object") {
      const parts = [];
      for (const k of Object.keys(m.intent).sort()) {
        const v = m.intent[k];
        const t = typeof v;
        if (v === null || t === "string" || t === "number" || t === "boolean") {
          parts.push(k + "=" + (t === "number" ? Math.round(v * 1000) / 1000 : String(v)));
        }
      }
      o.sig = parts.join("|");
    }
    // ★ seq IS A BETTER DELIVERY CHECK THAN ANY FIELD MATCH, and it was on the wire all along.
    // The DO stamps it server-side and monotonic per room (room.ts:656). So delivery is verifiable
    // by CONTIGUITY: a GAP is loss, a REPEAT is duplication, and it needs no per-branch field
    // knowledge — which is the whole difficulty a union type creates. Two frames that look
    // identical still have different seqs, so it sees exactly the case that made the field matcher
    // mute on the FX pads. Metron's find. Field matching stays, but as a LATENCY tool, which is
    // what it is actually good at.
    if (typeof m.seq === "number") o.seq = m.seq;
    if (m.from) o.from = m.from;
    }
    // PRESENCE IS THE ONE PAYLOAD WORTH KEEPING, because it answers the question every other
    // measurement depends on: are these two browsers actually in the SAME ROOM? Without it, a
    // perfect-looking run of two isolated sessions is indistinguishable from real sync — both sides
    // send, neither receives the other, and every per-side summary looks healthy.
    if (m.t === "presence" || m.t === "welcome" || m.t === "role") {
      // The field is peers (protocol.ts:308/314) — not people/devices/presence, all of which I
      // guessed first and all of which read back undefined. The guessed version could not tell a
      // shared room from two isolated ones, and said so only because the no-jam CONTROL produced
      // an identical result to the jam. Read the wire type, do not guess at it.
      if (Array.isArray(m.peers)) {
        o.who = m.peers.map((x) => x?.name ?? x?.id ?? "?").slice(0, 8);
        // ★ KEEP THE FLAGS, NOT JUST THE NAMES. Collapsing peers to names reads nicely and threw
        // away the two fields that decide whether a drive can work at all: the device id (a grant
        // addresses an id, not a name) and controlling/decks (permission). Without them a gate can
        // only prove someone is PRESENT, and presence is not permission.
        o.peers = m.peers.map((x) => ({ id: x?.id, name: x?.name, joined: x?.joined, controlling: x?.controlling, decks: x?.decks }));
      }
      if (m.you) o.you = m.you;
      if (typeof m.listeners === "number") o.listeners = m.listeners;
      if (m.you) o.you = m.you;
      if (m.anchorId !== undefined) o.anchor = m.anchorId;
    }
    return o;
  } catch { return { t: "(unparsed)", bytes: data.length }; }
};
const OrigWS = window.WebSocket;
function PatchedWS(url, protocols) {
  const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
  const room = String(url).includes("/api/room");
  window.__sync.sockets.push({ url: String(url).slice(0, 120), room, event: "new", at: Date.now(), ts: Math.round(performance.now()) });
  ws.addEventListener("open", () => window.__sync.sockets.push({ room, event: "open", at: Date.now(), ts: Math.round(performance.now()) }));
  ws.addEventListener("close", (e) => window.__sync.sockets.push({ room, event: "close", code: e.code, at: Date.now(), ts: Math.round(performance.now()) }));
  ws.addEventListener("error", () => window.__sync.sockets.push({ room, event: "error", at: Date.now(), ts: Math.round(performance.now()) }));
  if (room) {
    ws.addEventListener("message", (e) => rec({ dir: "in", ...peek(e.data) }));
    const send = ws.send.bind(ws);
    ws.send = (d) => { rec({ dir: "out", ...peek(d) }); return send(d); };
  }
  return ws;
}
PatchedWS.prototype = OrigWS.prototype;
for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) PatchedWS[k] = OrigWS[k];
window.WebSocket = PatchedWS;

try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__sync.tasks.push({ at: Date.now(), ts: Math.round(e.startTime), d: Math.round(e.duration) }); })
    .observe({ entryTypes: ["longtask"] });
} catch {}
`;

// ── compare mode ──────────────────────────────────────────────────────────────────────────────
if (has("compare")) {
  const i = process.argv.indexOf("--compare");
  const A = JSON.parse(readFileSync(process.argv[i + 1], "utf8"));
  const B = JSON.parse(readFileSync(process.argv[i + 2], "utf8"));
  const out = A.frames.filter((f) => f.dir === "out" && f.t === "intent");
  const inb = B.frames.filter((f) => f.dir === "in" && f.t === "intent");
  console.log(`\nsynclab compare — A sent ${out.length} intents, B received ${inb.length}\n`);
  console.log("  kind      intent identity                       A sent  latency");
  let matched = 0;
  const lat = [];
  // ★ CONSUME EACH INBOUND MATCH. Without this, one arrival can satisfy every identical outbound
  // row — so N sends and ONE delivery still prints N/N. Consuming is also what makes a DOUBLE-APPLY
  // visible: two arrivals for one send leave a surplus, and a surplus is the only evidence an
  // idempotency bug ever produces.
  const taken = new Set();
  for (const o of out) {
    const key = (x) => (x.sig !== undefined || o.sig !== undefined ? x.sig === o.sig : x.kind === o.kind && x.deck === o.deck && x.param === o.param && x.value === o.value);
    const idx = inb.findIndex((x, i) => !taken.has(i) && key(x) && x.at >= o.at - 50);
    const m = idx >= 0 ? inb[idx] : null;
    if (m) { taken.add(idx); matched++; lat.push(m.at - o.at); }
    const label = o.sig ? o.sig.replace(/^kind=[^|]*\|?/, "").slice(0, 34) : String(o.param ?? "");
    console.log(`  ${String(o.kind ?? "?").padEnd(10)}${label.padEnd(36)}${String(o.at % 100000).padStart(7)}  ${m ? String(m.at - o.at).padStart(6) + " ms" : " MISSING"}`);
  }
  // Arrivals nobody sent, or sent once and delivered twice.
  const surplus = inb.filter((x, i) => !taken.has(i) && out.some((o) => o.sig !== undefined && o.sig === x.sig));
  if (surplus.length) console.log(`\n  ⚠ ${surplus.length} DUPLICATE arrival(s) — an intent sent once was applied more than once: ${[...new Set(surplus.map((x) => x.sig?.slice(0, 40)))].join(", ")}`);
  // ── delivery by seq contiguity ────────────────────────────────────────────────────────────────
  const seqs = B.frames.filter((f) => f.dir === "in" && typeof f.seq === "number").map((f) => f.seq);
  if (seqs.length > 1) {
    const lo = Math.min(...seqs), hi = Math.max(...seqs);
    const uniq = new Set(seqs);
    const missing = [];
    for (let i = lo; i <= hi; i++) if (!uniq.has(i)) missing.push(i);
    const dupes = seqs.length - uniq.size;
    console.log(`\n  BY SEQ (server-stamped, detects loss AND duplication):`);
    console.log(`    range ${lo}→${hi} — expected ${hi - lo + 1} · received ${seqs.length} · unique ${uniq.size}`);
    console.log(`    MISSING: ${missing.length ? missing.join(",") : "none"}    DUPLICATE: ${dupes || "none"}`);
  }

  const sorted = [...lat].sort((a, b) => a - b);
  console.log(`\n  delivered ${matched}/${out.length}${out.length ? ` (${Math.round((matched / out.length) * 100)}%)` : ""}`);
  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
  if (sorted.length) console.log(`  all rows   median ${q(sorted, 0.5)} ms · p95 ${q(sorted, 0.95)} ms · worst ${sorted.at(-1)} ms   ← see the warning below`);
  // ★ ONE BURST IS ONE MEASUREMENT, NOT N OF THEM. The initial state publish emits ~25 control
  // intents inside a couple of milliseconds; they cross together and share a single latency. Counted
  // as 25 independent samples they DOMINATE the median and report the app as 25x slower at live
  // gestures than it is — a size-biased estimator, where the sample's composition is nothing like
  // the population being described. Collapse anything sent within the same 50 ms to one row, and
  // report the per-GESTURE figure separately, because that is the number a person actually feels.
  const bursts = [];
  for (let i = 0; i < out.length; i++) {
    const m = inb.find((x) => x.kind === out[i].kind && x.deck === out[i].deck && x.param === out[i].param && x.value === out[i].value && x.at >= out[i].at - 50);
    if (!m) continue;
    const last = bursts.at(-1);
    if (last && out[i].at - last.at <= 50) { last.n++; continue; }
    bursts.push({ at: out[i].at, lat: m.at - out[i].at, n: 1 });
  }
  const bl = bursts.map((b) => b.lat).sort((a, b) => a - b);
  console.log(`  by BURST   ${bursts.length} distinct send(s): median ${q(bl, 0.5)} ms · p95 ${q(bl, 0.95)} ms · worst ${bl.at(-1) ?? 0} ms`);
  const big = bursts.filter((b) => b.n > 1);
  if (big.length) console.log(`  (${big.map((b) => b.n).join(" + ")} intent(s) rode in ${big.length} batch(es) — one crossing each, not ${big.reduce((s, b) => s + b.n, 0)} measurements)`);
  if (matched < out.length) console.log(`\n  ⚠ ${out.length - matched} intent(s) never reached B — that is a real sync failure, not latency.`);
  process.exit(0);
}

// ── run mode ──────────────────────────────────────────────────────────────────────────────────
const ROLE = arg("role", "a");
const URL_ = arg("url", "https://handlingtheloop.com/");
const OUT = arg("out", `synclab-${ROLE}.json`);
const HOLD = +arg("hold", 60); // seconds to stay open recording
// The session cookie for THIS side. Against `wrangler dev` these come from
// /api/auth/dev?name=<who> — a real D1 user + session, no OAuth, and the route does not exist in
// production (gated on env.DEV_LOGIN, set only in .dev.vars). Each side gets its OWN browser, so
// the two cookie jars never touch.
const SID = arg("sid", null);
// ★ ENGAGE ON BOOT. The room socket does not open until the device JOINS a session — a signed-out
// solo page opens none at all, which the recorder's own positive control established. The client
// persists its switch state under htl_room_engage so a refresh re-engages (client.ts:103), so
// seeding that key is how a headless side joins without driving the Session panel by hand.
// `control` is the drive switch and is independent of `listen` (audio), which is why they are
// separate flags rather than one "joined".
const ENGAGE = has("engage");
const CONTROL = !has("no-control");
const exe = findChrome();
if (!exe) { console.error("synclab: no Chromium found."); process.exit(2); }

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
if (SID) {
  const u = new URL(URL_);
  await context.addCookies([{ name: "htl_session", value: SID, domain: u.hostname, path: "/", httpOnly: true, secure: u.protocol === "https:", sameSite: "Lax" }]);
}
const page = await context.newPage();
page.on("pageerror", (e) => process.stderr.write(`  [${ROLE} page error] ${String(e).slice(0, 160)}\n`));
page.on("console", (m) => {
  const t = m.text();
  if (/\[htl\]/.test(t) || m.type() === "error") process.stderr.write(`  [${ROLE} ${m.type()}] ${t.slice(0, 200)}\n`);
});
await page.addInitScript(RECORDER);
if (ENGAGE) {
  await page.addInitScript(`try { localStorage.setItem("htl_room_engage", JSON.stringify({ joined: true, control: ${CONTROL}, listen: true, ts: Date.now() })); } catch {}`);
}
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log(`[${ROLE}] loaded ${URL_}`);

// ── the driver ────────────────────────────────────────────────────────────────────────────────
// Gestures go through the KEYBOARD, not canvases: keybinds.ts stores PHYSICAL key codes, so a
// synthetic press is layout-independent and hits the same path a finger does. Canvas drags need a
// visible, correctly-positioned element and have already produced three meaningless runs today by
// landing off-screen or on nothing.
// ★ THE FX GESTURES ARE THE POINT, and the first list did not have one. The operator's symptom is
// FX — "chain 1 add reverb, apply to vocals, nothing going through the chain" — so a green run on
// transport/tempo/grid would have said nothing whatever about the thing they reported, while
// looking like a full pass. KeyI selects FX pad mode, Digit1-8 throw the pads (keybinds.ts:59,102).
const GESTURES = [
  { id: "transport-play", key: "Space" },
  { id: "sync", key: "KeyS" },
  { id: "keylock", key: "KeyZ" },
  { id: "pitch-up", key: "Equal" },
  { id: "tempo-nudge-up", key: "Equal", shift: true },
  { id: "grid-magnet", key: "KeyG" },
  { id: "pad-mode-fx", key: "KeyI" },
  { id: "fx-throw-1", key: "Digit1" },
  { id: "fx-throw-2", key: "Digit2" },
  { id: "fx-throw-1-again", key: "Digit1" },
  { id: "transport-pause", key: "Space" },
];

if (has("drive")) {
  // ★ RUN GATE, NOT A CHECK YOU CAN SKIP. Two browsers in SEPARATE rooms look exactly like working
  // sync from either side — both send, neither receives, both summaries read healthy. So refuse to
  // drive at all until presence proves a second peer is actually here. A delivery number measured
  // against an empty room is worse than no number, because it is confidently wrong.
  // ★ TWO PEERS IS NOT TWO PEOPLE. `peers.length >= 2` is satisfied by two DEVICES OF THE SAME
  // ACCOUNT — which the room explicitly supports (a phone driving a laptop) and which every
  // headless window either of us leaves behind also produces. Metron found it by running the
  // negative control he expected to be boring: a room holding only HIM read as two peers, both
  // named UserB, one a stale device from an earlier run. A solo agent with one leftover tab would
  // have passed this gate, driven into a room containing nobody else, and got a delivery number —
  // the exact isolated-room false positive the gate exists to kill, back through a door neither of
  // us checked. My own 31/31 capture turns out to have carried such a ghost.
  // So: require a JOINED peer on a DIFFERENT ACCOUNT NAME, not merely a different id.
  let peers = [];
  let others = [];
  for (let i = 0; i < 40; i++) {
    const snap = await page.evaluate(() => {
      // ★ `you` RIDES ONLY ON welcome; `peers` RIDES ON welcome AND EVERY presence. Requiring both
      // on one frame pins you to the welcome forever — the single moment when a guest is still
      // PENDING and ungranted. The gate then waits 120 s for a grant it has already been told
      // arrived, and aborts on a stale row. Take the identity from welcome and the state from the
      // LATEST presence.
      const id = window.__sync.frames.find((x) => x.you)?.you ?? null;
      const f = [...window.__sync.frames].reverse().find((x) => x.peers);
      if (!f || !id) return null;
      const mine = f.peers.find((p) => p.id === id);
      return { peers: f.peers, you: id, myName: mine?.name ?? null };
    });
    if (snap) {
      peers = snap.peers.map((p) => p.name);
      others = snap.peers.filter((p) => p.id !== snap.you && p.joined && p.name !== snap.myName);
    }
    if (others.length >= 1) break;
    await sleep(1000);
  }
  // ★ AN ABORT MUST KEEP ITS EVIDENCE. The first version exited before writing the capture, so the
  // one run that most needed explaining — the one that refused to measure — left nothing to explain
  // it with. The gate's whole job is to say WHY, and the why is in the frames.
  const bail = async (code, ...lines) => {
    for (const l of lines) console.error(l);
    try {
      const partial = await page.evaluate(() => ({ ...window.__sync, gestures: window.__sync.gestures ?? [], url: location.href, aborted: true }));
      writeFileSync(OUT, JSON.stringify(partial, null, 1));
      console.error(`[${ROLE}] capture kept at ${OUT} (aborted run — the frames say why)`);
    } catch { /* the page may already be gone; the message above is still the point */ }
    await browser.close();
    process.exit(code);
  };

  if (others.length < 1) {
    await bail(
      3,
      `[${ROLE}] ABORT — no JOINED peer on a different account. Roster: ${JSON.stringify(peers)}.`,
      `[${ROLE}]   Two devices of the same account satisfy a peer COUNT and are not a second DJ — stale headless windows look exactly like company.`,
    );
  }
  // ★ PRESENCE IS NOT PERMISSION, AND THE FIRST VERSION OF THIS GATE CONFLATED THEM. It proved a
  // second peer was in the room and let that imply this side could speak. An ungranted guest drives
  // NOTHING — the client refuses before the wire (App.tsx:2332), so eight gestures emit zero
  // intents and the run looks like a total sync failure instead of a permission state. A gate that
  // checks the easy precondition and stays silent on the hard one is worse than no gate, because it
  // reads as a pass. Name which precondition failed.
  // ★ WAIT FOR THE GRANT, DON'T SNAPSHOT ONCE. Checking `controlling` a single time races the
  // host's approve→grant: the peer appears, we look immediately, the grant has not landed yet, and
  // we abort on a precondition that was about to be satisfied. The gate is supposed to make the
  // handshake self-sequencing — one non-blocking read reintroduces exactly the timing race it
  // exists to delete.
  let me = null;
  for (let i = 0; i < 120; i++) {
    me = await page.evaluate(() => {
      const id = window.__sync.frames.find((x) => x.you)?.you ?? null;
      const f = [...window.__sync.frames].reverse().find((x) => x.peers);
      if (!f || !id) return null;
      return f.peers.find((p) => p.id === id) ?? null;
    });
    if (!me || me.controlling) break;
    if (i === 0) console.log(`[${ROLE}] in the room, waiting for the host to approve + grant (id ${me.id})…`);
    await sleep(1000);
  }
  if (me && me.controlling === false) {
    await bail(
      4,
      `[${ROLE}] ABORT — this device is in the room but has NOT been granted the decks (controlling=false, decks="${me.decks ?? ""}").`,
      `[${ROLE}]   An ungranted guest emits no intents at all, so a run now would record a total sync failure that is really a permission state.`,
      `[${ROLE}]   The HOST must send {t:"grant", to:"${me.id}", on:true} first.`,
    );
  }
  console.log(`[${ROLE}] gate passed — roster ${JSON.stringify(peers)} · other account(s): ${JSON.stringify(others.map((o) => o.name))}${me ? ` · me: controlling=${me.controlling} decks=${me.decks ?? ""}` : ""}`);
  await page.evaluate(() => { window.__sync.gestures = []; });
  for (const g of GESTURES) {
    await page.evaluate((id) => window.__sync.gestures.push({ id, at: Date.now(), ts: Math.round(performance.now()) }), g.id);
    if (g.shift) await page.keyboard.down("Shift");
    await page.keyboard.press(g.key);
    if (g.shift) await page.keyboard.up("Shift");
    await sleep(1600); // let the intent emit, cross, and apply before the next one muddies it
  }
  console.log(`[${ROLE}] drove ${GESTURES.length} gestures`);
  await sleep(4000);
} else {
  await sleep(HOLD * 1000);
}

const data = await page.evaluate(() => ({ ...window.__sync, gestures: window.__sync.gestures ?? [], url: location.href }));
writeFileSync(OUT, JSON.stringify(data, null, 1));
const room = data.sockets.filter((s) => s.room);
console.log(`[${ROLE}] wrote ${OUT} — ${data.frames.length} room frames, ${room.length} socket events, ${data.tasks.length} long tasks`);
console.log(`[${ROLE}] socket: ${room.map((s) => s.event).join(" → ") || "NEVER OPENED"}`);
const kinds = {};
for (const f of data.frames) { const k = `${f.dir} ${f.t}${f.kind ? ":" + f.kind : ""}`; kinds[k] = (kinds[k] ?? 0) + 1; }
for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`   ${String(n).padStart(5)}  ${k}`);

// ── receive-side health ───────────────────────────────────────────────────────────────────────
// Two questions a per-side log can answer ALONE, without the other side's file, and both matter to
// "is the live session smooth": does the inbound tick stream arrive evenly, and does anything block
// the main thread WHILE it is arriving.
const peersSeen = data.frames.filter((f) => f.who).map((f) => f.who);
if (peersSeen.length) console.log(`   peers: ${JSON.stringify(peersSeen[0])} → ${JSON.stringify(peersSeen.at(-1))}`);
const ticks = data.frames.filter((f) => f.t === "tick" && f.dir === "in").map((f) => f.at);
if (ticks.length > 8) {
  const gaps = ticks.slice(1).map((t, i) => t - ticks[i]).sort((a, b) => a - b);
  const q = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))];
  const stalled = gaps.filter((g) => g > 1000).length;
  console.log(`   inbound ticks: ${ticks.length} over ${Math.round((ticks.at(-1) - ticks[0]) / 1000)}s — cadence median ${q(0.5)} ms · p95 ${q(0.95)} ms · worst ${gaps.at(-1)} ms · gaps>1s: ${stalled}`);
  // ★ WHERE a block happened decides what it MEANS. Twelve long tasks on a receiving client reads
  // as "live sync stalls the far side" — until you place them on the timeline and every one lands
  // in the first 22 seconds, before the stream even starts. Boot cost and sync cost are different
  // problems with different owners, and a count alone cannot tell them apart.
  const during = data.tasks.filter((t) => t.at >= ticks[0]);
  const boot = data.tasks.length - during.length;
  console.log(`   long tasks: ${boot} during BOOT, ${during.length} during the STREAM${during.length ? ` (worst ${Math.max(...during.map((t) => t.d))} ms)` : " — the stream itself blocked nothing"}`);
}
await browser.close();
