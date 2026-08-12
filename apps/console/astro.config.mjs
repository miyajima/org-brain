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
    plugins: [tailwindcss()],
    optimizeDeps: {
      // Pre-bundle the lazy map dependency so Chrome receives a stable ESM chunk
      // instead of resolving the CommonJS force-layout dependency directly.
      include: ["3d-force-graph"]
    },
    build: {
      rollupOptions: {
        external: ["cloudflare:workers"]
      }
    }
  }
});
