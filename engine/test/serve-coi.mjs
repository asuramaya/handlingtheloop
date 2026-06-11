// Static server for repo root WITH cross-origin-isolation headers, to test
// multi-threaded wasm (mirrors the Vite dev config). Serves /public/models/* etc.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url)); // repo root
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
};

const server = createServer(async (req, res) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  try {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const data = await readFile(root + path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
server.listen(Number(process.argv[2]) || 0, "127.0.0.1", () => console.log("PORT", server.address().port));
