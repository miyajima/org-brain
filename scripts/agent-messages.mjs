#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TARGET_TYPES = new Set(["principal", "agent", "project", "channel"]);
const DEFAULT_ENV_FILES = [
  "~/.config/org-brain/hooks.env",
  "~/.openclaw/.env",
  "~/.agents/.env",
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), ".env")
];

function printHelp() {
  console.log(`OrgBrain agent messages

Usage:
  pnpm agmsg send --to <type:key> --body <text> [--subject <text>] [--project-id <id>]
  pnpm agmsg inbox [--target <type:key>] [--status active|unread|read|acked|archived] [--limit <n>]
  pnpm agmsg read <message-id> [--target <type:key>]
  pnpm agmsg ack <message-id> [--target <type:key>]

Target types:
  principal:<principal>, agent:<agent-id>, project:<project-id>, channel:<channel-id>

Environment:
  ORGBRAIN_API_URL   Canonical API base URL
  ORGBRAIN_API_BASE  Compatibility alias if ORGBRAIN_API_URL is unset
  ORGBRAIN_API_KEY   API key
  ORGBRAIN_TENANT_ID Tenant id (default: default)
`);
}

function resolveHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseEnvText(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    result[key] = value.replace(/\\n/g, "\n");
  }
  return result;
}

export async function loadEnvFallbacks() {
  const configured = process.env.ORGBRAIN_HOOK_ENV_FILES;
  const files = (configured ? configured.split(/[:,;]/) : DEFAULT_ENV_FILES)
    .map((entry) => resolveHome(entry.trim()))
    .filter(Boolean);

  for (const file of files) {
    try {
      const parsed = parseEnvText(await readFile(file, "utf8"));
      for (const [key, value] of Object.entries(parsed)) {
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {
      // Missing env files are expected on fresh installs.
    }
  }
}

function getOptionalEnv(key) {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function getRequiredEnv(key) {
  const value = getOptionalEnv(key);
  if (!value) throw new Error(`Missing required env: ${key}`);
  return value;
}

export function resolveApiBase(env = process.env) {
  const canonical = typeof env.ORGBRAIN_API_URL === "string" ? env.ORGBRAIN_API_URL.trim() : "";
  if (canonical) return canonical;
  const alias = typeof env.ORGBRAIN_API_BASE === "string" ? env.ORGBRAIN_API_BASE.trim() : "";
  if (alias) return alias;
  throw new Error("Missing required env: ORGBRAIN_API_URL");
}

export function buildApiUrl(baseUrl, route) {
  const base = new URL(baseUrl);
  const normalizedRoute = route.replace(/^\/+/, "");
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return new URL(normalizedRoute, `${base.origin}${basePath}`);
}

export function parseTarget(raw) {
  if (!raw) return null;
  const separator = raw.indexOf(":");
  if (separator <= 0) {
    throw new Error(`Invalid target: ${raw}`);
  }
  const targetType = raw.slice(0, separator);
  const targetKey = raw.slice(separator + 1).trim();
  if (!TARGET_TYPES.has(targetType) || !targetKey) {
    throw new Error(`Invalid target: ${raw}`);
  }
  return { target_type: targetType, target_key: targetKey };
}

function normalizeInt(raw, fallback, min, max) {
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseArgs(argv) {
  const options = {
    command: argv[0] ?? "help",
    positional: [],
    to: "",
    target: "",
    body: "",
    subject: "",
    projectId: "",
    threadId: "",
    replyToMessageId: "",
    idempotencyKey: "",
    status: "active",
    limit: 50,
    cursor: "",
    metadataJson: ""
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++index]);
    if (arg === "--to" || arg.startsWith("--to=")) {
      options.to = readValue();
    } else if (arg === "--target" || arg.startsWith("--target=")) {
      options.target = readValue();
    } else if (arg === "--body" || arg.startsWith("--body=")) {
      options.body = readValue();
    } else if (arg === "--subject" || arg.startsWith("--subject=")) {
      options.subject = readValue();
    } else if (arg === "--project-id" || arg.startsWith("--project-id=")) {
      options.projectId = readValue();
    } else if (arg === "--thread-id" || arg.startsWith("--thread-id=")) {
      options.threadId = readValue();
    } else if (arg === "--reply-to-message-id" || arg.startsWith("--reply-to-message-id=")) {
      options.replyToMessageId = readValue();
    } else if (arg === "--idempotency-key" || arg.startsWith("--idempotency-key=")) {
      options.idempotencyKey = readValue();
    } else if (arg === "--status" || arg.startsWith("--status=")) {
      options.status = readValue();
    } else if (arg === "--limit" || arg.startsWith("--limit=")) {
      options.limit = normalizeInt(readValue(), 50, 1, 200);
    } else if (arg === "--cursor" || arg.startsWith("--cursor=")) {
      options.cursor = readValue();
    } else if (arg === "--metadata-json" || arg.startsWith("--metadata-json=")) {
      options.metadataJson = readValue();
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    } else {
      options.positional.push(arg);
    }
  }

  return options;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function fetchApiJson(baseUrl, apiKey, route, init = {}) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    ...(init.headers ?? {})
  };
  const response = await fetch(buildApiUrl(baseUrl, route), {
    ...init,
    headers
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const message = payload?.error?.message ?? "unexpected API response";
    throw new Error(`API request failed (${response.status}) route=${route}: ${message}`);
  }
  return payload.data;
}

function parseMetadataJson(raw) {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--metadata-json must be a JSON object");
  }
  return parsed;
}

async function run(options) {
  if (options.command === "help") {
    printHelp();
    return;
  }

  await loadEnvFallbacks();
  const apiBase = resolveApiBase();
  const apiKey = getRequiredEnv("ORGBRAIN_API_KEY");
  const tenantId = getOptionalEnv("ORGBRAIN_TENANT_ID") || "default";

  if (options.command === "send") {
    const target = parseTarget(options.to);
    if (!target) throw new Error("send requires --to <type:key>");
    const stdinBody = options.body ? "" : await readStdin();
    const body = (options.body || stdinBody).trim();
    if (!body) throw new Error("send requires --body or stdin content");

    const data = await fetchApiJson(apiBase, apiKey, "/v1/agent-messages", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        project_id: options.projectId || undefined,
        ...target,
        subject: options.subject || undefined,
        body,
        metadata: parseMetadataJson(options.metadataJson),
        thread_id: options.threadId || undefined,
        reply_to_message_id: options.replyToMessageId || undefined,
        idempotency_key: options.idempotencyKey || undefined
      })
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (options.command === "inbox") {
    const target = parseTarget(options.target);
    const query = new URLSearchParams({
      tenant_id: tenantId,
      status: options.status || "active",
      limit: String(options.limit)
    });
    if (target) {
      query.set("target_type", target.target_type);
      query.set("target_key", target.target_key);
    }
    if (options.projectId) query.set("project_id", options.projectId);
    if (options.cursor) query.set("cursor", options.cursor);
    const data = await fetchApiJson(apiBase, apiKey, `/v1/agent-messages?${query.toString()}`);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (options.command === "read" || options.command === "ack") {
    const messageId = options.positional[0];
    if (!messageId) throw new Error(`${options.command} requires <message-id>`);
    const target = parseTarget(options.target);
    const data = await fetchApiJson(apiBase, apiKey, `/v1/agent-messages/${encodeURIComponent(messageId)}/${options.command}`, {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        ...(target ?? {})
      })
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${options.command}`);
}

export async function main(argv = process.argv.slice(2)) {
  await run(parseArgs(argv));
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
