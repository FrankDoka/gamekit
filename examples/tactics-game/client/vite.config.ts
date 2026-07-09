import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Keep config minimal; serve index.html at /. The alias lets Vite resolve the
// pure @tactics/turn-grid source directly (it ships raw .ts, no build step).
export default defineConfig({
  resolve: {
    alias: {
      "@tactics/turn-grid": fileURLToPath(
        new URL("../packages/turn-grid/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "127.0.0.1",
  },
});
