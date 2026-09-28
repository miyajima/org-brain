import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const CONNECTORS = [
  { name: "codex", executable: "codex", files: [[".codex", "hooks.json"], [".codex", "config.toml"]] },
  { name: "claude", executable: "claude", files: [[".claude", "settings.json"], [".claude.json"]] },
  { name: "cursor", executable: "cursor", files: [[".cursor", "hooks.json"], [".cursor", "mcp.json"]] },
  { name: "opencode", executable: "opencode", files: [[".config", "opencode", "opencode.json"], [".opencode", "config.json"]] }
];

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function defaultExecutableLookup(name) {
  return new Promise((resolve) => {
    const child = spawn("which", [name], { stdio: "ignore", shell: false });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function inspectConfig(file) {
  try {
    await access(file);
    const [content, details] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return {
      configured: content.trim().length > 0,
      managed: /orgbrain(?:\s+hook|\.mjs|\b)/iu.test(content),
      configuration_ref: digest(file),
      configuration_mtime: details.mtime.toISOString()
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { configured: true, managed: false, configuration_ref: digest(file), unreadable: true };
  }
}

export async function connectorInventory({
  store,
  homeDir,
  tenantId = "default",
  projectId = null,
  executableLookup = defaultExecutableLookup,
  runtimeScope = typeof process.getuid === "function" && process.getuid() === 0 ? "system" : "user",
  observedSinceMs = 30 * 24 * 60 * 60 * 1000
}) {
  const since = new Date(Date.now() - observedSinceMs).toISOString();
  const connectors = [];
  for (const connector of CONNECTORS) {
    const inspected = (await Promise.all(
      connector.files.map((segments) => inspectConfig(join(homeDir, ...segments)))
    )).filter(Boolean);
    const observations = store ? await store.searchActivity({
      tenant_id: tenantId,
      project_id: projectId,
      harness_name: connector.name,
      since,
      limit: 1
    }) : [];
    connectors.push({
      name: connector.name,
      installed: await executableLookup(connector.executable),
      configured: inspected.some((item) => item.configured),
      managed: inspected.some((item) => item.managed),
      observed: observations.length > 0,
      last_observed_at: observations[0]?.occurred_at ?? null,
      configurations: inspected
    });
  }
  const warnings = connectors.flatMap((item) => [
    ...(item.configured && !item.observed ? [{ code: "configured_not_observed", connector: item.name }] : []),
    ...(item.managed && !item.installed ? [{ code: "managed_but_not_installed", connector: item.name }] : []),
    ...(runtimeScope === "system" && item.configured ? [{ code: "user_system_mode_mismatch", connector: item.name }] : [])
  ]);
  return { generated_at: new Date().toISOString(), runtime_scope: runtimeScope, connectors, warnings };
}
