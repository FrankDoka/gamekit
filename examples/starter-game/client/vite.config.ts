import { defineConfig } from "vite";

// The harness spawns vite with --host 127.0.0.1 --port <n> --strictPort and sets
// VITE_COLYSEUS_URL. Keep config minimal; serve index.html at /.
export default defineConfig({
  server: {
    host: "127.0.0.1",
  },
});
