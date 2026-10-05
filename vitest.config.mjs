import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': new URL('./apps/api-gateway/test/fixtures/cloudflare-workers.ts', import.meta.url).pathname }
  },
  test: {
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
    exclude: [...configDefaults.exclude, "**/.agent-worktrees/**"]
  }
});
