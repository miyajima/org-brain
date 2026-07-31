#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalMemoryStore } from "./lib/local-memory-store.mjs";

function parseArgs(argv) {
  const options = {
    datasetRoot: null,
    chatSize: "100K",
    output: null,
    topK: 5,
    limit: null,
    concurrency: 4
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`${value} requires a value`);
      return argv[index];
    };
    if (value === "--dataset-root") options.datasetRoot = next();
    else if (value === "--chat-size") options.chatSize = next();
    else if (value === "--output") options.output = next();
    else if (value === "--top-k") options.topK = Number(next());
    else if (value === "--limit") options.limit = Number(next());
    else if (value === "--concurrency") options.concurrency = Number(next());
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!options.datasetRoot) throw new Error("--dataset-root is required");
  if (!["100K", "500K", "1M", "10M"].includes(options.chatSize)) {
    throw new Error("--chat-size must be one of 100K, 500K, 1M, or 10M");
  }
  if (!Number.isInteger(options.topK) || options.topK < 1) throw new Error("--top-k must be >= 1");
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be >= 1");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error("--concurrency must be between 1 and 16");
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function flattenSourceIds(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenSourceIds(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) flattenSourceIds(item, output);
  } else if (Number.isInteger(value) || (typeof value === "string" && /^\d+$/u.test(value))) {
    output.push(String(value));
  }
  return output;
}

export function normalizeBeamChat(chatRaw, questionsRaw, chatId, chatSize = "100K") {
  const batches = JSON.parse(chatRaw);
  const categories = JSON.parse(questionsRaw);
  if (!Array.isArray(batches)) throw new Error("BEAM chat.json must be an array");
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) {
    throw new Error("BEAM probing_questions.json must be an object");
  }
  const turns = batches.flatMap((batch, batchIndex) =>
    (Array.isArray(batch.turns) ? batch.turns : []).map((messages, turnIndex) => {
      const normalizedMessages = (Array.isArray(messages) ? messages : [])
        .filter((message) => message && typeof message === "object")
        .map((message) => ({
          id: String(message.id),
          role: String(message.role ?? "unknown"),
          content: String(message.content ?? "")
        }));
      return {
        source_id: `batch-${batch.batch_number ?? batchIndex + 1}-turn-${turnIndex + 1}`,
        message_ids: normalizedMessages.map((message) => message.id),
        content: normalizedMessages
          .map((message) => `${message.role}: ${message.content}`)
          .join("\n")
      };
    })
  );
  const questions = [];
  const excludedQuestions = {};
  for (const [category, entries] of Object.entries(categories)) {
    for (const [questionIndex, entry] of (Array.isArray(entries) ? entries : []).entries()) {
      const expectedMessageIds = [...new Set(flattenSourceIds(entry.source_chat_ids))];
      if (expectedMessageIds.length === 0) {
        excludedQuestions[category] = (excludedQuestions[category] ?? 0) + 1;
        continue;
      }
      questions.push({
        evaluation_id: `${chatSize}-${chatId}-${category}-${questionIndex + 1}`,
        category,
        question: String(entry.question ?? ""),
        expected_message_ids: expectedMessageIds
      });
    }
  }
  return {
    chat_id: String(chatId),
    chat_size: chatSize,
    turns,
    questions,
    excluded_questions_by_category: excludedQuestions
  };
}

export async function seedBeamChat(runtimeInput, { store }) {
  if (!store) throw new Error("seedBeamChat requires a MemoryStore");
  const principalId = "beam-retrieval-reader";
  for (const [turnIndex, turn] of runtimeInput.turns.entries()) {
    const eventAt = 1_600_000_000_000 + turnIndex;
    await store.capture({
      tenant_id: runtimeInput.tenant_id,
      project_id: "beam-retrieval",
      kind: "episodic",
      lifecycle_state: "active",
      scope_type: "project",
      scope_key: "beam-retrieval",
      content: turn.content,
      summary: null,
      tags: ["beam-source-turn"],
      entities: [],
      source: "beam",
      source_references: turn.message_ids.map((messageId) => ({
        type: "beam-message",
        ref: messageId,
        captured_at: eventAt
      })),
      external_key: `beam-turn:${turn.source_id}`,
      actor_type: "system",
      actor_id: "beam-retrieval-runner",
      created_at: eventAt,
      updated_at: eventAt,
      valid_from: null,
      valid_until: null,
      confidence_score: 1,
      utility_score: 0.5,
      rationale: null,
      evidence: [],
      conflicts: [],
      permissions: [{
        principal_type: "principal",
        principal_id: principalId,
        permissions: ["read"]
      }]
    });
  }
}

/**
 * Integrity boundary: only the natural-language question reaches search.
 * Evaluation IDs and source-chat labels remain in the scorer.
 */
export async function runBeamRetrieval(runtimeInput, { store, topK = 5 }) {
  if (!store) throw new Error("runBeamRetrieval requires a MemoryStore");
  const startedAt = performance.now();
  const results = await store.search({
    tenant_id: runtimeInput.tenant_id,
    project_id: "beam-retrieval",
    query: runtimeInput.question,
    limit: topK,
    principal_id: "beam-retrieval-reader",
    search_mode: "hybrid_v3"
  });
  return {
    latency_ms: performance.now() - startedAt,
    message_ids: [...new Set(results.flatMap((result) =>
      result.memory.source_references
        .filter((reference) => reference.type === "beam-message")
        .map((reference) => String(reference.ref))
    ))]
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(rows, metadata) {
  const scored = rows.filter((row) => !row.error);
  const categories = {};
  for (const row of rows) {
    const category = categories[row.category] ?? {
      total: 0,
      any_hits: 0,
      all_hits: 0,
      errors: 0
    };
    category.total += 1;
    category.any_hits += row.recall_any_at_k ? 1 : 0;
    category.all_hits += row.recall_all_at_k ? 1 : 0;
    category.errors += row.error ? 1 : 0;
    categories[row.category] = category;
  }
  return {
    benchmark: "BEAM product-path evidence retrieval",
    benchmark_track: "retrieval-only; not official LLM answer accuracy",
    chat_size: metadata.chatSize,
    chat_count: metadata.chatCount,
    question_count: rows.length,
    excluded_unscored_questions: metadata.excludedUnscoredQuestions,
    excluded_questions_by_category: metadata.excludedQuestionsByCategory,
    recall_any_at_k: scored.filter((row) => row.recall_any_at_k).length / scored.length,
    recall_all_at_k: scored.filter((row) => row.recall_all_at_k).length / scored.length,
    p95_latency_ms: percentile(scored.map((row) => row.latency_ms), 0.95),
    errors: rows.filter((row) => row.error).length,
    categories
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chatRoot = join(options.datasetRoot, "chats", options.chatSize);
  const chatIds = (await readdir(chatRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Number(left) - Number(right));
  const chats = [];
  const hashParts = [];
  for (const chatId of chatIds) {
    const directory = join(chatRoot, chatId);
    const [chatRaw, questionsRaw] = await Promise.all([
      readFile(join(directory, "chat.json"), "utf8"),
      readFile(join(directory, "probing_questions", "probing_questions.json"), "utf8")
    ]);
    hashParts.push(chatRaw, questionsRaw);
    chats.push(normalizeBeamChat(chatRaw, questionsRaw, chatId, options.chatSize));
  }
  const selectedQuestions = chats
    .flatMap((chat) => chat.questions.map((question) => ({ chat, question })))
    .slice(0, options.limit ?? Infinity);
  const selectedIds = new Set(selectedQuestions.map(({ question }) => question.evaluation_id));
  const selectedChats = chats
    .map((chat) => ({
      ...chat,
      questions: chat.questions.filter((question) => selectedIds.has(question.evaluation_id))
    }))
    .filter((chat) => chat.questions.length > 0);
  const output = options.output ?? join(
    process.cwd(),
    "artifacts",
    `product-beam-${options.chatSize.toLowerCase()}-${Date.now()}.jsonl`
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "", { mode: 0o600 });
  const rows = [];
  let appendQueue = Promise.resolve();
  let nextChatIndex = 0;
  const worker = async () => {
    while (nextChatIndex < selectedChats.length) {
      const chatIndex = nextChatIndex++;
      const chat = selectedChats[chatIndex];
      const directory = await mkdtemp(join(tmpdir(), "orgbrain-beam-"));
      try {
        const store = new LocalMemoryStore(join(directory, "memory.sqlite"));
        const tenantId = `beam-${options.chatSize}-${chat.chat_id}`;
        await seedBeamChat({
          tenant_id: tenantId,
          turns: chat.turns
        }, { store });
        for (const question of chat.questions) {
          let row;
          try {
            const retrieval = await runBeamRetrieval({
              tenant_id: tenantId,
              question: question.question
            }, {
              store,
              topK: options.topK
            });
            const expected = new Set(question.expected_message_ids);
            const recalled = retrieval.message_ids.filter((id) => expected.has(id));
            row = {
              evaluation_id: question.evaluation_id,
              chat_id: chat.chat_id,
              category: question.category,
              expected_source_count: expected.size,
              retrieved_message_ids: retrieval.message_ids,
              recalled_message_ids: recalled,
              recall_any_at_k: recalled.length > 0,
              recall_all_at_k: recalled.length === expected.size,
              latency_ms: Number(retrieval.latency_ms.toFixed(3)),
              error: null
            };
          } catch (error) {
            row = {
              evaluation_id: question.evaluation_id,
              chat_id: chat.chat_id,
              category: question.category,
              expected_source_count: question.expected_message_ids.length,
              retrieved_message_ids: [],
              recalled_message_ids: [],
              recall_any_at_k: false,
              recall_all_at_k: false,
              latency_ms: null,
              error: error instanceof Error ? error.message : String(error)
            };
          }
          rows.push(row);
          appendQueue = appendQueue.then(() =>
            appendFile(output, `${JSON.stringify(row)}\n`, { mode: 0o600 })
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, selectedChats.length) }, () => worker())
  );
  await appendQueue;
  const excludedQuestionsByCategory = {};
  for (const chat of selectedChats) {
    for (const [category, count] of Object.entries(chat.excluded_questions_by_category)) {
      excludedQuestionsByCategory[category] =
        (excludedQuestionsByCategory[category] ?? 0) + count;
    }
  }
  const excludedUnscoredQuestions = Object.values(excludedQuestionsByCategory)
    .reduce((sum, count) => sum + count, 0);
  process.stdout.write(`${JSON.stringify({
    output,
    dataset_sha256: sha256(hashParts.join("\n")),
    selected_ids_sha256: sha256(
      selectedQuestions.map(({ question }) => question.evaluation_id).join("\n")
    ),
    runner: {
      search_mode: "hybrid_v3",
      top_k: options.topK,
      concurrency: options.concurrency
    },
    summary: summarize(rows, {
      chatSize: options.chatSize,
      chatCount: selectedChats.length,
      excludedUnscoredQuestions,
      excludedQuestionsByCategory
    })
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
