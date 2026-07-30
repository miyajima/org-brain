#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const SUPPORTED = new Set(["codex", "claude", "opencode", "openclaw"]);

export function connectorPlan(agent, options = {}) {
  if (!SUPPORTED.has(agent)) {
    throw new Error(`connector must be one of ${[...SUPPORTED].join(", ")}`);
  }
  const serverCommand = options.command?.trim() || "orgbrain";
  const scope = options.scope === "project" ? "project" : "user";
  if (agent === "codex") {
    return {
      agent,
      transport: "stdio",
      executable: "codex",
      args: ["mcp", "add", "orgbrain", "--", serverCommand, "mcp"],
      verify: ["codex", "mcp", "get", "orgbrain", "--json"],
      documentation: "https://developers.openai.com/codex/mcp/"
    };
  }
  if (agent === "claude") {
    return {
      agent,
      transport: "stdio",
      executable: "claude",
      args: ["mcp", "add", "orgbrain", "--scope", scope, "--", serverCommand, "mcp"],
      verify: ["claude", "mcp", "get", "orgbrain"],
      documentation: "https://docs.anthropic.com/en/docs/claude-code/mcp"
    };
  }
  if (agent === "opencode") {
    return {
      agent,
      transport: "stdio",
      executable: "opencode2",
      args: [
        "mcp",
        "add",
        "orgbrain",
        ...(scope === "user" ? ["--global"] : []),
        "--",
        serverCommand,
        "mcp"
      ],
      verify: ["opencode2", "mcp", "list"],
      documentation: "https://opencode.ai/v2/docs/mcp-servers"
    };
  }
  return {
    agent,
    transport: "stdio",
    executable: null,
    args: null,
    verify: ["openclaw", "config", "validate"],
    config_merge: {
      mcp: {
        servers: {
          orgbrain: {
            transport: "stdio",
            command: serverCommand,
            args: ["mcp"]
          }
        }
      }
    },
    documentation: "https://docs.openclaw.ai/cli/mcp"
  };
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} ${args.join(" ")} exited ${code}`));
    });
  });
}

export async function runConnectorCommand(action, rest, args) {
  if (action !== "setup") throw new Error(`unknown connector command: ${action || "(missing)"}`);
  const agent = rest[0]?.toLowerCase();
  const plan = connectorPlan(agent, {
    command: args.get("--command", "orgbrain"),
    scope: args.get("--scope", "user")
  });
  if (!args.flags.has("--execute")) return { ok: true, dry_run: true, plan };
  if (!plan.executable) {
    throw new Error("OpenClaw setup requires merging plan.config_merge into its config, then running the verify command");
  }
  await run(plan.executable, plan.args);
  return { ok: true, installed: true, agent, verify: plan.verify };
}
