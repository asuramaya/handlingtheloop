import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { handleApi } from "./server/api";

const htlDir = fileURLToPath(new URL("./src/htl", import.meta.url));

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

export default defineConfig({
  plugins: [react(), xxitApi()],
  resolve: {
    alias: { "@htl": htlDir },
  },
  server: {
    port: 5173,
    // Cross-origin isolation → multi-threaded wasm (fast on-device stem separation).
    // `credentialless` keeps cross-origin <img> thumbnails (i.ytimg.com) working
    // without CORP headers, and the jsdelivr ORT import/wasm still load (CORS).
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
