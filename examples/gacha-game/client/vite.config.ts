import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Keep config minimal; serve index.html at /. The aliases let Vite resolve the
// pure @gacha/summon source directly (it ships raw .ts, no build step) — including
// the /banner subpath the client imports types from.
export default defineConfig({
  resolve: {
    alias: {
      "@gacha/summon/banner": fileURLToPath(
        new URL("../packages/summon/src/banner.ts", import.meta.url),
      ),
      "@gacha/summon": fileURLToPath(
        new URL("../packages/summon/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: "127.0.0.1",
  },
});
