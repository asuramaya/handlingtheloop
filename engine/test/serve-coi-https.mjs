// HTTPS static server for engine/test/ WITH cross-origin-isolation headers, bound to 0.0.0.0 so a
// phone on the LAN can reach it over a SECURE context (iOS Safari won't expose SharedArrayBuffer /
// AudioWorklet over plain http://<LAN-IP> — only https or localhost). Mirrors the app's prod headers
// (COOP same-origin + COEP credentialless) so the SAB-ring spike tests the REAL isolation config.
//
//   node engine/test/serve-coi-https.mjs [port] [certDir]
//     port    — default 8443
//     certDir — dir holding cert.pem + key.pem, default /tmp/htl-spike
//
// Then on the iPhone (same Wi-Fi):  https://<LAN-IP>:8443/sab-ring-spike.html
// Accept the self-signed-cert warning ("visit this website") — the page is still a secure context.
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, normalize } from "node:path";

const PORT = Number(process.argv[2]) || 8443;
const CERT_DIR = process.argv[3] || "/tmp/htl-spike";
const root = fileURLToPath(new URL(".", import.meta.url)); // engine/test/

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
};

const [cert, key] = await Promise.all([
  readFile(`${CERT_DIR}/cert.pem`),
  readFile(`${CERT_DIR}/key.pem`),
]);

const server = createServer({ cert, key }, async (req, res) => {
  // The exact isolation headers the app ships (worker/index.ts + vite.config.ts).
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  res.setHeader("Cache-Control", "no-store");
  let path = decodeURIComponent(req.url.split("?")[0]);
  if (path === "/" || path === "") path = "/sab-ring-spike.html";
  // Confine to engine/test/ (no traversal).
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  try {
    const data = await readFile(root + safe.replace(/^\//, ""));
    res.writeHead(200, { "content-type": TYPES[extname(safe)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found: " + safe);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTPS COI server on 0.0.0.0:${PORT}`);
  console.log(`  iPhone → https://192.168.1.199:${PORT}/sab-ring-spike.html  (accept the cert warning)`);
});
