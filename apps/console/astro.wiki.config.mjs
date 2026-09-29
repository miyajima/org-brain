import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  srcDir:"./wiki-local",
  publicDir:"./wiki-local/public",
  output:"static",
  base:"/wiki-ui",
  outDir:"../../packages/orgbrain-cli/assets/wiki",
  vite:{plugins:[tailwindcss()],build:{assetsInlineLimit:0}},
});
