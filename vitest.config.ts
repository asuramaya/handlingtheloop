import { defineConfig } from "vitest/config";

// Security regression tests run in a plain Node environment against the
// framework-free helpers in server/security.ts. See server/security.test.ts.
export default defineConfig({
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "src/**/*.test.ts"],
  },
});
