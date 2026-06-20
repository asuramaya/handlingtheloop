// Broadcast-plane load harness (D2 sizing). Spins up ONE authenticated host that goes public
// and emits timestamped ticks, then floods N anonymous pub-listeners and measures what actually
// happens in the single DjRoom DO: admit rate, end-to-end fan-out latency (host emit → listener
// receive), the server's reported listener count vs reality, and drops. This is how we find the
// real ceiling instead of guessing — run it before deciding the relay tier is worth the refactor.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/loadtest-room.mjs [N=100] [holdSec=15] [hz=5]
//
// Needs `pnpm worker` (or :lan:https) up with DEV_LOGIN set (the dev-auth host shortcut).
const BASE = process.env.HTL_URL || "https://localhost:8787";
const WSBASE = BASE.replace(/^http/, "ws");
const N = Number(process.argv[2] || 100);
const HOLD = Number(process.argv[3] || 15);
const HZ = Number(process.argv[4] || 5);
const HANDLE = "loadtest";

const now = () => performance.now();
const pctl = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);
const cookieOf = (res) => ((res.headers.getSetCookie?.() || [res.headers.get("set-cookie")]).find((c) => c && c.includes("htl_session")) || "").split(";")[0];

async function main() {
  // 1. Dev-login a host + claim a handle so listeners can resolve the room by @handle.
  const login = await fetch(`${BASE}/api/auth/dev?name=LoadTest`, { redirect: "manual" });
  const cookie = cookieOf(login);
  if (!cookie) throw new Error("no dev session cookie — is DEV_LOGIN set in .dev.vars?");
  await fetch(`${BASE}/api/me/handle`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: HANDLE }) });

  // 2. Host socket → join + go public, then emit ticks with a monotonic seq encoded in A.pos.
  const sendAt = new Map(); // seq → emit time
  const host = new WebSocket(`${WSBASE}/api/room?device=host-sim&name=HostSim&kind=Mac&ev=1`, { headers: { Cookie: cookie } });
  await new Promise((res, rej) => {
    host.addEventListener("error", () => rej(new Error("host socket error")), { once: true });
    host.addEventListener("message", (e) => {
      if (JSON.parse(e.data).t === "welcome") res();
    });
  });
  host.send(JSON.stringify({ t: "join" }));
  host.send(JSON.stringify({ t: "public", on: true }));
  await sleep(400);
  let seq = 0;
  const ticker = setInterval(() => {
    seq++;
    sendAt.set(seq, now());
    host.send(JSON.stringify({ t: "tick", decks: { A: { pos: seq, playing: true }, B: { pos: 0, playing: false } } }));
  }, 1000 / HZ);

  // 3. Flood N listeners, ramped (avoid a thundering-herd connect that trips reconnect guards).
  const latencies = [];
  let admitted = 0,
    rejected = 0,
    closed = 0,
    errored = 0,
    ticksRecv = 0,
    serverCountMax = 0;
  const sockets = [];
  for (let i = 0; i < N; i++) {
    const ws = new WebSocket(`${WSBASE}/api/room?device=L${i}-${rand()}&name=L${i}&kind=Mac&ev=1&room=${HANDLE}`);
    sockets.push(ws);
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "welcome") admitted++;
      else if (m.t === "kicked") rejected++;
      else if (m.t === "presence" && typeof m.listeners === "number") serverCountMax = Math.max(serverCountMax, m.listeners);
      else if (m.t === "tick") {
        ticksRecv++;
        const t0 = sendAt.get(m.decks?.A?.pos);
        if (t0) latencies.push(now() - t0);
      }
    });
    ws.addEventListener("close", () => closed++);
    ws.addEventListener("error", () => errored++);
    if (i % 20 === 19) await sleep(250); // ~80 conns/sec ramp
  }

  log(`ramped ${N} listeners; holding ${HOLD}s…`);
  await sleep(HOLD * 1000);

  // 4. Report + teardown.
  clearInterval(ticker);
  const expectedTicks = admitted * HZ * HOLD;
  console.log(`\n── DjRoom broadcast fan-out @ N=${N}, ${HZ}Hz, hold ${HOLD}s ──`);
  console.log(`admitted        ${admitted}/${N}   rejected ${rejected}   closed ${closed}   errored ${errored}`);
  console.log(`server count    ${serverCountMax} (max reported)  ${serverCountMax === admitted ? "✓ accurate" : `△ off by ${admitted - serverCountMax}`}`);
  console.log(`tick delivery   ${ticksRecv} recv / ~${Math.round(expectedTicks)} expected  (${expectedTicks ? Math.round((ticksRecv / expectedTicks) * 100) : 0}% — drops show the DO shedding load)`);
  console.log(`fan-out latency p50 ${pctl(latencies, 50).toFixed(0)}ms  p95 ${pctl(latencies, 95).toFixed(0)}ms  max ${pctl(latencies, 100).toFixed(0)}ms  (host emit → listener receive)`);
  host.send(JSON.stringify({ t: "public", on: false }));
  await sleep(200);
  host.close();
  for (const ws of sockets) ws.close();
  await sleep(300);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.random().toString(36).slice(2, 8);
const log = (m) => console.log(`[${(now() / 1000).toFixed(1)}s] ${m}`);
main().catch((e) => {
  console.error("harness failed:", e.message);
  process.exit(1);
});
