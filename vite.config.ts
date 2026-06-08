import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// xxit dev server. The /api/* routes are serverless edge functions in
// production (Vercel/Cloudflare). In dev we proxy them to a local handler
// once the edge function is wired; until then the app runs fully on
// local-file input so the audio engine is testable offline.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
