import { defineConfig } from "vitest/config";
import path from "node:path";

// The toolkit's own test suite: the tools/ tests plus the pure core-systems packages/* tests.
// The example games under examples/* are ISOLATED projects (their own node_modules) with their
// own `node:assert` test scripts run via `node`, not vitest — so they are excluded here.
export default defineConfig({
  resolve: {
    alias: {
      "@gamekit/game-contract": path.resolve(__dirname, "packages/game-contract/src/index.ts"),
      "@gamekit/rng": path.resolve(__dirname, "packages/rng/src/index.ts"),
    },
  },
  test: {
    include: ["tools/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "examples/**", "**/dist/**"],
  },
});
