#!/usr/bin/env node

import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { memoryModeFields, resolveMemoryMode } from "./lib/memory-mode.mjs";
import { assessMemoryUsefulness, classifyMemoryQuality } from "./lib/memory-quality.mjs";
import {
  buildMemoryCaptureCandidateJson,
  buildProjectCategoryIdentity,
  extractDurableMemoryDrafts
} from "../../shared/src/memory-capture-v2-runtime.mjs";
import { MEMORY_CAPTURE_HOOK_PROFILE } from "../../shared/src/memory-capture-profile.generated.mjs";
import {
  MEMORY_CONTRACT_V2_PROMPT_ID,
  MEMORY_CONTRACT_V2_VERIFIER_VERSION
} from "../../shared/src/memory-contract-v2-runtime.mjs";
import {
  MEMORY_CONTRACT_V2_CONTRACT_HASH,
  MEMORY_CONTRACT_V2_PROMPT_HASH
} from "../../shared/src/memory-contract-v2-contract.mjs";
import {
  collectVerifiedLearningEvents,
  collectVerifiedLearningEventsFromRows
} from "./lib/memory-learning-transcript.mjs";
import {
  configuredTenantFromEnv,
  legacyProjectNamesFileFromEnv,
  loadLegacyProjectNames,
  loadWorkspaceConfig,
  migrateLegacyProjectNames,
  normalizeWorkspaceRoot,
  autonomyPolicyFromWorkspaceConfig,
  saveWorkspaceConfig,
  tenantFallbackFromEnv,
  withWorkspaceConfigLock,
  workspacesFileFromEnv
} from "./lib/workspace-config.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_ENV_FILES = [
  "~/.config/org-brain/hooks.env",
  "~/.openclaw/.env",
  "~/.agents/.env",
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env")
];
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_CAPTURE_TOOL = "orgbrain_memories_capture_rationale";
const MCP_LEARNING_BATCH_TOOL = "orgbrain_learning_batch_ingest";
const CAPTURE_TIMEOUT_MS = 5_000;
const INSTALLATION_CREDENTIAL_KEYS = new Set([
  "ORGBRAIN_MCP_URL",
  "ORGBRAIN_MCP_CLIENT_ID",
  "ORGBRAIN_MCP_CLIENT_SECRET",
  "ORGBRAIN_CLIENT_INSTALLATION_ID",
  "ORGBRAIN_HOOK_OUTBOX",
  "ORGBRAIN_TENANT_ID"
]);
const LEGACY_HOOK_CREDENTIAL_KEYS = new Set([
  "ORGBRAIN_API_URL",
  "ORGBRAIN_API_BASE",
  "ORGBRAIN_API_KEY"
]);
const validatedMcpConfigurations = new WeakSet();
const OUTBOX_CLAIM_STALE_MS = 5 * 60 * 1000;

const CAUSE_KEYWORDS = ["原因", "理由", "root cause", "because", "why"];
const FIX_KEYWORDS = ["対処", "再発防止", "fix", "fixed", "workaround", "resolve", "resolved", "solution"];
const POLICY_KEYWORDS = ["always", "never", "must", "方針", "ルール", "前提", "原則", "recommend", "recommended"];
const RESULT_KEYWORDS = ["成功", "failed", "failure", "succeeded", "success", "通った", "完了", "確認", "restored", "回復", "freed"];
const META_ONLY_PATTERNS = [
  /^必要な作業は終わっています/,
  /^ほかに進める内容があれば/,
  /^done\b/i,
  /^thanks?\b/i,
  /^ありがとう/,
  /^よろしく/,
  /^必要なら/
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

function parseExplicitProjectId(value) {
  if (value === undefined) return { provided: false, value: null };
  if (value === null) return { provided: true, value: null };
  if (typeof value !== "string") return { provided: false, value: null };
  const trimmed = value.trim();
  if (!trimmed) return { provided: true, value: null };
  if (["null", "(none)", "none", "global", "tenant"].includes(trimmed.toLowerCase())) {
    return { provided: true, value: null };
  }
  return { provided: true, value: basenameOrEmpty(trimmed) || null };
}

function readExplicitProjectId(parsed, extras = {}) {
  if (Object.prototype.hasOwnProperty.call(extras, "projectId")) {
    return extras.projectId;
  }
  if (parsed && typeof parsed === "object") {
    if (Object.prototype.hasOwnProperty.call(parsed, "project_id")) return parsed.project_id;
    if (Object.prototype.hasOwnProperty.call(parsed, "projectId")) return parsed.projectId;
    if (
      parsed.context &&
      typeof parsed.context === "object" &&
      Object.prototype.hasOwnProperty.call(parsed.context, "projectId")
    ) {
      return parsed.context.projectId;
    }
  }
  return undefined;
}

function normalizeProjectName(value, fallback = "") {
  const trimmed = firstString(value, fallback).slice(0, 128);
  return trimmed || null;
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

export async function loadEnvFallbacks() {
  const configured = process.env.ORGBRAIN_HOOK_ENV_FILES;
  const files = (configured ? configured.split(/[:,;]/) : DEFAULT_ENV_FILES)
    .map((entry) => resolveHome(entry.trim()))
    .filter(Boolean);

  if (configured) {
    // An explicitly selected installation file is an identity boundary. Never
    // inherit these values when that file is missing, unreadable, or incomplete.
    for (const key of INSTALLATION_CREDENTIAL_KEYS) delete process.env[key];
    for (const key of LEGACY_HOOK_CREDENTIAL_KEYS) delete process.env[key];
  }

  for (const [index, file] of files.entries()) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = parseEnvText(raw);
      for (const [key, value] of Object.entries(parsed)) {
        if (configured && LEGACY_HOOK_CREDENTIAL_KEYS.has(key)) {
          continue;
        } else if (configured && INSTALLATION_CREDENTIAL_KEYS.has(key)) {
          if (index === 0) process.env[key] = value;
        } else if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    } catch {
      if (configured && index === 0) break;
      // Ignore missing or unreadable fallback env files.
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

function normalizeWhitespace(value) {
  return firstString(value)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const HOOK_SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
  /\b(?:sk|sk-proj|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/giu,
  /\b(?:api[_-]?key|client[_-]?secret|password|passwd|token)\s*[:=]\s*["']?[^\s"',;]{8,}/giu
];
const HOOK_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const HOOK_PHONE_PATTERN = /(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)/gu;

export function redactHookMemoryText(value) {
  let redacted = String(value ?? "");
  for (const pattern of HOOK_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED_SECRET]");
  }
  return redacted
    .replace(HOOK_EMAIL_PATTERN, "[REDACTED_EMAIL]")
    .replace(HOOK_PHONE_PATTERN, (candidate) => {
      const digits = candidate.replace(/\D/gu, "");
      if (digits.length < 10 || digits.length > 15 || !/[+() -]/u.test(candidate)) return candidate;
      if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/u.test(candidate)) return candidate;
      return "[REDACTED_PHONE]";
    });
}

function normalizeForAnalysis(value) {
  return normalizeWhitespace(value)
    .replace(/[`*_>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, keywords) {
  const lowered = text.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword.toLowerCase()));
}

function countActionableLines(text) {
  return normalizeWhitespace(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)).length;
}

function extractCommands(text) {
  const commandMatches = normalizeWhitespace(text).match(/`[^`\n]+`/g) ?? [];
  return [...new Set(commandMatches.map((match) => match.slice(1, -1).trim()).filter(Boolean))].slice(0, 3);
}

function splitIntoSentences(text) {
  return normalizeWhitespace(text)
    .split(/(?<=[。.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractMeaningfulSentences(text, limit = 3) {
  const sentences = splitIntoSentences(text);
  const selected = [];
  for (const sentence of sentences) {
    if (sentence.length < 20) continue;
    selected.push(sentence);
    if (selected.length >= limit) break;
  }
  return selected.length > 0 ? selected : sentences.slice(0, limit);
}

function chooseTitle(text) {
  const preferred = splitIntoSentences(text).find(
    (sentence) => containsAny(sentence, CAUSE_KEYWORDS) || containsAny(sentence, FIX_KEYWORDS)
  );
  return clip((preferred || splitIntoSentences(text)[0] || "Reusable memory").replace(/\s+/g, " "), 100);
}

function chooseCategory(text, signals) {
  if (signals.hasCauseAndFix) return "diagnosis";
  if (signals.hasPolicy) return "policy";
  if (signals.hasCommandAndResult) return "command-result";
  return "workaround";
}

function buildReuseRule(text, category, commands) {
  const sentences = extractMeaningfulSentences(text, 4);
  const causeSentence =
    sentences.find((sentence) => containsAny(sentence, CAUSE_KEYWORDS) || containsAny(sentence, POLICY_KEYWORDS)) ||
    sentences[0] ||
    "Reuse this only when the same symptom and workspace context match.";
  const fixSentence =
    sentences.find((sentence) => containsAny(sentence, FIX_KEYWORDS) || containsAny(sentence, RESULT_KEYWORDS)) ||
    sentences[1] ||
    causeSentence;

  if (category === "policy") {
    return clip(
      `Apply this as a default rule: ${causeSentence}\nRe-check only if the environment or auth model changed.`,
      500
    );
  }

  if (category === "command-result" && commands.length > 0) {
    return clip(
      `When the same symptom appears, run ${commands.map((command) => `\`${command}\``).join(", ")} first.\nTreat the result as confirmed only if the follow-up command succeeds.`,
      500
    );
  }

  if (category === "diagnosis") {
    return clip(`If the same symptom recurs, assume ${causeSentence}\nApply ${fixSentence}`, 500);
  }

  return clip(
    `Reuse this workaround only for the same project pattern.\nValidate with the same check after applying: ${fixSentence}`,
    500
  );
}

function buildPromotedContent(record, category, normalizedText) {
  const takeaway = extractMeaningfulSentences(record.assistantText || normalizedText, 3).join("\n\n");
  const evidence = clip(normalizeWhitespace(record.assistantText || normalizedText), 1_200);
  const commands = extractCommands(record.assistantText || normalizedText);
  const reuseRule = buildReuseRule(record.assistantText || normalizedText, category, commands);

  return [
    "# Reusable Memory",
    "",
    `- Source: ${record.sourceName}`,
    `- Event: ${record.eventType || "unknown"}`,
    `- Project: ${record.projectId || "(global)"}`,
    `- RecordedAt: ${new Date(record.createdAt).toISOString()}`,
    "",
    "## Takeaway",
    takeaway || "No takeaway extracted.",
    "",
    "## Evidence",
    evidence || "No evidence extracted.",
    "",
    "## Reuse Rule",
    reuseRule
  ].join("\n");
}

function buildPromotedSummary(record, normalizedText) {
  const tags = [record.sourceName, "hook", "promoted", record.eventType, record.projectId ?? "global-scope"].filter(Boolean);
  return assessMemoryUsefulness(
    {
      project_id: record.projectId,
      summary: `${record.projectId || "(global)"} | promoted-memory | ${chooseTitle(normalizedText)}`,
      content: record.assistantText || normalizedText,
      tags,
      created_at: record.createdAt
    },
    { keepProjectFacts: true }
  ).summary;
}

function parseCommaTags(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function buildLearningEntryContent(record, entry) {
  const label = entry.type === "project-fact" ? "Project Fact" : "Learning Entry";
  const actor = buildActorId(record);
  const decision = firstString(entry.decision, entry.result, entry.action, "No decision provided.");
  const reason = firstString(entry.reason, entry.trigger, "No reason provided.");
  const evidence = firstString(entry.evidence, record.externalKey, "No evidence reference provided.");
  return [
    `# ${label}`,
    "",
    `- Source: ${record.sourceName}`,
    `- Event: ${record.eventType || "unknown"}`,
    `- Project: ${record.projectId || "(none)"}`,
    `- RecordedAt: ${new Date(record.createdAt).toISOString()}`,
    `- EntryType: ${firstString(entry.type, "unknown")}`,
    `- Who: ${actor}`,
    `- When: ${new Date(record.createdAt).toISOString()}`,
    "",
    "## Trigger",
    firstString(entry.trigger, "No trigger provided."),
    "",
    "## Decision",
    decision,
    "",
    "## Reason",
    reason,
    "",
    "## Evidence",
    evidence,
    "",
    "## Action",
    firstString(entry.action, "No action provided."),
    "",
    "## Result",
    firstString(entry.result, "No result provided."),
    "",
    "## Reuse Rule",
    firstString(entry.reuse, "Reuse only when the same condition is confirmed."),
    "",
    "## Validity",
    firstString(entry.validity, "Valid until the project, toolchain, or external service behavior changes.")
  ].join("\n");
}

function prepareStructuredLearningEntry(record, parsed) {
  const entry = parsed?.memory_entry;
  if (!entry || typeof entry !== "object") return null;
  const type = firstString(entry.type);
  if (!["failure", "success", "preference", "project-fact"].includes(type)) return null;

  const tags = dedupeTags([
    record.sourceName,
    "hook",
    "learning-loop",
    type,
    type === "project-fact" ? "curated-memory" : "",
    record.projectId,
    ...parseCommaTags(firstString(entry.tags))
  ]);
  const summaryBase = firstString(entry.result, entry.action, entry.trigger, "confirmed learning");

  return {
    action: "promote",
    record: {
      externalKey: firstString(record.externalKey, `learning:${sha256(JSON.stringify(entry))}`),
      createdAt: record.createdAt,
      cwd: record.cwd,
      projectId: record.projectId,
      projectIdExplicit: record.projectIdExplicit,
      businessCategoryId: record.businessCategoryId,
      workType: record.workType,
      summary: clip(`${record.projectId || "(none)"} | ${type} | ${summaryBase}`, 1_000),
      tags,
      content: buildLearningEntryContent(record, entry),
      actorType: "system",
      actorId: buildActorId(record)
    }
  };
}

function buildActorId(record) {
  const metadata = record?.metadata ?? {};
  const stableId = firstString(metadata.turnId, metadata.threadId, metadata.sessionId, metadata.sessionKey, metadata.messageId);
  return stableId ? `${record.sourceName}:${stableId}`.slice(0, 128) : firstString(record.sourceName, "unknown").slice(0, 128);
}

export function classifyMemoryRecord(record) {
  if (!record.projectId && !record.projectIdExplicit) {
    return { action: "skip", reason: "missing-project" };
  }

  const assistantText = normalizeWhitespace(record.assistantText);
  if (!assistantText) {
    return { action: "skip", reason: "missing-assistant-text" };
  }

  const normalized = normalizeForAnalysis(assistantText);
  if (normalized.length < 120) {
    return { action: "skip", reason: "low-signal-text" };
  }

  if (META_ONLY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { action: "skip", reason: "meta-only" };
  }

  const quality = classifyMemoryQuality({
    summary: buildPromotedSummary(record, normalized),
    content: assistantText,
    tags: [record.sourceName, "hook", record.eventType, record.projectId ?? "global-scope"].filter(Boolean)
  });
  if (quality.action === "delete") {
    return { action: "skip", reason: quality.reason };
  }

  const hasCause = containsAny(normalized, CAUSE_KEYWORDS);
  const hasFix = containsAny(normalized, FIX_KEYWORDS);
  const hasPolicy = containsAny(normalized, POLICY_KEYWORDS);
  const hasCommandAndResult = extractCommands(assistantText).length > 0 && containsAny(normalized, RESULT_KEYWORDS);
  const signals = {
    hasCauseAndFix: hasCause && (hasFix || hasCommandAndResult || hasPolicy),
    hasCommandAndResult,
    hasPolicy,
    hasActionableList: countActionableLines(assistantText) >= 2
  };

  if (!Object.values(signals).some(Boolean)) {
    return { action: "skip", reason: "low-signal-text" };
  }

  return {
    action: "promote",
    category: chooseCategory(normalized, signals),
    normalizedText: normalized,
    signals
  };
}

function buildCommonRecord(sourceName, payloadText, parsed, extras = {}) {
  const createdAt = parseTimestamp(parsed?.timestamp, parsed?.at, parsed?.created_at) ?? Date.now();
  const cwd = firstString(parsed?.cwd, parsed?.directory, parsed?.worktree, parsed?.context?.workspaceDir, extras.cwd);
  const explicitProject = parseExplicitProjectId(readExplicitProjectId(parsed, extras));
  const projectId = explicitProject.provided ? explicitProject.value : basenameOrEmpty(cwd || extras.cwd);
  const assistantText = normalizeWhitespace(firstString(extras.assistantText));
  const userInputs = Array.isArray(extras.userInputs) ? extras.userInputs.map((item) => firstString(item)).filter(Boolean) : [];

  return {
    sourceName,
    createdAt,
    cwd: cwd || null,
    eventType: firstString(extras.eventType, parsed?.type, parsed?.event?.type, "hook"),
    projectId: projectId || null,
    projectIdExplicit: explicitProject.provided,
    businessCategoryId: firstString(parsed?.business_category_id, parsed?.memory_entry?.business_category_id) || null,
    workType: firstString(parsed?.work_type, parsed?.memory_entry?.work_type) || null,
    externalKey: firstString(extras.externalKey, `${sourceName}:${sha256(payloadText)}`),
    assistantText,
    userInputs,
    metadata: extras.metadata ?? {}
  };
}

function buildFallbackRecord(sourceName, payloadText, parsed) {
  return buildCommonRecord(sourceName, payloadText, parsed, {
    assistantText: firstString(parsed?.message, parsed?.content, parsed?.summary)
  });
}

function buildCodexRecord(payloadText, parsed) {
  const threadId = firstString(parsed?.["thread-id"]);
  const turnId = firstString(parsed?.["turn-id"]);
  const inputs = Array.isArray(parsed?.["input-messages"]) ? parsed["input-messages"] : [];

  return buildCommonRecord("codex", payloadText, parsed, {
    eventType: firstString(parsed?.type, "agent-turn-complete"),
    externalKey: turnId ? `codex:${turnId}` : `codex:${threadId || sha256(payloadText)}`,
    assistantText: firstString(parsed?.["last-assistant-message"]),
    userInputs: inputs,
    metadata: {
      client: firstString(parsed?.client),
      threadId,
      turnId
    }
  });
}

function buildCodexStopRecord(payloadText, parsed) {
  const sessionId = firstString(parsed?.session_id);
  const turnId = firstString(parsed?.turn_id);
  return buildCommonRecord("codex", payloadText, parsed, {
    eventType: firstString(parsed?.hook_event_name, "Stop"),
    externalKey: `codex:${turnId || sessionId || sha256(payloadText)}`,
    assistantText: firstString(parsed?.last_assistant_message),
    metadata: {
      sessionId,
      turnId,
      transcriptPath: firstString(parsed?.transcript_path)
    }
  });
}

function buildClaudeRecord(payloadText, parsed) {
  const sessionId = firstString(parsed?.session_id);
  const payloadHash = sha256(payloadText).slice(0, 16);
  const eventType = firstString(parsed?.hook_event_name, parsed?.type, "Stop");

  return buildCommonRecord("claude", payloadText, parsed, {
    eventType,
    externalKey: `claude:${sessionId || payloadHash}:${eventType}:${payloadHash}`,
    assistantText: firstString(parsed?.last_assistant_message),
    metadata: {
      sessionId,
      transcriptPath: firstString(parsed?.transcript_path)
    }
  });
}

function buildCursorRecord(payloadText, parsed) {
  return buildCommonRecord("cursor", payloadText, parsed, {
    eventType: firstString(parsed?.type, parsed?.event?.type, "afterAgentResponse"),
    externalKey: `cursor:${sha256(payloadText).slice(0, 16)}`,
    assistantText: firstString(parsed?.message, parsed?.assistant, parsed?.response, parsed?.content),
    metadata: {}
  });
}

function buildOpenClawRecord(payloadText, parsed) {
  const context = parsed?.context && typeof parsed.context === "object" ? parsed.context : {};
  const type = firstString(parsed?.type, parsed?.event?.type, "message");
  const action = firstString(parsed?.action, parsed?.event?.action);
  const eventType = [type, action].filter(Boolean).join(":") || "openclaw";
  const messageId = firstString(context.messageId);
  const sessionKey = firstString(parsed?.sessionKey, context.sessionId, context.sessionKey);
  const body = firstString(context.bodyForAgent, context.content, context.body, context.transcript);
  const identity = firstString(messageId, sessionKey, sha256(payloadText).slice(0, 16));

  return buildCommonRecord("openclaw", payloadText, parsed, {
    eventType,
    cwd: firstString(context.workspaceDir, parsed?.workspaceDir),
    externalKey: `openclaw:${eventType}:${identity}`.slice(0, 256),
    assistantText: body,
    metadata: {
      sessionKey,
      messageId
    }
  });
}

function buildOpenCodeRecord(payloadText, parsed) {
  const event = parsed?.event && typeof parsed.event === "object" ? parsed.event : parsed;
  const eventType = firstString(event?.type, parsed?.type, "event");
  const sessionId = firstString(event?.sessionID, event?.sessionId, event?.session?.id);
  const identity = firstString(sessionId, event?.id, sha256(payloadText).slice(0, 16));

  return buildCommonRecord("opencode", payloadText, parsed, {
    eventType,
    cwd: firstString(parsed?.directory, parsed?.cwd, parsed?.worktree, event?.cwd),
    externalKey: `opencode:${eventType}:${identity}`.slice(0, 256),
    assistantText: firstString(event?.message?.content, event?.message?.summary, event?.content),
    metadata: {
      sessionId
    }
  });
}

export function normalizeRecord(sourceName, payloadText) {
  const parsed = safeJsonParse(payloadText);
  switch (sourceName) {
    case "codex":
      if (parsed && typeof parsed === "object") return buildCodexRecord(payloadText, parsed);
      break;
    case "codex-stop":
      if (parsed && typeof parsed === "object") return buildCodexStopRecord(payloadText, parsed);
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

export function prepareMemoryRecordForUpsert(sourceName, payloadText) {
  const record = normalizeRecord(sourceName, payloadText);
  const parsed = safeJsonParse(payloadText);
  const structured = prepareStructuredLearningEntry(record, parsed);
  if (structured) {
    return structured;
  }
  const classification = classifyMemoryRecord(record);
  if (classification.action === "skip") {
    return { action: "skip", reason: classification.reason, record };
  }

  const tags = dedupeTags([
    record.sourceName,
    "hook",
    "promoted",
    record.eventType,
    record.projectId ?? "global-scope",
    classification.category
  ]);

  return {
    action: "promote",
    record: {
      externalKey: record.externalKey,
      createdAt: record.createdAt,
      cwd: record.cwd,
      projectId: record.projectId,
      projectIdExplicit: record.projectIdExplicit,
      businessCategoryId: record.businessCategoryId,
      workType: record.workType,
      summary: buildPromotedSummary(record, classification.normalizedText),
      tags,
      content: buildPromotedContent(record, classification.category, classification.normalizedText),
      actorType: "system",
      actorId: buildActorId(record)
    }
  };
}

async function promptForProjectName(cwd, fallbackProjectId, input = process.stdin, output = process.stderr) {
  if (!input?.isTTY || !output?.isTTY) return fallbackProjectId;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`Org Brain project name for ${cwd} [${fallbackProjectId}]: `);
    return normalizeProjectName(answer, fallbackProjectId);
  } finally {
    rl.close();
  }
}

async function openTtyStreams() {
  try {
    const input = createReadStream("/dev/tty");
    const output = createWriteStream("/dev/tty");
    return {
      input,
      output,
      close: () => {
        input.destroy();
        output.end();
      }
    };
  } catch {
    return null;
  }
}

async function selectProjectName(cwd, fallbackProjectId, options) {
  if (options.prompt === false) return fallbackProjectId;
  if (typeof options.prompt === "function") {
    return normalizeProjectName(await options.prompt(cwd, fallbackProjectId), fallbackProjectId);
  }
  const tty = await openTtyStreams();
  if (!tty) return fallbackProjectId;
  try {
    return await promptForProjectName(cwd, fallbackProjectId, tty.input, tty.output);
  } finally {
    tty.close();
  }
}

export async function resolveWorkspaceContext(record, options = {}) {
  const env = options.env ?? process.env;
  const memoryMode = options.memoryMode ?? resolveMemoryMode(env);
  const cwd = normalizeWorkspaceRoot(firstString(record?.cwd));
  const workspacesFile = options.workspacesFile ?? options.file ?? workspacesFileFromEnv(env);
  const legacyFile = options.legacyFile ?? legacyProjectNamesFileFromEnv(env);
  const fallbackProjectId = normalizeProjectName(record?.projectId, basenameOrEmpty(cwd));
  let promptedProjectId;

  if (
    !options.config &&
    !record?.projectIdExplicit &&
    cwd &&
    fallbackProjectId &&
    options.prompt !== false
  ) {
    const previewConfig = await loadWorkspaceConfig(workspacesFile);
    const previewMapped = previewConfig.workspaces[cwd];
    const previewLegacy =
      options.migrateLegacy === false
        ? {}
        : options.legacyNames ?? await loadLegacyProjectNames(legacyFile);
    const legacyMapped = Object.prototype.hasOwnProperty.call(previewLegacy, cwd);
    const tenantResolvable =
      !memoryMode.orgSharingEnabled ||
      Boolean(previewMapped?.tenant_id) ||
      Boolean(configuredTenantFromEnv(env));
    if (!previewMapped && !legacyMapped && tenantResolvable) {
      promptedProjectId = await selectProjectName(cwd, fallbackProjectId, options);
    }
  }

  const resolveLocked = async () => {
    const config = options.config ?? await loadWorkspaceConfig(workspacesFile);
    const configuredTenantId = configuredTenantFromEnv(env);
    let changed = false;
    let mapped = cwd ? config.workspaces[cwd] : null;

    let tenantId = mapped?.tenant_id ?? tenantFallbackFromEnv(env, {
      organizationSharing: memoryMode.orgSharingEnabled
    });

    if (!mapped && options.migrateLegacy !== false) {
      const legacyNames = options.legacyNames ?? await loadLegacyProjectNames(legacyFile);
      const migration = migrateLegacyProjectNames(config, legacyNames, configuredTenantId);
      changed = migration.changed;
      mapped = cwd ? config.workspaces[cwd] : null;
      tenantId = mapped?.tenant_id ?? tenantId;
    }

    if (mapped && !mapped.tenant_id && configuredTenantId) {
      mapped.tenant_id = configuredTenantId;
      tenantId = configuredTenantId;
      changed = true;
    }

    if (record?.projectIdExplicit) {
      if (changed) await saveWorkspaceConfig(workspacesFile, config);
      return {
        tenantId,
        projectId: record.projectId ?? null,
        businessCategoryId: record.businessCategoryId ?? mapped?.business_category_id ?? null,
        workType: record.workType ?? mapped?.default_work_type ?? "other",
        sensitiveMemory: mapped?.sensitive_memory ?? { mode: "deny", allowed_principals: [] },
        memoryCaptureV2Mode: mapped?.memory_capture_v2_mode ?? null,
        memoryLearningMode: mapped?.memory_learning_mode ?? "off",
        autonomy: autonomyPolicyFromWorkspaceConfig(mapped, config, tenantId),
        workspaceRoot: cwd || null,
        source: mapped ? "workspace+explicit-project" : "explicit-project"
      };
    }

    if (mapped) {
      if (changed) await saveWorkspaceConfig(workspacesFile, config);
      return {
        tenantId,
        projectId: mapped.project_id,
        businessCategoryId: record.businessCategoryId ?? mapped.business_category_id ?? null,
        workType: record.workType ?? mapped.default_work_type ?? "other",
        sensitiveMemory: mapped.sensitive_memory ?? { mode: "deny", allowed_principals: [] },
        memoryCaptureV2Mode: mapped.memory_capture_v2_mode ?? null,
        memoryLearningMode: mapped.memory_learning_mode ?? "off",
        autonomy: autonomyPolicyFromWorkspaceConfig(mapped, config, tenantId),
        workspaceRoot: cwd,
        source: "workspace"
      };
    }

    if (!cwd || !fallbackProjectId) {
      if (changed) await saveWorkspaceConfig(workspacesFile, config);
      return {
        tenantId,
        projectId: fallbackProjectId,
        businessCategoryId: record.businessCategoryId ?? null,
        workType: record.workType ?? "other",
        sensitiveMemory: { mode: "deny", allowed_principals: [] },
        memoryCaptureV2Mode: null,
        memoryLearningMode: "off",
        autonomy: autonomyPolicyFromWorkspaceConfig(null, config, tenantId),
        workspaceRoot: cwd || null,
        source: "fallback"
      };
    }

    const selected = options.config
      ? await selectProjectName(cwd, fallbackProjectId, options)
      : promptedProjectId ?? fallbackProjectId;

    config.workspaces[cwd] = {
      tenant_id: configuredTenantId,
      project_id: selected,
      business_category_id: null,
      default_work_type: null,
      sensitive_memory: { mode: "deny", allowed_principals: [] },
      memory_learning_mode: "off",
      autonomy: autonomyPolicyFromWorkspaceConfig(null, config, tenantId)
    };
    await saveWorkspaceConfig(workspacesFile, config);
    return {
      tenantId,
      projectId: selected,
      businessCategoryId: record.businessCategoryId ?? null,
      workType: record.workType ?? "other",
      sensitiveMemory: { mode: "deny", allowed_principals: [] },
      memoryCaptureV2Mode: null,
      memoryLearningMode: "off",
      autonomy: autonomyPolicyFromWorkspaceConfig(config.workspaces[cwd], config, tenantId),
      workspaceRoot: cwd,
      source: "created"
    };
  };

  if (options.config) return resolveLocked();
  return withWorkspaceConfigLock(workspacesFile, resolveLocked, options.lock);
}

export async function resolveProjectNameForWorkspace(record, options = {}) {
  const resolved = await resolveWorkspaceContext(record, options);
  return resolved.projectId;
}

async function readPayload(argvPayload) {
  if (typeof argvPayload === "string" && argvPayload.length > 0) return argvPayload;
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export function resolveApiBase(env = process.env) {
  const canonical = typeof env.ORGBRAIN_API_URL === "string" ? env.ORGBRAIN_API_URL.trim() : "";
  if (canonical) return canonical;
  const alias = typeof env.ORGBRAIN_API_BASE === "string" ? env.ORGBRAIN_API_BASE.trim() : "";
  if (alias) return alias;
  return ensureRequiredEnv("ORGBRAIN_API_URL") || ensureRequiredEnv("ORGBRAIN_API_BASE");
}

export function resolveMcpConfig(env = process.env) {
  const url = typeof env.ORGBRAIN_MCP_URL === "string" ? env.ORGBRAIN_MCP_URL.trim() : "";
  const clientId = typeof env.ORGBRAIN_MCP_CLIENT_ID === "string"
    ? env.ORGBRAIN_MCP_CLIENT_ID.trim()
    : "";
  const clientSecret = typeof env.ORGBRAIN_MCP_CLIENT_SECRET === "string"
    ? env.ORGBRAIN_MCP_CLIENT_SECRET.trim()
    : "";
  const installationId = typeof env.ORGBRAIN_CLIENT_INSTALLATION_ID === "string"
    ? env.ORGBRAIN_CLIENT_INSTALLATION_ID.trim()
    : "";
  const configured = Boolean(url || clientId || clientSecret || installationId);
  const missing = configured
    ? [
        !url ? "ORGBRAIN_MCP_URL" : "",
        !clientId ? "ORGBRAIN_MCP_CLIENT_ID" : "",
        !clientSecret ? "ORGBRAIN_MCP_CLIENT_SECRET" : "",
        !installationId ? "ORGBRAIN_CLIENT_INSTALLATION_ID" : ""
      ].filter(Boolean)
    : [];
  return {
    configured,
    complete: configured && missing.length === 0,
    url,
    clientId,
    clientSecret,
    missing,
    installationId,
    outboxFile: resolveHome(
      typeof env.ORGBRAIN_HOOK_OUTBOX === "string" && env.ORGBRAIN_HOOK_OUTBOX.trim()
        ? env.ORGBRAIN_HOOK_OUTBOX.trim()
        : "~/.config/org-brain/hook-capture-outbox.jsonl"
    )
  };
}

async function writePrivateOutbox(file, rows) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(staged, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(staged, 0o600);
  await rename(staged, file);
  await chmod(file, 0o600);
}

export async function enqueueHookCapture(config, tenantId, sourceName, record, errorCode = "delivery_failed") {
  const file = config.outboxFile;
  const identityResolved = Boolean(config.installationId) && errorCode !== "identity_unresolved";
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withWorkspaceConfigLock(file, async () => {
    await appendFile(file, `${JSON.stringify({
      schema_version: 1,
      queued_at: Date.now(),
      tenant_id: tenantId,
      source: sourceName,
      installation_id: config.installationId || null,
      identity_state: identityResolved ? "resolved" : "identity_unresolved",
      error_code: errorCode,
      record
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
  });
}

function parseOutboxRows(raw) {
  return raw.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    const parsed = safeJsonParse(line);
    return parsed && typeof parsed === "object" ? [parsed] : [];
  });
}

async function readOutboxRows(file) {
  const raw = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return parseOutboxRows(raw);
}

export async function claimHookCaptureRows(config, limit, options = {}) {
  const file = config.outboxFile;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withWorkspaceConfigLock(file, async () => {
    const now = Date.now();
    const prefix = `${path.basename(file)}.claim-`;
    const entries = await readdir(path.dirname(file), { withFileTypes: true }).catch(() => []);
    const staleClaims = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".jsonl")) continue;
      const claimFile = path.join(path.dirname(file), entry.name);
      const claimStat = await stat(claimFile).catch(() => null);
      if (claimStat && now - claimStat.mtimeMs >= OUTBOX_CLAIM_STALE_MS) staleClaims.push(claimFile);
    }
    const recovered = [];
    for (const claimFile of staleClaims) recovered.push(...await readOutboxRows(claimFile));
    const rows = [...recovered, ...await readOutboxRows(file)];
    if (rows.length === 0) return { rows: [], claimFile: null };
    const count = Math.max(1, Math.min(100, limit));
    const attempted = rows.slice(0, count);
    const claimFile = `${file}.claim-${now}-${process.pid}-${crypto.randomUUID()}.jsonl`;
    // Persist the claim before removing anything from the primary outbox. A crash
    // in the following rewrite can cause an idempotent retry, but cannot lose a row.
    await writePrivateOutbox(claimFile, attempted);
    await options.onClaimPersisted?.({ claimFile, rows: attempted });
    await writePrivateOutbox(file, rows.slice(count));
    await Promise.all(staleClaims.map((stale) => unlink(stale).catch(() => undefined)));
    return { rows: attempted, claimFile };
  });
}

async function releaseHookCaptureClaim(config, claimFile, unsent) {
  if (!claimFile) return;
  await withWorkspaceConfigLock(config.outboxFile, async () => {
    if (unsent.length > 0) {
      const current = await readOutboxRows(config.outboxFile);
      await writePrivateOutbox(config.outboxFile, [...unsent, ...current]);
    }
    await unlink(claimFile).catch(() => undefined);
  });
}

export async function validateMcpInstallation(config) {
  if (!config.installationId) return false;
  const target = new URL(config.url);
  target.pathname = `${target.pathname.replace(/\/+$/u, "")}/client-installations/status`;
  const response = await fetch(target, {
    method: "GET",
    headers: {
      accept: "application/json",
      "CF-Access-Client-Id": config.clientId,
      "CF-Access-Client-Secret": config.clientSecret
    }
  });
  const body = await response.json().catch(() => null);
  const valid = Boolean(response.ok && body?.ok && body.data?.id === config.installationId);
  if (valid) validatedMcpConfigurations.add(config);
  else validatedMcpConfigurations.delete(config);
  return valid;
}

async function ensureMcpInstallationIdentity(config) {
  if (validatedMcpConfigurations.has(config)) return;
  if (!await validateMcpInstallation(config)) {
    throw new Error("org-brain MCP hook identity validation failed (403): installation mismatch or revocation");
  }
}

export async function flushHookCaptureOutbox(config, limit = 100) {
  const claimed = await claimHookCaptureRows(config, limit);
  const attempted = claimed.rows;
  if (attempted.length === 0) return { attempted: 0, sent: 0, pending: 0 };
  const remaining = [];
  let sent = 0;
  let identityValidated;
  for (let index = 0; index < attempted.length; index += 1) {
    let item = attempted[index];
    if (
      item.identity_state === "identity_unresolved" &&
      item.installation_id &&
      config.installationId &&
      item.installation_id === config.installationId
    ) {
      identityValidated ??= await validateMcpInstallation(config).catch(() => false);
      if (identityValidated) {
        item = { ...item, identity_state: "resolved", error_code: "identity_revalidated" };
      }
    }
    if (
      item.identity_state !== "resolved" ||
      !item.installation_id ||
      !config.installationId ||
      item.installation_id !== config.installationId
    ) {
      remaining.push(item);
      continue;
    }
    try {
      await postMemoryViaMcp(config, item.tenant_id, item.source, item.record);
      sent += 1;
    } catch (error) {
      const errorCode = hookDeliveryErrorCode(error);
      if (errorCode === "identity_unresolved") {
        remaining.push({
          ...item,
          identity_state: "identity_unresolved",
          error_code: errorCode
        });
        remaining.push(...attempted.slice(index + 1));
      } else {
        remaining.push(...attempted.slice(index));
      }
      break;
    }
  }
  await releaseHookCaptureClaim(config, claimed.claimFile, remaining);
  return {
    attempted: attempted.length,
    sent,
    pending: (await readOutboxRows(config.outboxFile)).length
  };
}

export function resolveMemoryCaptureV2Mode(env = process.env) {
  const value = firstString(env.ORGBRAIN_MEMORY_CAPTURE_V2_MODE, "off").toLowerCase();
  return value === "on" || value === "shadow" ? value : "off";
}

function canonicalEvidence(record) {
  return (record.evidence ?? []).map((item) => ({
    type: firstString(item.type, item.evidence_type, "external"),
    ref: firstString(item.ref, item.evidence_ref),
    ...(firstString(item.note) ? { note: firstString(item.note) } : {}),
    ...(Number.isFinite(item.weight ?? item.weight_score)
      ? { weight: Number(item.weight ?? item.weight_score) }
      : {})
  })).filter((item) => item.ref);
}

export function captureCandidateJson(record) {
  return buildMemoryCaptureCandidateJson({
    ...record,
    content: redactHookMemoryText(record.content),
    summary: redactHookMemoryText(record.summary),
    rationale: redactHookMemoryText(record.rationale),
    reuseRule: redactHookMemoryText(record.reuseRule),
    evidence: canonicalEvidence(record)
  });
}

export function captureItemPayload(record) {
  const candidate = captureCandidateJson(record);
  const candidateId = firstString(
    record.candidate_id,
    record.candidateId,
    record.learning?.contract_metadata?.candidate_id
  );
  const aiCertification = firstString(
    record.ai_certification,
    record.certification,
    record.learning?.contract_metadata?.ai_certification
  );
  const judgeConsensus = record.judge_consensus ?? record.learning?.contract_metadata?.judge_consensus;
  const learning = record.learning && typeof record.learning === "object"
    ? {
      ...record.learning,
      contract_metadata: {
        ...(record.learning.contract_metadata && typeof record.learning.contract_metadata === "object"
          ? record.learning.contract_metadata
          : {}),
        ...(candidateId ? { candidate_id: candidateId } : {}),
        ...(aiCertification ? { ai_certification: aiCertification } : {}),
        ...(judgeConsensus ? { judge_consensus: judgeConsensus } : {})
      }
    }
    : null;
  return {
    ...candidate,
    evidence: (candidate.evidence ?? []).map((item, index) => ({
      evidence_type: ["file", "command", "doc"].includes(item.type) ? item.type : "external",
      evidence_ref: item.ref,
      relation: "supports",
      note: item.note ?? null,
      weight_score: item.weight ?? null,
      ...(record.evidence?.[index]?.contentHash ? { content_hash: record.evidence[index].contentHash } : {}),
      ...(record.evidence?.[index]?.diffHash ? { diff_hash: record.evidence[index].diffHash } : {}),
      ...(record.evidence?.[index]?.observedAt ? { observed_at: record.evidence[index].observedAt } : {}),
      ...(record.evidence?.[index]?.attestationRef ? { attestation_ref: record.evidence[index].attestationRef } : {})
    })),
    ...(learning ? { learning } : {}),
    ...(candidateId ? { candidate_id: candidateId } : {}),
    ...(aiCertification ? { ai_certification: aiCertification } : {}),
    ...(judgeConsensus ? { judge_consensus: judgeConsensus } : {}),
    ...(record.captureOrigin ? { capture_origin: record.captureOrigin } : {}),
    ...(record.verification ? { verification: record.verification } : {}),
    ...(record.qualityDimensions ? { quality_dimensions: record.qualityDimensions } : {})
  };
}

export async function prepareMemoryRecordsV2(record, workspace, tenantId) {
  const extraction = extractDurableMemoryDrafts({
    event_id: record.externalKey,
    tenant_id: tenantId,
    project_id: workspace.projectId,
    source: record.sourceName,
    occurred_at: record.createdAt,
    text: record.assistantText
  }, {
    workspace_root: workspace.workspaceRoot,
    sensitive_policy: workspace.sensitiveMemory,
    max_candidates: MEMORY_CAPTURE_HOOK_PROFILE.max_candidates,
    capture_profile: MEMORY_CAPTURE_HOOK_PROFILE
  });
  const categoryDigest = sha256(`${tenantId}\0${workspace.projectId || "global"}`);
  const category = buildProjectCategoryIdentity(tenantId, workspace.projectId, categoryDigest);
  const businessCategoryId = record.businessCategoryId ?? workspace.businessCategoryId ?? category.id;
  const workType = record.workType ?? workspace.workType ?? "other";
  const records = extraction.drafts.map((draft) => {
    const canonicalKey = sha256(`${tenantId}\0${workspace.projectId || "global"}\0${draft.kind}\0${draft.canonical_text}`);
    return {
      externalKey: `v2:${sha256(`${record.externalKey}\0${canonicalKey}`)}`,
      canonicalKey,
      createdAt: record.createdAt,
      cwd: record.cwd,
      projectId: workspace.projectId,
      projectIdExplicit: record.projectIdExplicit,
      businessCategoryId,
      businessCategory: category,
      workType,
      summary: draft.summary,
      tags: dedupeTags([...draft.tags, record.eventType]),
      content: draft.content,
      kind: draft.kind,
      rationale: draft.rationale,
      reuseRule: draft.reuse_rule,
      evidence: draft.evidence.map((item) => ({
        type: ["file", "command", "doc"].includes(item.type) ? item.type : "external",
        ref: item.ref,
        ...(item.note ? { note: item.note } : {}),
        weight: item.type === "file" || item.type === "doc" ? 0.9 : 0.8
      })),
      sourceReferences: draft.source_references,
      validUntil: draft.valid_until,
      confidenceScore: draft.confidence_score,
      utilityScore: draft.utility_score,
      visibility: draft.visibility,
      allowedPrincipals: draft.allowed_principals,
      qualityScore: draft.quality_score,
      captureProfileId: draft.capture_profile_id,
      actorType: "system",
      actorId: buildActorId(record)
    };
  });
  return {
    records,
    category,
    report: {
      candidate_count: records.length,
      candidate_hashes: records.map((candidate) => sha256(JSON.stringify(captureCandidateJson(candidate)))),
      capture_profile_id: MEMORY_CAPTURE_HOOK_PROFILE.profile_id,
      capture_profile_source_hash: MEMORY_CAPTURE_HOOK_PROFILE.source_dataset_sha256,
      quality_scores: records.map((candidate) => candidate.qualityScore ?? null),
      excluded_reasons: [...new Set(extraction.excluded.map((item) => item.reason))],
      sensitivity_reason: extraction.sensitivity.reason,
      sensitive_counts: extraction.sensitivity.counts
    }
  };
}

export async function prepareObservedLearningRecords(record, workspace, tenantId, options = {}) {
  const transcriptOptions = {
    transcriptPath: record.metadata?.transcriptPath,
    turnId: record.metadata?.turnId,
    workspaceRoot: workspace.workspaceRoot,
    sensitivePolicy: workspace.sensitiveMemory
  };
  const transcript = await (Array.isArray(options.rows)
    ? collectVerifiedLearningEventsFromRows(options.rows, transcriptOptions)
    : collectVerifiedLearningEvents(transcriptOptions)).catch((error) => ({
    events: [],
    reviews: [{ reason_codes: ["transcript_read_failed"], detail_hash: sha256(String(error)) }],
    raw_transcript_persisted: false
  }));
  const categoryDigest = sha256(`${tenantId}\0${workspace.projectId || "global"}`);
  const category = buildProjectCategoryIdentity(tenantId, workspace.projectId, categoryDigest);
  const businessCategoryId = record.businessCategoryId ?? workspace.businessCategoryId ?? category.id;
  const workType = record.workType ?? workspace.workType ?? "other";
  const ttl = { fact: 90, decision: 180, constraint: 180, pitfall: 180, preference: 180 };
  const commitmentOnlyCount = transcript.events.filter(({ learning }) =>
    learning.schema_version === 2 && learning.lesson_type === "decision" &&
    ["user_choice", "preference"].includes(learning.decision_type)
  ).length;
  const formalEvents = transcript.events.filter(({ learning }) => !(
    learning.schema_version === 2 && learning.lesson_type === "decision" &&
    ["user_choice", "preference"].includes(learning.decision_type)
  ));
  const records = formalEvents.map(({ event_hash: eventHash, learning: observedLearning, verification }) => {
    const learning = {
      ...observedLearning,
      contract_metadata: {
        session_id_hash: record.metadata?.sessionId ? `sha256:${sha256(record.metadata.sessionId)}` : null,
        turn_id_hash: record.metadata?.turnId ? `sha256:${sha256(record.metadata.turnId)}` : null,
        contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH
      }
    };
    const canonicalText = normalizeWhitespace(learning.conclusion || learning.selected_value || learning.decision || learning.correction || "learning").toLocaleLowerCase();
    const canonicalKey = sha256(`${tenantId}\0${workspace.projectId || "global"}\0${learning.kind}\0${canonicalText}`);
    const validUntil = record.createdAt + (ttl[learning.kind] ?? 180) * 24 * 60 * 60 * 1000;
    return {
      externalKey: `learning:${sha256(`${record.externalKey}\0${eventHash}\0${canonicalKey}`)}`,
      canonicalKey,
      createdAt: record.createdAt,
      cwd: record.cwd,
      projectId: workspace.projectId,
      projectIdExplicit: record.projectIdExplicit,
      businessCategoryId,
      businessCategory: category,
      workType,
      summary: learning.conclusion || learning.selected_value || learning.decision || learning.correction || "Verified learning",
      tags: dedupeTags(["verified-learning", learning.lesson_type, learning.kind, record.eventType]),
      content: learning.conclusion || learning.selected_value || learning.decision || learning.correction || "Verified learning",
      kind: learning.kind,
      rationale: learning.rationale,
      reuseRule: learning.reuse_rule,
      evidence: verification.evidence.map((item) => ({
        type: item.type,
        ref: item.ref,
        note: [
          `content_hash=${item.content_hash}`,
          item.diff_hash ? `diff_hash=${item.diff_hash}` : null,
          `observed_at=${item.observed_at}`,
          `attestation_ref=${item.attestation_ref}`,
          Number.isInteger(item.exit_code) ? `exit_code=${item.exit_code}` : null
        ].filter(Boolean).join("; "),
        weight: 1,
        contentHash: item.content_hash,
        diffHash: item.diff_hash,
        observedAt: item.observed_at,
        attestationRef: item.attestation_ref
      })),
      sourceReferences: [{ type: "codex-turn", ref: `sha256:${eventHash}`, captured_at: record.createdAt }],
      validUntil,
      confidenceScore: verification.evidence.length >= 2 ? 0.95 : 0.9,
      utilityScore: 0.95,
      visibility: workspace.projectId ? "project" : "tenant",
      allowedPrincipals: [],
      qualityScore: verification.quality_score,
      captureOrigin: "observed",
      learning,
      verification: {
        state: verification.verification_state,
        verified_at: verification.verified_at,
        attestation_ref: `sha256:${eventHash}`
      },
      qualityDimensions: verification.quality_dimensions,
      actorType: "system",
      actorId: "hook:codex-stop"
    };
  });
  const reviewCandidates = transcript.reviews
    .filter((item) => item?.learning)
    .slice(0, 3)
    .map((item) => ({
      external_key: `learning-review:${sha256(`${record.externalKey}\0${item.event_hash ?? sha256(JSON.stringify(item.learning))}`)}`,
      prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
      prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
      contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
      verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
      capture_intent: "review",
      project_id: workspace.projectId,
      task_key: firstString(record.metadata?.sessionId, record.metadata?.turnId) ? `codex:${firstString(record.metadata?.sessionId, record.metadata?.turnId)}` : null,
      observation: item.learning,
      reason_codes: item.reason_codes ?? item.verification?.reason_codes ?? [],
      verification: item.verification ?? null,
      created_at: record.createdAt,
      expires_at: record.createdAt + 180 * 24 * 60 * 60 * 1000
    }));
  const deterministicReviewCandidates = records.map((item) => ({
    external_key: `learning-review:${sha256(`${record.externalKey}\0${item.externalKey}`)}`,
    prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
    prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
    contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
    verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
    capture_intent: "verify",
    project_id: workspace.projectId,
    task_key: firstString(record.metadata?.sessionId, record.metadata?.turnId) ? `codex:${firstString(record.metadata?.sessionId, record.metadata?.turnId)}` : null,
    item: captureItemPayload(item),
    observation: item.learning,
    verification: item.verification,
    evidence: item.evidence,
    reason_codes: ["ai_consensus_pending"],
    created_at: record.createdAt,
    expires_at: record.createdAt + 180 * 24 * 60 * 60 * 1000
  }));
  const allReviewCandidates = [...deterministicReviewCandidates, ...reviewCandidates].slice(0, 3);
  return {
    records,
    reviewCandidates: allReviewCandidates,
    category,
    report: {
      mode: workspace.memoryLearningMode,
      observed_count: transcript.events.length,
      commitment_only_count: commitmentOnlyCount,
      review_count: allReviewCandidates.length,
      candidate_hashes: records.map((candidate) => sha256(JSON.stringify(captureItemPayload(candidate)))),
      review_reason_codes: [...new Set(transcript.reviews.flatMap((item) => item.reason_codes ?? []))],
      scanned_bytes: transcript.scanned_bytes ?? 0,
      raw_transcript_persisted: false
    }
  };
}

export function buildMcpCaptureRequest(tenantId, sourceName, recordOrRecords) {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
  const argumentsPayload = Array.isArray(recordOrRecords)
    ? { items: records.map(captureItemPayload) }
    : { item: captureItemPayload(records[0]) };
  return {
    jsonrpc: "2.0",
    id: `hook:${records[0]?.externalKey ?? sha256(JSON.stringify(argumentsPayload)).slice(0, 24)}`,
    method: "tools/call",
    params: {
      name: MCP_CAPTURE_TOOL,
      arguments: {
        tenant_id: tenantId,
        source: sourceName,
        ...argumentsPayload
      },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "orgbrain-hook-memory-bridge",
          version: "0.1.0"
        }
      }
    }
  };
}

export function buildMcpLearningBatchRequest(tenantId, sourceName, input = {}) {
  const verifiedItems = Array.isArray(input.aiCertifiedRecords)
    ? input.aiCertifiedRecords.map(captureItemPayload)
    : [];
  const deterministicItems = Array.isArray(input.deterministicallyVerifiedItems)
    ? input.deterministicallyVerifiedItems.map(captureItemPayload)
    : Array.isArray(input.records)
      ? input.records.map(captureItemPayload)
      : [];
  const reviewCandidates = Array.isArray(input.reviewCandidates)
    ? input.reviewCandidates.slice(0, 3).map((candidate) => ({
      ...candidate,
      prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
      prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
      contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
      verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION
      }))
    : [];
  const quarantineCandidates = Array.isArray(input.quarantineCandidates)
    ? input.quarantineCandidates.slice(0, 3).map((candidate) => ({
      ...candidate,
      prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
      prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
      contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
      verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION
    }))
    : [];
  const semanticAliases = Array.isArray(input.semanticAliases) ? input.semanticAliases.slice(0, 16) : [];
  return {
    jsonrpc: "2.0",
    id: `learning:${sha256(JSON.stringify({ tenantId, sourceName, verifiedItems, reviewCandidates, semanticAliases })).slice(0, 40)}`,
    method: "tools/call",
    params: {
      name: MCP_LEARNING_BATCH_TOOL,
      arguments: {
        tenant_id: tenantId,
        source: sourceName,
        project_id: input.projectId ?? null,
        task_key: input.taskKey ?? null,
        commitments: Array.isArray(input.commitments) ? input.commitments.slice(0, 16) : [],
        prompt_contract_id: MEMORY_CONTRACT_V2_PROMPT_ID,
        prompt_hash: MEMORY_CONTRACT_V2_PROMPT_HASH,
        contract_hash: MEMORY_CONTRACT_V2_CONTRACT_HASH,
        verifier_version: MEMORY_CONTRACT_V2_VERIFIER_VERSION,
        verified_items: verifiedItems,
        deterministically_verified_items: deterministicItems,
        review_candidates: reviewCandidates,
        quarantine_candidates: quarantineCandidates,
        semantic_aliases: semanticAliases
      },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "orgbrain-hook-memory-bridge",
          version: "0.1.0"
        }
      }
    }
  };
}

export function hookCaptureLogFields(captureV2Mode, records, report, memoryIds = []) {
  if (captureV2Mode !== "off") {
    return {
      candidate_count: records.length,
      candidate_hashes: report?.candidate_hashes ?? []
    };
  }
  return {
    external_keys: records.map((record) => record.externalKey),
    ...(memoryIds.length ? { memory_ids: memoryIds } : {})
  };
}

export async function postMemoryViaMcp(config, tenantId, sourceName, recordOrRecords) {
  await ensureMcpInstallationIdentity(config);
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "CF-Access-Client-Id": config.clientId,
      "CF-Access-Client-Secret": config.clientSecret,
      "x-orgbrain-tenant": tenantId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": MCP_CAPTURE_TOOL
    },
    body: JSON.stringify(buildMcpCaptureRequest(tenantId, sourceName, recordOrRecords)),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error || body.result?.isError) {
    if (response.status === 401 || response.status === 403) validatedMcpConfigurations.delete(config);
    const detail = body?.error?.message || body?.result?.content?.[0]?.text || "unexpected MCP response";
    throw new Error(`org-brain MCP hook capture failed (${response.status}): ${detail}`);
  }
  const text = body.result?.content?.find?.((entry) => entry?.type === "text")?.text;
  if (typeof text !== "string") {
    throw new Error("org-brain MCP hook capture returned no text result");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("org-brain MCP hook capture returned invalid JSON");
  }
}

export async function postLearningBatchViaMcp(config, tenantId, sourceName, input) {
  await ensureMcpInstallationIdentity(config);
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "CF-Access-Client-Id": config.clientId,
      "CF-Access-Client-Secret": config.clientSecret,
      "x-orgbrain-tenant": tenantId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": MCP_LEARNING_BATCH_TOOL
    },
    body: JSON.stringify(buildMcpLearningBatchRequest(tenantId, sourceName, input)),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error || body.result?.isError) {
    if (response.status === 401 || response.status === 403) validatedMcpConfigurations.delete(config);
    const detail = body?.error?.message || body?.result?.content?.[0]?.text || "unexpected MCP response";
    throw new Error(`org-brain MCP learning batch failed (${response.status}): ${detail}`);
  }
  const resultText = body.result?.content?.find?.((entry) => entry?.type === "text")?.text;
  if (typeof resultText !== "string") throw new Error("org-brain MCP learning batch returned no text result");
  return JSON.parse(resultText);
}

function hookDeliveryErrorCode(error) {
  return error instanceof Error && /\(40[13]\)/u.test(error.message)
    ? "identity_unresolved"
    : "delivery_failed";
}

export async function postMemoryViaRest(apiBase, apiKey, tenantId, sourceName, recordOrRecords) {
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
  const itemPayload = Array.isArray(recordOrRecords)
    ? { items: records.map(captureItemPayload) }
    : { item: captureItemPayload(records[0]) };
  const res = await fetch(buildApiUrl(apiBase, "/v1/memories/capture-rationale"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      source: sourceName,
      actor_type: records[0]?.actorType ?? "system",
      actor_id: records[0]?.actorId ?? sourceName,
      ...itemPayload
    }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS)
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`org-brain hook capture-rationale failed (${res.status})`);
  }
  return body.data;
}

async function postMemory(apiBase, apiKey, tenantId, sourceName, recordOrRecords) {
  return postMemoryViaRest(apiBase, apiKey, tenantId, sourceName, recordOrRecords);
}

export async function captureLocalMemories(sourceName, tenantId, recordOrRecords, options = {}) {
  const { DEFAULT_LOCAL_DB, LocalMemoryStore } = await import("./lib/local-memory-store.mjs");
  const store = options.store ?? new LocalMemoryStore(process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB);
  const records = Array.isArray(recordOrRecords) ? recordOrRecords : [recordOrRecords];
  const categories = await store.listBusinessCategories(tenantId, { includeInactive: true });
  const categoryIds = new Set(categories.map((item) => item.id));
  const inputs = [];
  for (const record of records) {
    const candidate = captureCandidateJson(record);
    if (record.businessCategory && !categoryIds.has(record.businessCategory.id)) {
      await store.createBusinessCategory(tenantId, record.businessCategory);
      categoryIds.add(record.businessCategory.id);
    }
    const legacyCategory = record.tags.find((tag) =>
      ["policy", "diagnosis", "command-result", "workaround"].includes(tag)
    );
    const kind = record.kind ?? (
      legacyCategory === "policy"
        ? "constraint"
        : legacyCategory === "diagnosis" || legacyCategory === "workaround"
          ? "pitfall"
          : "fact"
    );
    inputs.push({
      tenant_id: tenantId,
      project_id: candidate.project_id,
      business_category_id: candidate.business_category_id ?? null,
      work_type: candidate.work_type ?? "other",
      kind: candidate.kind ?? kind,
      lifecycle_state: "active",
      scope_type: candidate.project_id ? "project" : "tenant",
      scope_key: candidate.project_id || tenantId,
      content: candidate.content,
      summary: candidate.summary,
      tags: candidate.tags,
      entities: [],
      source: sourceName,
      source_references: candidate.source_references ?? [{
        type: "agent-event",
        ref: candidate.external_key,
        captured_at: candidate.created_at
      }],
      external_key: candidate.external_key,
      actor_type: record.actorType ?? "system",
      actor_id: record.actorId ?? sourceName,
      created_at: candidate.created_at,
      valid_from: candidate.valid_from,
      valid_until: candidate.valid_until ?? null,
      expires_at: candidate.valid_until ?? null,
      confidence_score: candidate.confidence_score ?? (legacyCategory === "policy" ? 0.88 : 0.78),
      utility_score: candidate.utility_score ?? 0.75,
      canonical_key: candidate.canonical_key ?? null,
      rationale: candidate.rationale || "Automatically distilled from a durable agent hook event.",
      reuse_rule: candidate.reuse_rule ?? null,
      evidence: record.evidence?.map((item) => ({
        type: item.type,
        ref: item.ref,
        note: item.note ?? null,
        content_hash: item.contentHash ?? null,
        observed_at: item.observedAt ?? null,
        attestation_ref: item.attestationRef ?? null
      })) ?? candidate.evidence ?? [{ type: "agent-event", ref: candidate.external_key }],
      conflicts: [],
      permissions: (candidate.allowed_principals ?? []).map((principalId) => ({
        principal_type: "principal",
        principal_id: principalId,
        permissions: ["read"]
      })),
      capture_origin: record.captureOrigin ?? "legacy",
      verification_state: record.verification?.state ?? "unverified",
      verified_at: record.verification?.verified_at ?? null,
      learning: record.learning ?? null,
      quality_dimensions: record.qualityDimensions ?? null
    });
  }
  return store.captureBatch(inputs);
}

export async function ingestHookEvent(sourceInput, payloadInput, options = {}) {
  const inputSourceName = firstString(sourceInput, "unknown");
  const sourceName = inputSourceName === "codex-stop" ? "codex" : inputSourceName;
  const finish = (result) => {
    if (options.emit !== false) console.log(JSON.stringify(result));
    return result;
  };
  const payloadText = await readPayload(payloadInput);
  if (!payloadText.trim()) {
    return finish({ ok: true, skipped: "empty-payload", source: sourceName });
  }

  await loadEnvFallbacks();

  const memoryMode = resolveMemoryMode();
  let captureV2Mode = resolveMemoryCaptureV2Mode();
  let tenantId = ensureRequiredEnv("ORGBRAIN_TENANT_ID") || "default";
  const normalizedRecord = normalizeRecord(inputSourceName, payloadText);
  const prepared = prepareMemoryRecordForUpsert(inputSourceName, payloadText);
  const workspaceRecord = prepared.action === "promote" ? prepared.record : normalizedRecord;
  const workspace = await resolveWorkspaceContext(workspaceRecord, { memoryMode });
  tenantId = workspace.tenantId;
  captureV2Mode = workspace.memoryCaptureV2Mode ?? captureV2Mode;
  let records;
  let shadowReport = null;
  let learningReport = null;
  let learningReviewCandidates = [];
  if (inputSourceName === "codex-stop" && ["shadow", "on"].includes(workspace.memoryLearningMode)) {
    const observed = await prepareObservedLearningRecords(normalizedRecord, workspace, tenantId);
    learningReport = observed.report;
    learningReviewCandidates = observed.reviewCandidates ?? [];
    if (workspace.memoryLearningMode === "on") records = observed.records;
  }
  if (inputSourceName === "codex-stop" && workspace.memoryLearningMode === "on") {
    const { DEFAULT_LOCAL_DB } = await import("./lib/local-memory-store.mjs");
    const { TaskCommitmentStore, taskKeyFromHookPayload } = await import("./lib/task-commitment-store.mjs");
    const commitmentStore = new TaskCommitmentStore(process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB);
    const taskKey = taskKeyFromHookPayload(normalizedRecord.metadata ?? normalizedRecord);
    const taskCommitments = await commitmentStore.list({
      tenantId,
      projectId: workspace.projectId,
      taskKey
    }).catch(() => []);
    if (!memoryMode.cloudWritesAllowed) {
      const savedReviews = await commitmentStore.saveLearningCandidates({
        tenantId,
        projectId: workspace.projectId,
        taskKey,
        candidates: learningReviewCandidates
      });
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        mode: "local",
        inserted: 0,
        review_count: savedReviews.length,
        ...(learningReport ? { verified_learning_shadow: learningReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    }
    const mcp = resolveMcpConfig();
    if (!mcp.complete) {
      const outbox = await commitmentStore.saveLearningOutbox({
        tenantId,
        payload: buildMcpLearningBatchRequest(tenantId, sourceName, {
          projectId: workspace.projectId,
          taskKey,
          commitments: taskCommitments,
          records: [],
          reviewCandidates: learningReviewCandidates
        })
      });
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        queued: "learning-outbox",
        outbox,
        skipped: "missing-orgbrain-mcp-env-for-learning-contract",
        review_count: learningReviewCandidates.length,
        quarantine_count: learningReviewCandidates.length,
        ...(learningReport ? { verified_learning_shadow: learningReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    }
    const batchInput = {
      projectId: workspace.projectId,
      taskKey,
      commitments: taskCommitments,
      records: [],
      reviewCandidates: learningReviewCandidates
    };
    let result;
    try {
      result = await postLearningBatchViaMcp(mcp, tenantId, sourceName, batchInput);
    } catch (error) {
      const outbox = await commitmentStore.saveLearningOutbox({
        tenantId,
        payload: buildMcpLearningBatchRequest(tenantId, sourceName, batchInput)
      });
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        queued: "learning-outbox",
        outbox,
        error_code: error?.name === "TimeoutError" ? "mcp_timeout" : "mcp_learning_batch_failed",
        review_count: learningReviewCandidates.length,
        ...(learningReport ? { verified_learning_shadow: learningReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    }
    return finish({
      ok: true,
      source: sourceName,
      tenant_id: tenantId,
      inserted: Number(result?.verified_inserted ?? 0),
      review_count: Number(result?.review_inserted ?? learningReviewCandidates.length),
      quarantine_count: Number(result?.quarantine_inserted ?? result?.review_inserted ?? learningReviewCandidates.length),
      transport: "mcp-2026-07-28",
      ...(learningReport ? { verified_learning_shadow: learningReport } : {}),
      ...memoryModeFields(memoryMode)
    });
  }
  if (!records && workspace.memoryLearningMode !== "on" && (captureV2Mode === "on" || captureV2Mode === "shadow")) {
    const v2 = await prepareMemoryRecordsV2(normalizedRecord, workspace, tenantId);
    shadowReport = v2.report;
    if (captureV2Mode === "on") records = v2.records;
  }
  if (!records && workspace.memoryLearningMode !== "on" && captureV2Mode !== "on") {
    if (prepared.action === "skip") {
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        skipped: "low-signal-memory",
        reason_code: prepared.reason,
        ...(shadowReport ? { capture_v2_shadow: shadowReport } : {}),
        ...(learningReport ? { verified_learning_shadow: learningReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    }
    prepared.record.projectId = workspace.projectId;
    prepared.record.businessCategoryId ??= workspace.businessCategoryId;
    prepared.record.workType ??= workspace.workType ?? "other";
    records = [prepared.record];
  }
  if (!records?.length) {
    return finish({
      ok: true,
      source: sourceName,
      tenant_id: tenantId,
      skipped: "no-durable-candidates",
      reason_codes: shadowReport?.excluded_reasons ?? [],
      sensitivity_reason: shadowReport?.sensitivity_reason ?? null,
      ...memoryModeFields(memoryMode)
    });
  }

  if (!memoryMode.cloudWritesAllowed) {
    if (process.env.ORGBRAIN_LOCAL_HOOK_CAPTURE === "false") {
      return finish({
        ok: true,
        skipped: "local-hook-capture-disabled",
        source: sourceName,
        ...memoryModeFields(memoryMode)
      });
    }
    const results = await captureLocalMemories(sourceName, tenantId, records);
    return finish({
      ok: true,
      source: sourceName,
      tenant_id: tenantId,
      mode: "local",
      ...hookCaptureLogFields(
        captureV2Mode,
        records,
        shadowReport,
        results.map((result) => result.memory_id)
      ),
      created: results.filter((result) => result.created).length,
      ...(shadowReport ? { capture_v2_shadow: shadowReport } : {})
      , ...(learningReport ? { verified_learning_shadow: learningReport } : {})
    });
  }

  const mcp = resolveMcpConfig();
  if (mcp.configured && !mcp.complete) {
    return finish({
      ok: true,
      skipped: "missing-orgbrain-mcp-env",
      missing: mcp.missing,
      source: sourceName,
      ...memoryModeFields(memoryMode)
    });
  }

  const apiBase = resolveApiBase();
  const apiKey = ensureRequiredEnv("ORGBRAIN_API_KEY");

  if (!mcp.complete && (!apiBase || !apiKey)) {
    return finish({
      ok: true,
      skipped: "missing-orgbrain-env",
      source: sourceName,
      ...memoryModeFields(memoryMode)
    });
  }

  const batchRequired = captureV2Mode === "on" || workspace.memoryLearningMode === "on";
  const captureInput = records.length === 1 && !batchRequired ? records[0] : records;
  let result;
  if (mcp.complete) {
    await flushHookCaptureOutbox(mcp, 100).catch(() => undefined);
    try {
      result = await postMemoryViaMcp(mcp, tenantId, sourceName, captureInput);
    } catch (error) {
      const errorCode = hookDeliveryErrorCode(error);
      await enqueueHookCapture(
        mcp,
        tenantId,
        sourceName,
        captureInput,
        errorCode
      ).catch(() => undefined);
      return finish({
        ok: true,
        queued: true,
        source: sourceName,
        tenant_id: tenantId,
        external_keys: records.map((record) => record.externalKey),
        identity_state: errorCode === "identity_unresolved" || !mcp.installationId
          ? "identity_unresolved"
          : "resolved",
        ...memoryModeFields(memoryMode)
      });
    }
  } else {
    result = await postMemory(apiBase, apiKey, tenantId, sourceName, captureInput);
  }
  return finish({
    ok: true,
    source: sourceName,
    tenant_id: tenantId,
    ...hookCaptureLogFields(captureV2Mode, records, shadowReport),
    inserted: Number(result?.inserted ?? 0),
    updated: Number(result?.updated ?? 0),
    skipped_count: Number(result?.summary?.skipped ?? 0),
    transport: mcp.complete ? "mcp-2026-07-28" : "legacy-rest",
    ...(shadowReport ? { capture_v2_shadow: shadowReport } : {}),
    ...(learningReport ? { verified_learning_shadow: learningReport } : {}),
    ...memoryModeFields(memoryMode)
  });
}

export async function main() {
  return ingestHookEvent(process.argv[2], process.argv[3]);
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]) === "hook-memory-bridge.mjs" &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
