import { defineConfig } from "vitest/config";
import path from "node:path";

// The toolkit's own test suite. The example games under examples/* are ISOLATED projects
// (their own node_modules) with their own `node:assert` test scripts run via `node`, not
// vitest — so they are excluded here; running them is each game's concern.
export default defineConfig({
  resolve: {
    alias: {
      "@gamekit/game-contract": path.resolve(__dirname, "packages/game-contract/src/index.ts"),
    },
  },
  test: {
    include: ["tools/**/*.test.ts"],
    exclude: ["**/node_modules/**", "examples/**", "**/dist/**"],
  },
});
