// Session-sync ON-WIRE harness — the integration counterpart to the deterministic in-process
// simulation in src/htl/room/sessionSim.test.ts. Where the unit sim fuzzes the follower DECISIONS,
// this proves the SERVER-side contract those decisions depend on, against a real DjRoom DO:
//
//   1. the anchor's `tick` carries the per-deck `vid` (track identity) end-to-end to a follower;
//   2. after the host switches tracks, a follower that FORCE-RECONNECTS (what the half-open
//      watchdog does on a 4G stall) gets a fresh catch-up `state` snapshot whose deck videoId is
//      the CURRENT track — so it can re-sync instead of staying on the wrong song.
//
// This is the wire half of the "shared board, wrong song" fix (htl-session-divergence-fix).
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/sessionsim.mjs
//
// Needs `pnpm worker` (or :lan:https) up with DEV_LOGIN set.
const BASE = process.env.HTL_URL || "https://localhost:8787";
const WS = BASE.replace(/^http/, "ws");
const HANDLE = "loadtest";
const A = "AAAAAAAAAAA"; // 11-char stand-in videoIds (the wire only relays the string)
const B = "BBBBBBBBBBB";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => ((res.headers.getSetCookie?.() || [res.headers.get("set-cookie")]).find((c) => c && c.includes("htl_session")) || "").split(";")[0];
const snapshot = (vid) => ({ decks: { A: { videoId: vid, name: "t", artist: "", duration: 100, playing: true, position: 1, tempo: 1, trim: 1, level: 1, eqLow: 0, eqMid: 0, eqHigh: 0, hotCues: [] }, B: { videoId: null } }, crossfade: 0.5, zoom: 1, tempoRange: 8 });
const recvUntil = (ws, pred, ms) =>
  new Promise((res) => {
    const to = setTimeout(() => res(null), ms);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (pred(m)) {
        clearTimeout(to);
        res(m);
      }
    });
  });

let pass = 0,
  fail = 0;
const check = (name, ok) => (ok ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}`)));

// Host: dev-login, claim a handle, join (→ anchor), and stream snapshots + ticks like the app.
const login = await fetch(`${BASE}/api/auth/dev?name=SimHost`, { redirect: "manual" });
const cookie = cookieOf(login);
if (!cookie) throw new Error("no dev session cookie — is DEV_LOGIN set in .dev.vars?");
await fetch(`${BASE}/api/me/handle`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: HANDLE }) });

const host = new WebSocket(`${WS}/api/room?device=sim-host&name=SimHost&kind=Mac&ev=1`, { headers: { Cookie: cookie } });
await recvUntil(host, (m) => m.t === "welcome", 5000);
host.send(JSON.stringify({ t: "join" }));
await sleep(300);
let hostVid = A;
host.send(JSON.stringify({ t: "state", snapshot: snapshot(hostVid) }));
const ticker = setInterval(() => host.send(JSON.stringify({ t: "tick", decks: { A: { pos: 1, playing: true, vid: hostVid }, B: { pos: 0, playing: false, vid: null } } })), 250);

// Guest: join the host's session as a follower and watch the wire.
const guest = new WebSocket(`${WS}/api/room?device=sim-guest&name=SimGuest&kind=Mac&ev=1&jam=${HANDLE}`);
await recvUntil(guest, (m) => m.t === "welcome", 5000);
guest.send(JSON.stringify({ t: "join" }));

// 1. The tick's vid reaches the guest end-to-end.
const tickA = await recvUntil(guest, (m) => m.t === "tick" && m.decks?.A?.vid === A, 4000);
check("tick carries the anchor's deck vid (A) end-to-end", !!tickA);

// 2. Host switches to track B. The new vid rides the tick.
hostVid = B;
host.send(JSON.stringify({ t: "state", snapshot: snapshot(B) }));
const tickB = await recvUntil(guest, (m) => m.t === "tick" && m.decks?.A?.vid === B, 4000);
check("after a track switch, the tick carries the new vid (B)", !!tickB);

// 3. Simulate the half-open watchdog: the guest's socket is torn down + reconnected, then it asks
//    for the current state. The catch-up snapshot must carry the CURRENT track (B), not stale A.
guest.close();
await sleep(500);
const guest2 = new WebSocket(`${WS}/api/room?device=sim-guest&name=SimGuest&kind=Mac&ev=1&jam=${HANDLE}`);
await recvUntil(guest2, (m) => m.t === "welcome", 5000);
guest2.send(JSON.stringify({ t: "join" }));
guest2.send(JSON.stringify({ t: "request-state" }));
const catchUp = await recvUntil(guest2, (m) => m.t === "state", 4000);
check("reconnect → request-state replays a snapshot", !!catchUp);
check("the catch-up snapshot carries the CURRENT track (B), not stale A", catchUp?.snapshot?.decks?.A?.videoId === B);

clearInterval(ticker);
host.close();
guest2.close();
console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
