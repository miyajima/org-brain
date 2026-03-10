#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const ROOT = "/Users/miya/projects/org-brain";
const DEFAULT_ENV_FILES = [
  "~/.config/org-brain/hooks.env",
  "~/.openclaw/.env",
  "~/.agents/.env",
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env")
];

function resolveHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function clip(value, limit) {
  if (typeof value !== "string") return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function basenameOrEmpty(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return path.basename(trimmed).slice(0, 128);
}

function parseTimestamp(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 10_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
    }
    if (typeof value === "string" && value.trim()) {
      const maybeNumber = Number(value);
      if (Number.isFinite(maybeNumber)) {
        return parseTimestamp(maybeNumber);
      }
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return undefined;
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
    value = value.replace(/\\n/g, "\n");
    result[key] = value;
  }
  return result;
}

async function loadEnvFallbacks() {
  const configured = process.env.ORGBRAIN_HOOK_ENV_FILES;
  const files = (configured ? configured.split(/[:,;]/) : DEFAULT_ENV_FILES)
    .map((entry) => resolveHome(entry.trim()))
    .filter(Boolean);

  for (const file of files) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = parseEnvText(raw);
      for (const [key, value] of Object.entries(parsed)) {
        if (!process.env[key]) process.env[key] = value;
      }
    } catch {
      // Ignore missing or unreadable env files.
    }
  }
}

function ensureRequiredEnv(key) {
  const value = process.env[key];
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }
  return value.trim();
}

function renderList(title, items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines = [title];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    lines.push(`- ${clip(trimmed, 600)}`);
  }
  return lines.length > 1 ? `${lines.join("\n")}\n` : "";
}

function renderRawPayload(payloadText, parsed) {
  const raw = parsed ? JSON.stringify(parsed, null, 2) : payloadText;
  const body = clip(raw, 12_000);
  return `## Raw Payload\n\n\`\`\`json\n${body}\n\`\`\`\n`;
}

function dedupeTags(tags) {
  return [...new Set(tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim()))].slice(
    0,
    16
  );
}

function buildApiUrl(baseUrl, route) {
  const base = new URL(baseUrl);
  const normalizedRoute = route.replace(/^\/+/, "");
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  return new URL(normalizedRoute, `${base.origin}${basePath}`);
}

function buildFallbackRecord(sourceName, payloadText, parsed) {
  const payloadHash = sha256(payloadText);
  const eventType = firstString(parsed?.type, parsed?.event?.type, "hook");
  const createdAt = parseTimestamp(parsed?.timestamp, parsed?.at, parsed?.created_at) ?? Date.now();
  const cwd = firstString(parsed?.cwd, parsed?.directory, parsed?.worktree, parsed?.context?.workspaceDir);
  const projectId = basenameOrEmpty(cwd);
  const summaryBits = [sourceName, eventType, projectId].filter(Boolean);

  return {
    createdAt,
    eventType,
    projectId: projectId || null,
    externalKey: `${sourceName}:${payloadHash}`,
    summary: clip(summaryBits.join(" "), 240) || `${sourceName} hook event`,
    tags: dedupeTags([sourceName, "hook", eventType, projectId]),
    content: [
      "# Hook Event",
      "",
      `- Source: ${sourceName}`,
      `- Event: ${eventType || "unknown"}`,
      cwd ? `- Cwd: ${cwd}` : "",
      projectId ? `- Project: ${projectId}` : "",
      `- RecordedAt: ${new Date(createdAt).toISOString()}`,
      "",
      renderRawPayload(payloadText, parsed)
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function buildCodexRecord(payloadText, parsed) {
  const threadId = firstString(parsed?.["thread-id"]);
  const turnId = firstString(parsed?.["turn-id"]);
  const eventType = firstString(parsed?.type, "agent-turn-complete");
  const cwd = firstString(parsed?.cwd);
  const client = firstString(parsed?.client);
  const projectId = basenameOrEmpty(cwd);
  const inputs = Array.isArray(parsed?.["input-messages"]) ? parsed["input-messages"] : [];
  const lastAssistant = firstString(parsed?.["last-assistant-message"]);
  const createdAt = parseTimestamp(parsed?.at, parsed?.timestamp) ?? Date.now();
  const summaryParts = [projectId, eventType, clip(lastAssistant || inputs[0] || "", 120)].filter(Boolean);

  return {
    createdAt,
    eventType,
    projectId: projectId || null,
    externalKey: turnId ? `codex:${turnId}` : `codex:${threadId || sha256(payloadText)}`,
    summary: clip(summaryParts.join(" | "), 240) || "codex hook event",
    tags: dedupeTags(["codex", "hook", eventType, projectId]),
    content: [
      "# Codex Hook Event",
      "",
      `- Event: ${eventType}`,
      client ? `- Client: ${client}` : "",
      threadId ? `- ThreadId: ${threadId}` : "",
      turnId ? `- TurnId: ${turnId}` : "",
      cwd ? `- Cwd: ${cwd}` : "",
      projectId ? `- Project: ${projectId}` : "",
      `- RecordedAt: ${new Date(createdAt).toISOString()}`,
      "",
      renderList("## User Messages", inputs),
      lastAssistant ? `## Assistant Message\n\n${clip(lastAssistant, 6_000)}\n` : "",
      renderRawPayload(payloadText, parsed)
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function buildClaudeRecord(payloadText, parsed) {
  const sessionId = firstString(parsed?.session_id);
  const eventType = firstString(parsed?.hook_event_name, parsed?.type, "Stop");
  const cwd = firstString(parsed?.cwd);
  const transcriptPath = firstString(parsed?.transcript_path);
  const projectId = basenameOrEmpty(cwd);
  const lastAssistant = firstString(parsed?.last_assistant_message);
  const createdAt = parseTimestamp(parsed?.at, parsed?.timestamp) ?? Date.now();
  const payloadHash = sha256(payloadText).slice(0, 16);
  const summaryParts = [projectId, eventType, clip(lastAssistant, 120)].filter(Boolean);

  return {
    createdAt,
    eventType,
    projectId: projectId || null,
    externalKey: `claude:${sessionId || payloadHash}:${eventType}:${payloadHash}`,
    summary: clip(summaryParts.join(" | "), 240) || "claude hook event",
    tags: dedupeTags(["claude", "hook", eventType, projectId]),
    content: [
      "# Claude Code Hook Event",
      "",
      `- Event: ${eventType}`,
      sessionId ? `- SessionId: ${sessionId}` : "",
      cwd ? `- Cwd: ${cwd}` : "",
      projectId ? `- Project: ${projectId}` : "",
      transcriptPath ? `- Transcript: ${transcriptPath}` : "",
      `- RecordedAt: ${new Date(createdAt).toISOString()}`,
      "",
      lastAssistant ? `## Assistant Message\n\n${clip(lastAssistant, 6_000)}\n` : "",
      renderRawPayload(payloadText, parsed)
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function buildCursorRecord(payloadText, parsed) {
  const eventType = firstString(parsed?.type, parsed?.event?.type, "afterAgentResponse");
  const cwd = firstString(parsed?.cwd, parsed?.directory, parsed?.workspace, parsed?.projectPath);
  const projectId = basenameOrEmpty(cwd);
  const assistant = firstString(parsed?.message, parsed?.assistant, parsed?.response, parsed?.content);
  const createdAt = parseTimestamp(parsed?.at, parsed?.timestamp) ?? Date.now();
  const payloadHash = sha256(payloadText).slice(0, 16);

  return {
    createdAt,
    eventType,
    projectId: projectId || null,
    externalKey: `cursor:${payloadHash}`,
    summary: clip([projectId, eventType, clip(assistant, 120)].filter(Boolean).join(" | "), 240) || "cursor hook event",
    tags: dedupeTags(["cursor", "hook", eventType, projectId]),
    content: [
      "# Cursor Hook Event",
      "",
      `- Event: ${eventType}`,
      cwd ? `- Cwd: ${cwd}` : "",
      projectId ? `- Project: ${projectId}` : "",
      `- RecordedAt: ${new Date(createdAt).toISOString()}`,
      "",
      assistant ? `## Assistant Message\n\n${clip(assistant, 6_000)}\n` : "",
      renderRawPayload(payloadText, parsed)
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function buildOpenClawRecord(payloadText, parsed) {
  const type = firstString(parsed?.type, parsed?.event?.type, "message");
  const action = firstString(parsed?.action, parsed?.event?.action);
  const eventType = [type, action].filter(Boolean).join(":") || "openclaw";
  const context = parsed?.context && typeof parsed.context === "object" ? parsed.context : {};
  const cwd = firstString(context.workspaceDir, parsed?.workspaceDir);
  const projectId = basenameOrEmpty(cwd);
  const messageId = firstString(context.messageId);
  const sessionKey = firstString(parsed?.sessionKey, context.sessionId, context.sessionKey);
  const body = firstString(context.bodyForAgent, context.content, context.body, context.transcript);
  const createdAt = parseTimestamp(parsed?.timestamp, context.timestamp) ?? Date.now();
  const identity = firstString(messageId, sessionKey, sha256(payloadText).slice(0, 16));

  return {
    createdAt,
    eventType,
    projectId: projectId || null,
    externalKey: `openclaw:${eventType}:${identity}`.slice(0, 256),
    summary: clip([projectId, eventType, clip(body, 120)].filter(Boolean).join(" | "), 240) || "openclaw hook event",
    tags: dedupeTags(["openclaw", "hook", type, action, projectId]),
    content: [
      "# OpenClaw Hook Event",
      "",
      `- Event: ${eventType}`,
      sessionKey ? `- SessionKey: ${sessionKey}` : "",
      messageId ? `- MessageId: ${messageId}` : "",
      cwd ? `- Workspace: ${cwd}` : "",
      projectId ? `- Project: ${projectId}` : "",
      `- RecordedAt: ${new Date(createdAt).toISOString()}`,
      "",
      body ? `## Message\n\n${clip(body, 6_000)}\n` : "",
      renderRawPayload(payloadText, parsed)
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function buildOpenCodeRecord(payloadText, parsed) {
  const event = parsed?.event && typeof parsed.event === "object" ? parsed.event : parsed;
  const eventType = firstString(event?.type, parsed?.type, "event");
  const cwd = firstString(parsed?.directory, parsed?.cwd, parsed?.worktree, event?.cwd);
  const projectId = basenameOrEmpty(cwd);
  const sessionId = firstString(event?.sessionID, event?.sessionId, event?.session?.id);
  const message = firstString(event?.message?.content, event?.message?.summary, event?.content);
  const createdAt = parseTimestamp(event?.time?.created, event?.time?.updated, event?.timestamp, parsed?.timestamp) ?? Date.now();
  const identity = firstString(sessionId, event?.id, sha256(payloadText).slice(0, 16));

  return {
    createdAt,
    eventType,
    projectId: projectId || null,
    externalKey: `opencode:${eventType}:${identity}`.slice(0, 256),
    summary: clip([projectId, eventType, clip(message, 120)].filter(Boolean).join(" | "), 240) || "opencode hook event",
    tags: dedupeTags(["opencode", "hook", eventType, projectId]),
    content: [
      "# OpenCode Hook Event",
      "",
      `- Event: ${eventType}`,
      sessionId ? `- SessionId: ${sessionId}` : "",
      cwd ? `- Cwd: ${cwd}` : "",
      projectId ? `- Project: ${projectId}` : "",
      `- RecordedAt: ${new Date(createdAt).toISOString()}`,
      "",
      message ? `## Message\n\n${clip(message, 6_000)}\n` : "",
      renderRawPayload(payloadText, parsed)
    ]
      .filter(Boolean)
      .join("\n")
  };
}

function normalizeRecord(sourceName, payloadText) {
  const parsed = safeJsonParse(payloadText);
  switch (sourceName) {
    case "codex":
      if (parsed && typeof parsed === "object") return buildCodexRecord(payloadText, parsed);
      break;
    case "claude":
      if (parsed && typeof parsed === "object") return buildClaudeRecord(payloadText, parsed);
      break;
    case "cursor":
      if (parsed && typeof parsed === "object") return buildCursorRecord(payloadText, parsed);
      break;
    case "openclaw":
      if (parsed && typeof parsed === "object") return buildOpenClawRecord(payloadText, parsed);
      break;
    case "opencode":
      if (parsed && typeof parsed === "object") return buildOpenCodeRecord(payloadText, parsed);
      break;
    default:
      break;
  }
  return buildFallbackRecord(sourceName, payloadText, parsed);
}

async function readPayload(argvPayload) {
  if (typeof argvPayload === "string" && argvPayload.length > 0) return argvPayload;
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function postMemory(apiBase, apiKey, tenantId, sourceName, record) {
  const res = await fetch(buildApiUrl(apiBase, "/v1/memories/upsert"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      source: sourceName,
      items: [
        {
          external_key: record.externalKey,
          content: clip(record.content, 20_000),
          summary: clip(record.summary, 1_000),
          tags: record.tags,
          created_at: record.createdAt,
          project_id: record.projectId
        }
      ]
    })
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`org-brain hook upsert failed (${res.status})`);
  }
  return body.data;
}

async function main() {
  const sourceName = firstString(process.argv[2], "unknown");
  const payloadText = await readPayload(process.argv[3]);
  if (!payloadText.trim()) {
    console.log(JSON.stringify({ ok: true, skipped: "empty-payload", source: sourceName }));
    return;
  }

  await loadEnvFallbacks();

  const apiBase = ensureRequiredEnv("ORGBRAIN_API_BASE");
  const apiKey = ensureRequiredEnv("ORGBRAIN_API_KEY");
  const tenantId = ensureRequiredEnv("ORGBRAIN_TENANT_ID") || "default";

  if (!apiBase || !apiKey) {
    console.log(
      JSON.stringify({
        ok: true,
        skipped: "missing-orgbrain-env",
        source: sourceName
      })
    );
    return;
  }

  const record = normalizeRecord(sourceName, payloadText);
  const result = await postMemory(apiBase, apiKey, tenantId, sourceName, record);
  console.log(
    JSON.stringify({
      ok: true,
      source: sourceName,
      tenant_id: tenantId,
      external_key: record.externalKey,
      inserted: Number(result?.inserted ?? 0),
      updated: Number(result?.updated ?? 0)
    })
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
