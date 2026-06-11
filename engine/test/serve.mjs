// Minimal static server for the engine smoke test (serves engine/ over http so
// the module script + wasm fetch work). Prints the chosen port, then serves until
// killed. No deps.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url)); // engine/
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const rel = path === "/" ? "/test/index.html" : path;
    const data = await readFile(root + rel);
    res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

const port = Number(process.argv[2]) || 0;
server.listen(port, "127.0.0.1", () => {
  console.log("PORT", server.address().port);
});
