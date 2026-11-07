#!/usr/bin/env node
// LANPROXY — a phone on the LAN gets HTTPS, the laptop keeps http://localhost, and both hit ONE
// local Worker. Run it beside `pnpm worker` (which serves http://127.0.0.1:8787).
//
// ★ WHY NOT `wrangler dev --local-protocol https` (what DEV.md used to suggest for iOS). It gets the
// phone its secure context, but it hangs desktop stem separation at "0%" forever, and production
// cannot reproduce it. Chrome's click-through exception for a self-signed cert covers the page and
// its workers, but NOT a worker spawned FROM INSIDE a worker, and onnxruntime's threaded wasm
// starts its pthread helpers exactly that way. Their script loads die at TLS (the
// CERTIFICATE_UNKNOWN lines in the wrangler log), nothing reports an error, and
// InferenceSession.create waits for threads that never start. Measured 2026-11-01: numThreads=1
// creates in 5 s, numThreads=6 hangs 40 s+ on the self-signed origin, numThreads=6 creates in
// 4.5 s on production (decision 7b5a5bfd). A local server that cannot separate cannot simulate
// production, and separation is the half of the app the phone depends on.
//
// So the two needs are split along the line that actually divides them:
//   • the LAPTOP uses http://localhost:8787. localhost is a secure context with no certificate at
//     all, so COOP/COEP isolation, worklets and nested workers all behave exactly as in production.
//   • the PHONE uses https://<lan-ip>:8787 through this proxy. iOS gates AudioWorklet behind a
//     secure context, so it needs HTTPS, and phones never separate (fetch + render only), so the
//     nested-worker refusal never touches them.
// Same Worker, same D1, same R2: stems the laptop separates are the stems the phone downloads,
// which is the production topology.
//
// ★ THE ONE HEADER REWRITE, and why it is faithful rather than a hack: worker/index.ts refuses a
// WebSocket whose Origin differs from the request's own origin. In production the edge terminates
// TLS and the Worker still sees an https:// request URL, so the page's https Origin matches. Behind
// this proxy the Worker sees http://, so a phone's `Origin: https://<lan-ip>:8787` would be refused.
// The proxy rewrites that one header's scheme for the host it fronts, which restores the pair a
// real edge produces. It never rewrites an Origin naming any other host.
//
//   pnpm worker:lan:https             # one command: build, then the Worker on 127.0.0.1 AND this proxy
//   node scripts/lanproxy.mjs         # proxy only, beside a `pnpm worker` you started yourself
//   node scripts/lanproxy.mjs --ip 192.168.4.156 --port 8787 --target http://127.0.0.1:8787
//   --spawn-worker                    # also start `wrangler dev --ip 127.0.0.1` and stop it on exit
//
// The certificate is self-signed, generated on first run with openssl into .wrangler/lan-cert/
// (gitignored), one per LAN IP because the IP is in the cert. The phone accepts it once.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

/** The Wi-Fi/Ethernet IPv4, skipping the interfaces that are reachable but are not "the LAN":
 *  loopback, Docker/libvirt/LXC bridges, veths, and Tailscale (100.64.0.0/10). Picking a bridge
 *  address would bind a URL the phone cannot reach, which looks exactly like a firewall problem. */
function lanIp() {
  const skipName = /^(lo|docker|br-|veth|virbr|lxcbr|tailscale|tun|wg)/;
  const cgnat = (a) => {
    const [p, q] = a.split(".").map(Number);
    return p === 100 && q >= 64 && q <= 127;
  };
  const found = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skipName.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal && !cgnat(a.address)) found.push({ name, address: a.address });
  }
  found.sort((x, y) => Number(/^wl/.test(y.name)) - Number(/^wl/.test(x.name))); // prefer Wi-Fi
  return found[0]?.address;
}

const ip = arg("ip", lanIp());
const port = Number(arg("port", "8787"));
const target = new URL(arg("target", "http://127.0.0.1:8787"));
if (!ip) {
  console.error("lanproxy: no LAN IPv4 found (only loopback/bridges/Tailscale). Pass --ip <address>.");
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const certDir = resolve(HERE, "..", ".wrangler", "lan-cert");
const keyPath = resolve(certDir, `${ip}.key.pem`);
const certPath = resolve(certDir, `${ip}.cert.pem`);
if (!existsSync(keyPath) || !existsSync(certPath)) {
  mkdirSync(certDir, { recursive: true });
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
    "-keyout", keyPath, "-out", certPath,
    "-subj", `/CN=htl-lan-${ip}`,
    "-addext", `subjectAltName=IP:${ip},DNS:localhost`,
  ], { stdio: "ignore" });
  console.log(`lanproxy: generated a self-signed cert for ${ip} → ${certPath}`);
}

const self = `https://${ip}:${port}`;
/** Headers to forward: the client's own, with Host kept (the Worker builds its origin from it) and
 *  the one Origin rewrite explained in the header above. */
function forwardHeaders(req) {
  const h = { ...req.headers };
  if (h.origin === self) h.origin = `http://${ip}:${port}`;
  h["x-forwarded-proto"] = "https";
  h["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  return h;
}

const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  const up = http.request(
    { host: target.hostname, port: target.port, method: req.method, path: req.url, headers: forwardHeaders(req) },
    (r) => {
      // rawHeaders, not the folded object: it keeps repeated headers (several Set-Cookie) intact.
      res.writeHead(r.statusCode ?? 502, r.rawHeaders);
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`lanproxy: the local Worker at ${target.origin} is not answering (${e.code ?? e.message}). Is \`pnpm worker\` running?\n`);
  });
  req.pipe(up);
});

// WebSocket upgrades: replay the request head to the Worker on a raw socket, then pipe both ways.
server.on("upgrade", (req, socket, head) => {
  const up = net.connect(Number(target.port), target.hostname, () => {
    const h = forwardHeaders(req);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(h)) for (const val of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${val}`);
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket).pipe(up);
  });
  const close = () => {
    socket.destroy();
    up.destroy();
  };
  up.on("error", close);
  socket.on("error", close);
});

// --spawn-worker: own the Worker too, so `pnpm worker:lan:https` stays a single command. Bound to
// loopback ONLY — the LAN reaches it through this proxy, never directly over plain HTTP.
if (process.argv.includes("--spawn-worker")) {
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "--ip", target.hostname, "--port", target.port], { stdio: "inherit" });
  const stop = () => {
    child.kill("SIGINT");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => {
    console.error(`lanproxy: the Worker exited (${code}); stopping the proxy too.`);
    process.exit(code ?? 1);
  });
}

server.on("tlsClientError", () => {}); // a phone that has not accepted the cert yet: expected, not news
server.listen(port, ip, () => {
  console.log(`lanproxy: phone → ${self}  ⇒  ${target.origin}`);
  console.log(`          laptop → http://localhost:${target.port} (no certificate, full isolation)`);
});
