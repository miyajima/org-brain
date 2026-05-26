#!/usr/bin/env node

import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { assessMemoryUsefulness, classifyMemoryQuality } from "./lib/memory-quality.mjs";

const ROOT = "/Users/miya/projects/org-brain";
const DEFAULT_ENV_FILES = [
  "~/.config/org-brain/hooks.env",
  "~/.openclaw/.env",
  "~/.agents/.env",
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env")
];
const DEFAULT_PROJECT_NAMES_FILE = "~/.config/org-brain/project-names.json";

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
    sourceName,
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
      summary: buildPromotedSummary(record, classification.normalizedText),
      tags,
      content: buildPromotedContent(record, classification.category, classification.normalizedText),
      actorType: "system",
      actorId: buildActorId(record)
    }
  };
}

function projectNamesFileFromEnv() {
  return resolveHome(firstString(process.env.ORGBRAIN_PROJECT_NAMES_FILE, DEFAULT_PROJECT_NAMES_FILE));
}

async function loadProjectNames(file = projectNamesFileFromEnv()) {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = safeJsonParse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [firstString(key), normalizeProjectName(value)])
        .filter(([key, value]) => key && value)
    );
  } catch {
    return {};
  }
}

async function saveProjectNames(file, names) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(names, null, 2)}\n`, "utf8");
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

export async function resolveProjectNameForWorkspace(record, options = {}) {
  const cwd = firstString(record?.cwd);
  if (record?.projectIdExplicit) return record.projectId ?? null;
  const fallbackProjectId = normalizeProjectName(record?.projectId, basenameOrEmpty(cwd));
  if (!cwd || !fallbackProjectId) return fallbackProjectId;

  const file = options.file ?? projectNamesFileFromEnv();
  const names = options.names ?? await loadProjectNames(file);
  const existing = normalizeProjectName(names[cwd]);
  if (existing) return existing;

  let selected = fallbackProjectId;
  if (options.prompt !== false) {
    if (typeof options.prompt === "function") {
      selected = normalizeProjectName(await options.prompt(cwd, fallbackProjectId), fallbackProjectId);
    } else {
      const tty = await openTtyStreams();
      if (tty) {
        try {
          selected = await promptForProjectName(cwd, fallbackProjectId, tty.input, tty.output);
        } finally {
          tty.close();
        }
      }
    }
  }

  names[cwd] = selected;
  await saveProjectNames(file, names);
  return selected;
}

async function readPayload(argvPayload) {
  if (typeof argvPayload === "string" && argvPayload.length > 0) return argvPayload;
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function resolveApiBase() {
  return ensureRequiredEnv("ORGBRAIN_API_URL") || ensureRequiredEnv("ORGBRAIN_API_BASE");
}

async function postMemory(apiBase, apiKey, tenantId, sourceName, record) {
  const res = await fetch(buildApiUrl(apiBase, "/v1/memories/capture-rationale"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      tenant_id: tenantId,
      source: sourceName,
      actor_type: record.actorType ?? "system",
      actor_id: record.actorId ?? sourceName,
      item: {
        external_key: record.externalKey,
        content: clip(record.content, 20_000),
        summary: clip(record.summary, 1_000),
        tags: record.tags,
        created_at: record.createdAt,
        project_id: record.projectId
      }
    })
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`org-brain hook capture-rationale failed (${res.status})`);
  }
  return body.data;
}

export async function main() {
  const sourceName = firstString(process.argv[2], "unknown");
  const payloadText = await readPayload(process.argv[3]);
  if (!payloadText.trim()) {
    console.log(JSON.stringify({ ok: true, skipped: "empty-payload", source: sourceName }));
    return;
  }

  await loadEnvFallbacks();

  const apiBase = resolveApiBase();
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

  const prepared = prepareMemoryRecordForUpsert(sourceName, payloadText);
  if (prepared.action === "skip") {
    console.log(
      JSON.stringify({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        skipped: "low-signal-memory"
      })
    );
    return;
  }

  prepared.record.projectId = await resolveProjectNameForWorkspace(prepared.record);

  const result = await postMemory(apiBase, apiKey, tenantId, sourceName, prepared.record);
  console.log(
    JSON.stringify({
      ok: true,
      source: sourceName,
      tenant_id: tenantId,
      external_key: prepared.record.externalKey,
      inserted: Number(result?.inserted ?? 0),
      updated: Number(result?.updated ?? 0)
    })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
