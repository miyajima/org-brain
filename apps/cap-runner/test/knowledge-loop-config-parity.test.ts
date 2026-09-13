import { describe, expect, it } from "vitest";

const runtime = (globalThis as unknown as {
  process: { cwd: () => string; getBuiltinModule: (name: string) => unknown };
}).process;
const { readFileSync } = runtime.getBuiltinModule("node:fs") as {
  readFileSync: (path: string, encoding: string) => string;
};

function configuredAllowlist(relativePath: string): string {
  const source = readFileSync(`${runtime.cwd()}/${relativePath}`, "utf8");
  const match = /^KNOWLEDGE_LOOP_PREVIEW_WRITE_TENANTS_JSON\s*=\s*"(.*)"$/mu.exec(source);
  if (!match) throw new Error(`preview tenant allowlist is missing from ${relativePath}`);
  return match[1]!;
}

describe("knowledge loop deployment configuration", () => {
  it("keeps the preview write tenant allowlist identical in Gateway and Runner", () => {
    const runner = configuredAllowlist("wrangler.toml");
    expect(configuredAllowlist("../api-gateway/wrangler.toml")).toBe(runner);
    expect(configuredAllowlist("../api-gateway/wrangler.local.toml")).toBe(runner);
    expect(configuredAllowlist("../api-gateway/wrangler.remote-d1.toml")).toBe(runner);
  });
});
