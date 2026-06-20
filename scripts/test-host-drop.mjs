// E7 validation — host abandons a public broadcast. A dev-auth host goes public; M anonymous
// listeners tune in; then the host socket is KILLED abruptly (no clean "stop"), simulating a
// crash / closed tab. Asserts the crowd is RELEASED (kicked "The host left.") within the anchor
// grace window — not stranded on a frozen mix.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/test-host-drop.mjs [M=20]
const BASE = process.env.HTL_URL || "https://localhost:8787";
const WS = BASE.replace(/^http/, "ws");
const M = Number(process.argv[2] || 20);
const HANDLE = "loadtest";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookieOf = (res) => ((res.headers.getSetCookie?.() || [res.headers.get("set-cookie")]).find((c) => c && c.includes("htl_session")) || "").split(";")[0];

const login = await fetch(`${BASE}/api/auth/dev?name=LoadTest`, { redirect: "manual" });
const cookie = cookieOf(login);
await fetch(`${BASE}/api/me/handle`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: HANDLE }) });

const host = new WebSocket(`${WS}/api/room?device=host-drop&name=HostDrop&kind=Mac&ev=1`, { headers: { Cookie: cookie } });
await new Promise((res) => host.addEventListener("message", (e) => JSON.parse(e.data).t === "welcome" && res()));
host.send(JSON.stringify({ t: "join" }));
host.send(JSON.stringify({ t: "public", on: true }));
await sleep(400);

let admitted = 0;
const kicked = []; // {at, reason}
const t0 = performance.now();
const listeners = [];
for (let i = 0; i < M; i++) {
  const ws = new WebSocket(`${WS}/api/room?device=D${i}-${Math.random().toString(36).slice(2, 7)}&name=D${i}&kind=Mac&ev=1&room=${HANDLE}`);
  listeners.push(ws);
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "welcome") admitted++;
    else if (m.t === "kicked") kicked.push({ at: performance.now(), reason: m.reason });
  });
}
await sleep(1500);
console.log(`${admitted}/${M} listeners tuned in; KILLING the host socket (abrupt, no clean stop)…`);
const killAt = performance.now();
host.close(); // abrupt drop — the crowd must NOT be left frozen

// Anchor grace is 8s; allow a couple seconds of slack for the timer + fan-out.
await sleep(11000);
const releasedWithin = kicked.filter((k) => k.reason === "The host left.");
const graceMs = releasedWithin.length ? Math.round(Math.max(...releasedWithin.map((k) => k.at)) - killAt) : 0;
console.log(`\n── E7: host-abandonment of a public broadcast ──`);
console.log(`released  ${releasedWithin.length}/${admitted} listeners kicked "The host left."`);
console.log(`grace     last release ${graceMs}ms after the host drop (ANCHOR_GRACE_MS=8000)`);
console.log(releasedWithin.length === admitted ? "✓ PASS — the crowd was released, not stranded on a frozen mix" : "✗ FAIL — some listeners were left hanging");
for (const ws of listeners) ws.close();
await sleep(200);
process.exit(releasedWithin.length === admitted ? 0 : 1);
