import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";

const runtime = process.env.ORGBRAIN_CONSOLE_RUNTIME || "cloudflare";
const adapter = runtime === "node"
  ? (await import("@astrojs/node")).default({ mode: "standalone" })
  : cloudflare();

export default defineConfig({
  output: "server",
  adapter,
  vite: {
    ...(process.env.ORGBRAIN_VITE_CACHE_DIR ? { cacheDir: process.env.ORGBRAIN_VITE_CACHE_DIR } : {}),
    plugins: [tailwindcss()],
    optimizeDeps: {
      // Pre-bundle the lazy map dependency so Chrome receives a stable ESM chunk
      // instead of resolving the CommonJS force-layout dependency directly.
      include: process.env.ORGBRAIN_SKIP_OPTIONAL_3D === "true" ? [] : ["3d-force-graph"]
    },
    build: {
      rollupOptions: {
        external: ["cloudflare:workers"]
      }
    }
  }
});
