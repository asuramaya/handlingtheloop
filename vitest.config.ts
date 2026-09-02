import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Security regression tests run in a plain Node environment against the
// framework-free helpers in server/security.ts. See server/security.test.ts.
//
// The `@htl` alias mirrors vite.config.ts. Without it, any test that touches a module which
// imports from "@htl" dies at import time — which quietly meant "components are untestable",
// and a component-side seam (the MIDI learn list against the sampler's pad layout) drifted
// unwatched because the test that would have caught it could not be written.
export default defineConfig({
  resolve: { alias: { "@htl": fileURLToPath(new URL("./src/htl", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
