import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { handleApi } from "./server/api";

const htlDir = fileURLToPath(new URL("./src/htl", import.meta.url));

// Dev-time /api/*: YouTube search / playlist / metadata / audio, all via yt-dlp.
// In production the same server/api dispatcher runs behind the serverless
// handlers in api/*.ts.
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
  },
});
