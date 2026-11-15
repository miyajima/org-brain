#!/usr/bin/env node
import { sha256, firstString, dedupeTags, normalizeWhitespace, redactHookMemoryText, buildActorId, resolveMemoryCaptureV2Mode, captureCandidateJson, captureItemPayload, deterministicRecordConfirmationCandidate, isMemoryConfirmationFlowArtifact, prepareMemoryRecordsV2, prepareObservedLearningRecords } from "./lib/hook-candidates.mjs";
import { resolveMcpConfig, enqueueHookCapture, claimHookCaptureRows, validateMcpInstallation, flushHookCaptureOutbox, buildMcpCaptureRequest, buildMcpLearningBatchRequest, buildMcpMemoryExtractionRequest, hookCaptureLogFields, postMemoryViaMcp, postLearningBatchViaMcp, postMemoryExtractionViaMcp, hookDeliveryErrorCode, postMemoryViaRest, postMemory } from "./lib/hook-delivery.mjs";
export { redactHookMemoryText, resolveMemoryCaptureV2Mode, captureCandidateJson, captureItemPayload, prepareMemoryRecordsV2, prepareObservedLearningRecords };
export { resolveMcpConfig, enqueueHookCapture, claimHookCaptureRows, validateMcpInstallation, flushHookCaptureOutbox, buildMcpCaptureRequest, buildMcpLearningBatchRequest, buildMcpMemoryExtractionRequest, hookCaptureLogFields, postMemoryViaMcp, postLearningBatchViaMcp, postMemoryExtractionViaMcp, postMemoryViaRest };
import { collectMemoryUse } from "./lib/memory-use-collector.mjs";
import { taskKeyFromHookPayload } from "./lib/task-commitment-store.mjs";

import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { memoryModeFields, resolveMemoryMode } from "./lib/memory-mode.mjs";
import { assessMemoryUsefulness, classifyMemoryQuality } from "./lib/memory-quality.mjs";
import { classifiedAutoSaveEnabled } from "./lib/memory-classified-autosave.mjs";
import { MEMORY_CAPTURE_HOOK_PROFILE } from "@org-brain/shared/runtime/memory-capture-profile.generated";
import { readMemoryUseTurnEvidence } from "./lib/memory-learning-transcript.mjs";
import { memoryConfirmationQuestion, prepareMemoryConfirmationCandidates } from "./lib/memory-confirmation-hints.mjs";
import {
  loadTurnEvidenceRows
} from "./lib/turn-evidence-v1.mjs";
import {
  configuredTenantFromEnv,
  legacyProjectNamesFileFromEnv,
  loadLegacyProjectNames,
  loadWorkspaceConfig,
  resolveWorkspaceMapping,
  migrateLegacyProjectNames,
  normalizeWorkspaceRoot,
  autonomyPolicyFromWorkspaceConfig,
  saveWorkspaceConfig,
  tenantFallbackFromEnv,
  withWorkspaceConfigLock,
  projectIdFromDirectoryName,
  resolveHomePath,
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
// A hook command supplies ORGBRAIN_HOOK_ENV_FILES explicitly.  Treat the
// selected file as the complete runtime-config boundary for backend and
// capture mode as well as for credentials.  Otherwise a parent process (for
// example Codex itself) can leak cloud flags into a local-only hook and make
// the hook contact Remote OrgBrain despite the file saying "false".
const EXPLICIT_HOOK_MODE_KEYS = new Set([
  "ORGBRAIN_ENABLE_CLOUD_MEMORY",
  "ORGBRAIN_ENABLE_ORG_SHARING",
  "ORGBRAIN_LOCAL_CONTEXT_ENABLED",
  "ORGBRAIN_LOCAL_HOOK_CAPTURE",
  "ORGBRAIN_MEMORY_CAPTURE_V2_MODE",
  "ORGBRAIN_MEMORY_COMMITMENTS_MODE",
  "ORGBRAIN_SESSION_EXTRACTION_MODE",
  "ORGBRAIN_SESSION_EXTRACTION_AUTORUN",
  "ORGBRAIN_SESSION_EXTRACTION_PROJECTS",
  "ORGBRAIN_SESSION_EXTRACTION_EXCLUDE_SESSIONS"
]);
const EXPLICIT_HOOK_SAFE_DEFAULTS = {
  ORGBRAIN_ENABLE_CLOUD_MEMORY: "false",
  ORGBRAIN_ENABLE_ORG_SHARING: "false",
  ORGBRAIN_LOCAL_CONTEXT_ENABLED: "false",
  ORGBRAIN_LOCAL_HOOK_CAPTURE: "false",
  ORGBRAIN_MEMORY_CAPTURE_V2_MODE: "off",
  ORGBRAIN_MEMORY_COMMITMENTS_MODE: "off",
  ORGBRAIN_SESSION_EXTRACTION_MODE: "off",
  ORGBRAIN_SESSION_EXTRACTION_AUTORUN: "false",
  ORGBRAIN_SESSION_EXTRACTION_PROJECTS: "",
  ORGBRAIN_SESSION_EXTRACTION_EXCLUDE_SESSIONS: ""
};

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

export async function queueMemoryConfirmationCandidates({
  dbPath,
  tenantId = "default",
  projectId = null,
  taskPayload,
  candidates = []
} = {}) {
  const prepared = prepareMemoryConfirmationCandidates(candidates);
  if (prepared.length === 0) return [];
  const { DEFAULT_LOCAL_DB } = await import("./lib/local-memory-store.mjs");
  const { TaskCommitmentStore, taskKeyFromHookPayload } = await import("./lib/task-commitment-store.mjs");
  const taskKey = taskKeyFromHookPayload(taskPayload);
  return new TaskCommitmentStore(dbPath || process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB)
    .queueMemoryConfirmations({ tenantId, projectId, taskKey, candidates: prepared });
}

function clip(value, limit) {
  if (typeof value !== "string") return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
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
  return projectIdFromDirectoryName(path.basename(trimmed)) ?? "";
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
    .map((entry) => resolveHomePath(entry.trim()))
    .filter(Boolean);

  if (configured) {
    // An explicitly selected installation file is an identity boundary. Never
    // inherit these values when that file is missing, unreadable, or incomplete.
    for (const key of INSTALLATION_CREDENTIAL_KEYS) delete process.env[key];
    for (const key of LEGACY_HOOK_CREDENTIAL_KEYS) delete process.env[key];
    // The same rule applies to backend/mode switches.  In particular, do not
    // let ORGBRAIN_ENABLE_CLOUD_MEMORY from the parent process override the
    // local-only value in hooks.env or credentials.env.
    for (const key of EXPLICIT_HOOK_MODE_KEYS) delete process.env[key];
    // A missing or unreadable explicitly selected file must be inert. These
    // defaults keep the hook from accidentally becoming an enabled local
    // capture process after the inherited values were removed.
    Object.assign(process.env, EXPLICIT_HOOK_SAFE_DEFAULTS);
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
        } else if (configured && EXPLICIT_HOOK_MODE_KEYS.has(key)) {
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
      transcriptPath: firstString(parsed?.transcript_path),
      modelProvider: firstString(parsed?.model_provider, parsed?.provider),
      model: firstString(parsed?.model),
      stopHookActive: parsed?.stop_hook_active === true
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
  // Native Cursor uses workspace_roots rather than cwd. Ambiguous multi-root
  // sessions need an explicit working directory; never guess project ownership.
  const roots = [...new Set((Array.isArray(parsed?.workspace_roots) ? parsed.workspace_roots : [])
    .filter(root => typeof root === 'string' && path.isAbsolute(root)).map(root => path.resolve(root)))];
  return buildCommonRecord("cursor", payloadText, parsed, {
    cwd: roots.length === 1 ? roots[0] : null,
    eventType: firstString(parsed?.type, parsed?.event?.type, "afterAgentResponse"),
    externalKey: `cursor:${sha256(payloadText).slice(0, 16)}`,
    assistantText: firstString(parsed?.message, parsed?.assistant, parsed?.response, parsed?.content),
    metadata: {
      sessionId: firstString(parsed?.conversation_id, parsed?.session_id),
      turnId: firstString(parsed?.generation_id, parsed?.turn_id),
      transcriptPath: firstString(parsed?.transcript_path)
    }
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
    const { entry: previewMapped } = await resolveWorkspaceMapping(previewConfig, cwd);
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
    let mapping = await resolveWorkspaceMapping(config, cwd);
    let mapped = mapping.entry;

    let tenantId = mapped?.tenant_id ?? tenantFallbackFromEnv(env, {
      organizationSharing: memoryMode.orgSharingEnabled
    });

    if (!mapped && options.migrateLegacy !== false) {
      const legacyNames = options.legacyNames ?? await loadLegacyProjectNames(legacyFile);
      const migration = migrateLegacyProjectNames(config, legacyNames, configuredTenantId);
      changed = migration.changed;
      mapping = await resolveWorkspaceMapping(config, cwd);
      mapped = mapping.entry;
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
        source: mapping.source
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
      capture_route: record.captureRoute ?? "legacy",
      capture_batch_id: record.captureBatchId ?? null,
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
  let activityScope = null;
  let memoryUseReport = null;
  let sessionExtraction = null;
  const finish = async (result) => {
    if(inputSourceName==='codex-stop'&&activityScope&&workspace.memoryLearningMode!=='off'){
      try{const {LocalMemoryStore,DEFAULT_LOCAL_DB}=await import('./lib/local-memory-store.mjs');
        const {wakeMemoryPipeline}=await import('./lib/memory-pipeline.mjs');
        result.memory_pipeline=await wakeMemoryPipeline(new LocalMemoryStore(process.env.ORGBRAIN_LOCAL_DB||DEFAULT_LOCAL_DB),{tenantId,projectId:workspace.projectId});
      }catch{result.memory_pipeline={started:false,reason:'intake_or_wake_unavailable'};}
    }
    if (sessionExtraction) result.session_extraction = sessionExtraction;
    if (activityScope) {
      const { DEFAULT_LOCAL_DB } = await import("./lib/local-memory-store.mjs");
      const { TaskCommitmentStore } = await import("./lib/task-commitment-store.mjs");
      await new TaskCommitmentStore(process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB).recordHookActivity({
        ...activityScope, event: inputSourceName, status: { memory_use:memoryUseReport, ok: result.ok, mode: result.mode ?? null, skipped: result.skipped ?? null,
          confirmation_candidates: result.confirmation_candidates ?? confirmationQueue.length,
          continuation_requested: result.confirmation_continuation === true,
          created: Number(result.created ?? 0),
          review_count: Number(result.review_count ?? 0),
          reason_code: result.reason_code ?? null,
          reason_codes: Array.isArray(result.reason_codes) ? result.reason_codes.slice(0, 12) : [],
          turn_evidence_error: result.capture_v2_shadow?.turn_evidence_error ?? null }
      });
    }
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
  const nonInteractiveHook = ["codex-stop", "claude", "cursor"].includes(inputSourceName);
  const workspace = await resolveWorkspaceContext(workspaceRecord, {
    memoryMode,
    ...(nonInteractiveHook ? { prompt: false } : {})
  });
  tenantId = workspace.tenantId;
  activityScope = { tenantId, projectId: workspace.projectId };
  if (workspace.memoryLearningMode === 'off') return finish({ok:true,source:sourceName,skipped:'memory-learning-off',confirmation_candidates:0});
  const commonExtractionEnabled = process.env.ORGBRAIN_SESSION_EXTRACTION_MODE === 'on'
    && process.env.ORGBRAIN_LOCAL_HOOK_CAPTURE !== 'false'
    && workspace.memoryLearningMode !== 'confirm';
  if (nonInteractiveHook && commonExtractionEnabled) {
    const { loadClientTurnRows, enqueueSessionExtraction, wakeSessionExtraction, sessionExtractionAutorunEnabled } = await import('./lib/session-extraction.mjs');
    try {
      const client = sourceName;
      const rows = await loadClientTurnRows({client, transcript_path: normalizedRecord.metadata?.transcriptPath,
        session_id: normalizedRecord.metadata?.sessionId, turn_id: normalizedRecord.metadata?.turnId,
        workspace: workspace.workspaceRoot, completed: true});
      sessionExtraction = rows.length ? await enqueueSessionExtraction({rows, client, tenantId,
        projectId: workspace.projectId, workspace: workspace.workspaceRoot,
        sessionId: normalizedRecord.metadata?.sessionId, turnId: normalizedRecord.metadata?.turnId})
        : {queued: 0, status: 'complete_turn_unavailable'};
      if (sessionExtractionAutorunEnabled() && ['prepared','partial_input_held'].includes(sessionExtraction.status)) {
        sessionExtraction.worker = await (options.wakeSessionExtraction ?? wakeSessionExtraction)({tenantId,
          projectId: workspace.projectId, dbPath: process.env.ORGBRAIN_LOCAL_DB});
      }
    } catch {
      sessionExtraction = {queued: 0, status: 'evidence_load_failed'};
    }
  }
  if (inputSourceName === "codex-stop") {
    const { LocalMemoryStore, DEFAULT_LOCAL_DB } = await import("./lib/local-memory-store.mjs");
    const useStore = new LocalMemoryStore(process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB);
    const status = await useStore.useHistory("status");
    if (status.flags.collect) {
      const evidence = await readMemoryUseTurnEvidence({transcriptPath:normalizedRecord.metadata?.transcriptPath,turnId:normalizedRecord.metadata?.turnId});
      memoryUseReport = await collectMemoryUse(useStore,{rows:evidence.rows,readReason:evidence.reason,tenantId,projectId:workspace.projectId,taskId:taskKeyFromHookPayload(normalizedRecord.metadata ?? normalizedRecord),turnId:normalizedRecord.metadata?.turnId});
    }
  }

  captureV2Mode = workspace.memoryCaptureV2Mode ?? captureV2Mode;
  let records;
  let shadowReport = null;
  let learningReport = null;
  let learningReviewCandidates = [];
  let verifiedObservedRecords = [];
  let extractionPrepared = null;
  let extractionEnqueue = null;
  let confirmationQueue = [];
  const queueConfirmations = async () => {
    if (inputSourceName !== "codex-stop") return [];
    const deterministicCandidates = workspace.memoryLearningMode === "confirm"
      ? (extractionPrepared?.records ?? []).map(deterministicRecordConfirmationCandidate).filter(Boolean)
      : [];
    return queueMemoryConfirmationCandidates({
      tenantId,
      projectId: workspace.projectId,
      taskPayload: normalizedRecord.metadata ?? normalizedRecord,
      candidates: [
        ...learningReviewCandidates,
        ...(extractionPrepared?.confirmationCandidates ?? []),
        ...deterministicCandidates
      ].filter((candidate) => !isMemoryConfirmationFlowArtifact(candidate))
    });
  };
  const extractionMode = workspace.memoryLearningMode === "confirm" ? "off" : process.env.ORGBRAIN_MEMORY_EXTRACTION_MODE ?? "off";
  const extractionProfileValue = process.env.ORGBRAIN_MEMORY_EXTRACTION_PROFILE?.trim();
  if (extractionProfileValue && !["off", "coverage/v1"].includes(extractionProfileValue)) {
    throw new Error(`unsupported ORGBRAIN_MEMORY_EXTRACTION_PROFILE: ${extractionProfileValue}`);
  }
  const extractionProfile = extractionProfileValue === "coverage/v1" ? "coverage/v1" : undefined;
  const refinementProfileValue = process.env.ORGBRAIN_MEMORY_REFINEMENT_PROFILE?.trim();
  if (refinementProfileValue && !["off", "a-plus/v1"].includes(refinementProfileValue)) {
    throw new Error(`unsupported ORGBRAIN_MEMORY_REFINEMENT_PROFILE: ${refinementProfileValue}`);
  }
  const refinementProfile = refinementProfileValue === "a-plus/v1" ? refinementProfileValue : undefined;
  let evidenceRows = [];
  let evidenceLoadError = null;
  let evidenceReadDiagnostics = null;
  if (inputSourceName === "codex-stop" && (extractionMode !== "off" || ["on", "shadow", "confirm", "eager"].includes(workspace.memoryLearningMode))) {
    evidenceRows = await loadTurnEvidenceRows({
      transcript_path: normalizedRecord.metadata?.transcriptPath,
      turn_id: normalizedRecord.metadata?.turnId,
      require_final: true,
      on_diagnostic: (value) => { evidenceReadDiagnostics = value; }
    }).catch((error) => {
      evidenceLoadError = error instanceof Error ? error.message : "turn_evidence_load_failed";
      return [];
    });
    extractionPrepared = await prepareMemoryRecordsV2(normalizedRecord, workspace, tenantId, {
      rows: evidenceRows,
      requireFullTurn: true,
      extractionProfile,
      refinementProfile
    });
    if (evidenceLoadError) extractionPrepared.report.turn_evidence_error = evidenceLoadError;
    if (evidenceReadDiagnostics) extractionPrepared.report.turn_evidence_read = evidenceReadDiagnostics;
    shadowReport = extractionPrepared.report;
    learningReviewCandidates = extractionPrepared.reviewCandidates ?? [];
    if (
      !commonExtractionEnabled && ["canary", "on"].includes(extractionMode) &&
      extractionPrepared.extractionRequest &&
      workspace.projectId &&
      memoryMode.cloudWritesAllowed
    ) {
      const extractionMcp = resolveMcpConfig();
      if (extractionMcp.complete) {
        extractionEnqueue = await postMemoryExtractionViaMcp(
          extractionMcp,
          tenantId,
          extractionPrepared.extractionRequest,
          workspace.projectId
        ).catch((error) => ({
          execution_status: "enqueue_failed",
          outcome: null,
          error_code: hookDeliveryErrorCode(error),
          reserved_tokens: 0,
          cache_hit: false
        }));
      } else {
        extractionEnqueue = {
          execution_status: "not_enqueued",
          outcome: "model_unavailable",
          error_code: "missing_orgbrain_mcp_env",
          reserved_tokens: 0,
          cache_hit: false
        };
      }
    }
  }
  if (inputSourceName === "codex-stop" && ["shadow", "on", "confirm", "eager"].includes(workspace.memoryLearningMode)) {
    const observed = await prepareObservedLearningRecords(normalizedRecord, workspace, tenantId, {
      ...(evidenceRows.length ? { rows: evidenceRows } : {}),
      includeDeterministicReviewCandidates: workspace.memoryLearningMode !== "eager"
    });
    learningReport = observed.report;
    verifiedObservedRecords = observed.records ?? [];
    learningReviewCandidates = [...(observed.reviewCandidates ?? []), ...learningReviewCandidates]
      .filter((candidate, index, all) => all.findIndex((item) => item.external_key === candidate.external_key) === index)
      .slice(0, 3);
    if (workspace.memoryLearningMode === "on") records = observed.records;
  }
  if (inputSourceName === "codex-stop" && workspace.memoryLearningMode === "confirm") {
    // Confirmation-only rollout: local candidates, no cloud write, outbox,
    // automatic memory capture or provider enqueue. A later human answer
    // authorizes the interactive Remote MCP write separately.
    confirmationQueue = await queueConfirmations();
    const { DEFAULT_LOCAL_DB } = await import("./lib/local-memory-store.mjs");
    const { TaskCommitmentStore, taskKeyFromHookPayload } = await import("./lib/task-commitment-store.mjs");
    const confirmationStore = new TaskCommitmentStore(process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB);
    const taskKey = taskKeyFromHookPayload(normalizedRecord.metadata ?? normalizedRecord);
    const confirmationBatch = await confirmationStore.takeMemoryConfirmationBatch({
      tenantId,
      projectId: workspace.projectId,
      taskKey,
      deliverySessionKey: taskKey
    });
    const confirmationContinuation = confirmationBatch.length > 0 && normalizedRecord.metadata?.stopHookActive !== true;
    return finish({ ok: true, source: sourceName, tenant_id: tenantId,
      mode: "confirmation-only", inserted: 0,
      confirmation_candidates: confirmationBatch.length,
      confirmation_questions: confirmationBatch.map(memoryConfirmationQuestion),
      confirmation_queue_count: confirmationQueue.filter((item) => item.created).length,
      confirmation_continuation: confirmationContinuation });
  }
  if (inputSourceName === "codex-stop" && workspace.memoryLearningMode === "eager") {
    const eagerRecords = [...verifiedObservedRecords, ...(extractionPrepared?.eagerRecords ?? [])]
      .filter((item, index, all) => all.findIndex((candidate) =>
        (candidate.canonicalKey && candidate.canonicalKey === item.canonicalKey)
        || candidate.externalKey === item.externalKey
      ) === index)
      .slice(0, MEMORY_CAPTURE_HOOK_PROFILE.max_candidates);
    if (classifiedAutoSaveEnabled() && !memoryMode.cloudWritesAllowed && process.env.ORGBRAIN_LOCAL_HOOK_CAPTURE !== 'false' && learningReviewCandidates.length) {
      const { DEFAULT_LOCAL_DB } = await import('./lib/local-memory-store.mjs');
      const { TaskCommitmentStore, taskKeyFromHookPayload } = await import('./lib/task-commitment-store.mjs');
      const candidates = learningReviewCandidates.filter(candidate => !eagerRecords.some(item => candidate.item?.external_key === item.externalKey));
      const saved = await new TaskCommitmentStore(process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB).saveLearningCandidates({
        tenantId, projectId: workspace.projectId, taskKey: taskKeyFromHookPayload(normalizedRecord.metadata ?? normalizedRecord),
        candidates, autoSaveClassified: true
      });
      if (eagerRecords.length === 0 && saved.length) return finish({
        ok: true, source: sourceName, tenant_id: tenantId, mode: 'eager',
        inserted: saved.filter(item => item.status === 'active').length,
        review_count: saved.filter(item => item.status === 'quarantine').length,
        held_count: saved.filter(item => item.status === 'held').length,
        ...memoryModeFields(memoryMode)
      });
    }
    if (eagerRecords.length === 0) {
      const reasonCode = Number(learningReport?.observed_count ?? 0) > 0
        ? "eager-no-verified-observation"
        : shadowReport?.latest_retrieval !== "miss"
        ? shadowReport?.latest_retrieval == null && shadowReport?.opaque_tool_wrappers > 0
          ? "eager-native-tool-evidence-unavailable" : "eager-no-retrieval-miss"
        : Number(shadowReport?.successful_actions_after_miss ?? 0) === 0
          ? "eager-no-verified-work-after-miss"
          : shadowReport?.sensitivity_reason
            ? `eager-${shadowReport.sensitivity_reason}`
            : "eager-no-safe-durable-candidate";
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        mode: "eager",
        inserted: 0,
        skipped: reasonCode,
        reason_code: reasonCode,
        ...(shadowReport ? { capture_v2_shadow: shadowReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    }
    records = eagerRecords;
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
    confirmationQueue = await queueConfirmations();
    if (!memoryMode.cloudWritesAllowed) {
      const savedReviews = await commitmentStore.saveLearningCandidates({
        tenantId,
        projectId: workspace.projectId,
        taskKey,
        candidates: learningReviewCandidates,
        autoSaveClassified: classifiedAutoSaveEnabled() && process.env.ORGBRAIN_LOCAL_HOOK_CAPTURE !== 'false'
      });
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        mode: "local",
        inserted: savedReviews.filter(item => item.status === 'active').length,
        review_count: savedReviews.filter(item => item.status === 'quarantine').length,
        confirmation_queue_count: confirmationQueue.filter((item) => item.created).length,
        ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
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
        confirmation_queue_count: confirmationQueue.filter((item) => item.created).length,
        quarantine_count: learningReviewCandidates.length,
        ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
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
        confirmation_queue_count: confirmationQueue.filter((item) => item.created).length,
        ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
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
      confirmation_queue_count: confirmationQueue.filter((item) => item.created).length,
      quarantine_count: Number(result?.quarantine_inserted ?? result?.review_inserted ?? learningReviewCandidates.length),
      ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
      transport: "mcp-2026-07-28",
      ...(learningReport ? { verified_learning_shadow: learningReport } : {}),
      ...memoryModeFields(memoryMode)
    });
  }
  if (!records && workspace.memoryLearningMode !== "on" && (captureV2Mode === "on" || captureV2Mode === "shadow")) {
    const v2 = extractionPrepared ?? await prepareMemoryRecordsV2(normalizedRecord, workspace, tenantId, {
      ...(evidenceRows.length ? { rows: evidenceRows } : {})
    });
    shadowReport = v2.report;
    learningReviewCandidates = [...learningReviewCandidates, ...(v2.reviewCandidates ?? [])]
      .filter((candidate, index, all) => all.findIndex((item) => item.external_key === candidate.external_key) === index)
      .slice(0, 3);
    // Rule and inferred extraction never becomes active directly. Complete
    // candidates still enter the review/quarantine contract without an LLM.
    if (captureV2Mode === "on") {
      // Only the exact-source, project-scoped 30-day episodic route may be
      // activated without an LLM review. Durable rule drafts remain review-only.
      records = extractionMode === "on" ? (v2.operationalRecords ?? []) : [];
    }
  }
  confirmationQueue = await queueConfirmations();
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
  if (learningReviewCandidates.length > 0 && workspace.memoryLearningMode !== "on" && captureV2Mode === "on") {
    const { DEFAULT_LOCAL_DB } = await import("./lib/local-memory-store.mjs");
    const { TaskCommitmentStore, taskKeyFromHookPayload } = await import("./lib/task-commitment-store.mjs");
    const commitmentStore = new TaskCommitmentStore(process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB);
    const taskKey = taskKeyFromHookPayload(normalizedRecord.metadata ?? normalizedRecord);
    if (!memoryMode.cloudWritesAllowed) {
      const saved = await commitmentStore.saveLearningCandidates({
        tenantId,
        projectId: workspace.projectId,
        taskKey,
        candidates: learningReviewCandidates,
        autoSaveClassified: classifiedAutoSaveEnabled() && process.env.ORGBRAIN_LOCAL_HOOK_CAPTURE !== 'false'
      });
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        mode: "local",
        inserted: saved.filter(item => item.status === 'active').length,
        review_count: saved.filter(item => item.status === 'quarantine').length,
        quarantine_count: saved.filter(item => item.status === 'quarantine').length,
        ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
        ...(shadowReport ? { capture_v2_shadow: shadowReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    }
    const reviewMcp = resolveMcpConfig();
    const reviewBatch = {
      projectId: workspace.projectId,
      taskKey,
      records: [],
      reviewCandidates: learningReviewCandidates
    };
    if (!reviewMcp.complete) {
      const outbox = await commitmentStore.saveLearningOutbox({
        tenantId,
        payload: buildMcpLearningBatchRequest(tenantId, sourceName, reviewBatch)
      });
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        queued: "learning-outbox",
        outbox,
        review_count: learningReviewCandidates.length,
        quarantine_count: learningReviewCandidates.length,
        ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
        ...(shadowReport ? { capture_v2_shadow: shadowReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    }
    try {
      const reviewResult = await postLearningBatchViaMcp(reviewMcp, tenantId, sourceName, reviewBatch);
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        inserted: 0,
        review_count: Number(reviewResult?.review_inserted ?? learningReviewCandidates.length),
        quarantine_count: Number(reviewResult?.quarantine_inserted ?? reviewResult?.review_inserted ?? learningReviewCandidates.length),
        transport: "mcp-2026-07-28",
        ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
        ...(shadowReport ? { capture_v2_shadow: shadowReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    } catch (error) {
      const outbox = await commitmentStore.saveLearningOutbox({
        tenantId,
        payload: buildMcpLearningBatchRequest(tenantId, sourceName, reviewBatch)
      });
      return finish({
        ok: true,
        source: sourceName,
        tenant_id: tenantId,
        queued: "learning-outbox",
        outbox,
        error_code: error?.name === "TimeoutError" ? "mcp_timeout" : "mcp_learning_batch_failed",
        review_count: learningReviewCandidates.length,
        quarantine_count: learningReviewCandidates.length,
        ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
        ...(shadowReport ? { capture_v2_shadow: shadowReport } : {}),
        ...memoryModeFields(memoryMode)
      });
    }
  }
  if (!records?.length) {
    return finish({
      ok: true,
      source: sourceName,
      tenant_id: tenantId,
      skipped: "no-durable-candidates",
      reason_codes: shadowReport?.excluded_reasons ?? [],
      sensitivity_reason: shadowReport?.sensitivity_reason ?? null,
      ...(extractionEnqueue ? { memory_extraction: extractionEnqueue } : {}),
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
    const { enqueueJudgmentCapture } = await import("./lib/local-memory-judge-queue.mjs");
    const { DEFAULT_LOCAL_DB } = await import("./lib/local-memory-store.mjs");
    const judgmentQueue = classifiedAutoSaveEnabled() ? { queued: false } : await enqueueJudgmentCapture({
      dbPath: process.env.ORGBRAIN_LOCAL_DB || DEFAULT_LOCAL_DB,
      tenantId, projectId: workspace.projectId, source: sourceName, records
    }).catch(() => ({ queued: false, reason_code: "capture_queue_unavailable" }));
    if (judgmentQueue.queued && judgmentQueue.mode === "active") {
      return finish({ ok: true, source: sourceName, tenant_id: tenantId, mode: "jev-capture-queued", inserted: 0,
        judgment_queue_id: judgmentQueue.id, ...memoryModeFields(memoryMode) });
    }
    const results = await captureLocalMemories(sourceName, tenantId, records);
    return finish({
      ok: true,
      source: sourceName,
      tenant_id: tenantId,
      mode: workspace.memoryLearningMode === "eager" ? "eager" : "local",
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

  const batchRequired = captureV2Mode === "on" || ["on", "eager"].includes(workspace.memoryLearningMode);
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
    ...(workspace.memoryLearningMode === "eager" ? { mode: "eager" } : {}),
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
