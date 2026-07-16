import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { handleApi } from "./server/api";

const htlDir = fileURLToPath(new URL("./src/htl", import.meta.url));

// Self-host the onnxruntime-web runtime (the stem-separation worker loads it). Vendored
// into public/ort/ at build time and served SAME-ORIGIN, so the browser never trusts a
// third-party CDN at runtime. Each file is HASH-PINNED here — the integrity check a dynamic
// import() can't carry — so a tampered/compromised CDN fails the build instead of shipping
// code into the COI-isolated worker. Idempotent: files already present with the right hash
// are skipped, so only the first build needs network. Runs for every Vite entry (dev /
// build / worker / deploy) via buildStart. public/ort/ is gitignored (33 MB of wasm).
const ORT_VER = "1.22.0";
const ORT_FILES: Record<string, string> = {
  "ort.webgpu.min.mjs": "e131e81c9324807e1e6f9103e8f8e936112827dcc9993cde9407a333b1f07ae0",
  "ort-wasm-simd-threaded.jsep.mjs": "1cbcba8f2c769c1eecbab66a1b1e55ef11704515bf4306373e3db3c37cf6dcd8",
  "ort-wasm-simd-threaded.jsep.wasm": "b45970d0632383a057c27ca5b660b216f8e00c17cf8db9f6207b5e4abc839368",
};
function ortVendor() {
  return {
    name: "htl-ort-vendor",
    async buildStart() {
      const outDir = fileURLToPath(new URL("./public/ort/", import.meta.url));
      await mkdir(outDir, { recursive: true });
      const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VER}/dist`;
      for (const [name, want] of Object.entries(ORT_FILES)) {
        const dest = outDir + name;
        try {
          if (createHash("sha256").update(await readFile(dest)).digest("hex") === want) continue;
        } catch {
          /* missing → fetch below */
        }
        const res = await fetch(`${base}/${name}`);
        if (!res.ok) throw new Error(`[ort-vendor] ${name}: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const got = createHash("sha256").update(buf).digest("hex");
        if (got !== want) throw new Error(`[ort-vendor] ${name}: hash mismatch (want ${want}, got ${got})`);
        await writeFile(dest, buf);
        console.log(`[ort-vendor] vendored ${name} (${(buf.length / 1048576).toFixed(1)} MB)`);
      }
    },
  };
}

// Dev-time /api/*: YouTube search / playlist / metadata / audio, all via yt-dlp.
// DEV-ONLY: this dispatcher (server/api.ts) runs solely as Vite middleware and fakes
// auth via devStore — it must NEVER be bundled into the Worker. In production the
// Cloudflare Worker (worker/index.ts, the wrangler `main`) serves /api/* with real
// D1 + session auth; it does not import server/api.ts. (There is no api/*.ts prod
// layer — `DEV_AUTH` there is fail-open when process.env.NODE_ENV is absent, as in a
// Worker, so keeping api.ts out of the Worker bundle is load-bearing.)
function xxitApi() {
  return {
    name: "xxit-api",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        handleApi(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch((e) => {
            res.statusCode = 500;
            res.end(String((e as Error)?.message ?? e));
          });
      });
    },
  };
}

// DEV-ONLY telemetry sink. The client (src/htl/debug/trace.ts) POSTs JSON-line trace events to
// /__htl_debug and we append them to .htl-debug.log (gitignored via *.log) at the repo root, so a
// live `pnpm dev` session's audio/tempo/queue behaviour can be read straight off disk. DELETE
// clears the log (reset before a repro). Vite middleware only — never in the prod Worker.
function htlDebugSink() {
  const logPath = fileURLToPath(new URL("./.htl-debug.log", import.meta.url));
  return {
    name: "htl-debug-sink",
    configureServer(server: import("vite").ViteDevServer) {
      server.middlewares.use("/__htl_debug", (req, res) => {
        if (req.method === "DELETE") {
          void writeFile(logPath, "").catch(() => {});
          res.statusCode = 204;
          return res.end();
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end();
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          void appendFile(logPath, body.endsWith("\n") ? body : body + "\n").catch(() => {});
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// Build SHA baked in at config time so every bug report says exactly which code was running — the
// single load-bearing field. Falls back to "unknown" outside a git checkout.
function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react(), xxitApi(), ortVendor(), htlDebugSink()],
  define: { __HTL_BUILD__: JSON.stringify(gitSha()) },
  resolve: {
    alias: { "@htl": htlDir },
  },
  server: {
    port: 5173,
    // Listen on the LAN, not just loopback — the iPhone hits the dev build directly
    // (http://<this-machine>:5173). Note: plain-http LAN is NOT a secure context on the
    // phone → no cross-origin isolation there → wasm runs single-threaded; for a real
    // threaded phone number, front this with `cloudflared tunnel --url http://localhost:5173`.
    host: true,
    // Cross-origin isolation → multi-threaded wasm (fast on-device stem separation).
    // `credentialless` keeps cross-origin <img> thumbnails (i.ytimg.com) working
    // without CORP headers. ORT is now self-hosted (same-origin), so it needs no
    // cross-origin allowance at all.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    watch: {
      // Don't crawl heavy non-source trees — the stems Python venv alone holds
      // thousands of onnx test files and blows the OS file-watcher limit (ENOSPC).
      ignored: [
        "**/.venv-stems/**",
        "**/.venv/**",
        "**/__pycache__/**",
        "**/dist/**",
        "**/.wrangler/**",
        "**/stem-eval/**",
        "**/engine/target/**",
        "**/public/models/**",
      ],
    },
  },
});
