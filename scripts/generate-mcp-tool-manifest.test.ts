import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  capturedMcpToolContracts,
  resetCapturedMcpToolContracts
} from "../packages/mcp-core/src/index";
import { expect, test } from "vitest";
import { createOrgBrainMcpServer } from "../apps/api-gateway/src/mcp";
import type { Env } from "../apps/api-gateway/src/types";

test("generate the MCP tool manifest fixture", async () => {
  resetCapturedMcpToolContracts();
  await createOrgBrainMcpServer({} as Env, {
    principal: "manifest-generator",
    ownerPrincipal: "manifest-generator",
    runtimeActor: "manifest-generator",
    tenantId: "manifest",
    allowedTenants: ["manifest"],
    defaultRole: "reader",
    authSource: "access-service"
  });
  const tools = capturedMcpToolContracts();
  const serialized = `${JSON.stringify({
    contract_version: "orgbrain-mcp-tool-manifest/v1",
    protocol_version: "2026-07-28",
    tools
  }, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  const directory = new URL("../packages/mcp-core/fixtures/", import.meta.url);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(new URL("tool-manifest.json", directory), serialized, "utf8"),
    writeFile(new URL("tool-manifest.sha256", directory), `${digest}\n`, "utf8")
  ]);
  expect(tools).toHaveLength(48);
  expect(digest).toMatch(/^[0-9a-f]{64}$/u);
});
