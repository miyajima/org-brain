import assert from "node:assert/strict";
import test from "node:test";
import { connectorPlan, runConnectorCommand } from "./connector-setup.mjs";

test("connector plans use one local stdio MemoryStore server across supported agents", () => {
  const codex = connectorPlan("codex");
  assert.deepEqual(codex.args, ["mcp", "add", "orgbrain", "--", "orgbrain", "mcp"]);

  const claude = connectorPlan("claude", { scope: "project" });
  assert.deepEqual(claude.args, [
    "mcp",
    "add",
    "orgbrain",
    "--scope",
    "project",
    "--",
    "orgbrain",
    "mcp"
  ]);

  const opencode = connectorPlan("opencode");
  assert.equal(opencode.executable, "opencode2");
  assert.ok(opencode.args.includes("--global"));

  const openclaw = connectorPlan("openclaw", { command: "/opt/orgbrain" });
  assert.deepEqual(openclaw.config_merge.mcp.servers.orgbrain, {
    transport: "stdio",
    command: "/opt/orgbrain",
    args: ["mcp"]
  });
});

test("connector setup is non-mutating unless execute is explicit", async () => {
  const result = await runConnectorCommand("setup", ["codex"], {
    flags: new Set(),
    get: (_name, fallback) => fallback
  });
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.plan.transport, "stdio");
});
