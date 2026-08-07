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
    build: {
      rollupOptions: {
        external: ["cloudflare:workers"]
      }
    }
  }
});
