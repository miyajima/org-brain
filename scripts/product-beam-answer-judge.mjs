#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ANSWER_MODEL = "gemini-3.6-flash";
const JUDGE_MODEL = "gemini-3.6-flash";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

function parseArgs(argv) {
  const options = {
    datasetRoot: null,
    chatSize: null,
    retrieval: null,
    output: null,
    summaryOutput: null,
    answerModel: ANSWER_MODEL,
    judgeModel: JUDGE_MODEL,
    concurrency: 6,
    limit: null,
    resume: false
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
    else if (value === "--retrieval") options.retrieval = next();
    else if (value === "--output") options.output = next();
    else if (value === "--summary-output") options.summaryOutput = next();
    else if (value === "--answer-model") options.answerModel = next();
    else if (value === "--judge-model") options.judgeModel = next();
    else if (value === "--concurrency") options.concurrency = Number(next());
    else if (value === "--limit") options.limit = Number(next());
    else if (value === "--resume") options.resume = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  for (const required of ["datasetRoot", "chatSize", "retrieval", "output"]) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!["500K", "1M", "10M"].includes(options.chatSize)) {
    throw new Error("--chat-size must be one of 500K, 1M, or 10M");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error("--concurrency must be between 1 and 16");
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1)) {
    throw new Error("--limit must be >= 1");
  }
  options.summaryOutput ??= options.output.replace(/\.jsonl$/u, "-summary.json");
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonl(raw) {
  return raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function flattenMessages(batches) {
  return batches.flatMap((batch, batchIndex) =>
    (Array.isArray(batch.turns) ? batch.turns : []).map((messages, turnIndex) => ({
      turn_id: `batch-${batch.batch_number ?? batchIndex + 1}-turn-${turnIndex + 1}`,
      messages: (Array.isArray(messages) ? messages : [])
        .filter((message) => message && typeof message === "object")
        .map((message) => ({
          id: String(message.id),
          role: String(message.role ?? "unknown"),
          content: String(message.content ?? "")
        }))
    }))
  );
}

function buildContext(turns, retrievedMessageIds) {
  const turnByMessageId = new Map();
  for (const turn of turns) {
    for (const message of turn.messages) turnByMessageId.set(message.id, turn);
  }
  const selected = [];
  const seen = new Set();
  for (const messageId of retrievedMessageIds) {
    const turn = turnByMessageId.get(String(messageId));
    if (turn && !seen.has(turn.turn_id)) {
      seen.add(turn.turn_id);
      selected.push(turn);
    }
  }
  return selected
    .map((turn) => turn.messages.map((message) => `${message.role}: ${message.content}`).join("\n"))
    .join("\n\n");
}

export function buildAnswerPrompt({ context, question }) {
  return `You are an assistant that MUST answer questions using ONLY the information provided in the context below.

STRICT INSTRUCTIONS:
1. Answer ONLY based on the provided context
2. Do NOT use your internal knowledge

CONTEXT:
${context}

QUESTION:
${question}

ANSWER REQUIREMENTS:
- Be direct and concise
- Only output the answer to the question without any explanation

RESPONSE:`;
}

export function buildJudgePrompt({ question, rubricItem, response }) {
  return `You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- QUESTION (what the user asked): ${question}
- RUBRIC CRITERION (what to check): ${rubricItem}
- RESPONSE TO EVALUATE: ${response}

## RESPONSIVENESS REQUIREMENT
A compliant response must be on-topic and attempt to answer the QUESTION. If it does not, score 0.0.
For negative constraints, the response must be responsive and the prohibited element must be absent.

## SEMANTIC TOLERANCE
Judge by meaning, accepting paraphrases, synonyms, formatting differences, and numerically equivalent numbers, currencies, and dates.
Ignore tone, length, and style unless the rubric explicitly requires a format.

## SCORING
- 1.0: complete compliance
- 0.5: partial compliance or a minor inaccuracy
- 0.0: missing, incorrect, prohibited, or non-responsive

Return only a JSON object with "score" (0, 0.5, or 1) and "reason".`;
}

async function geminiGenerate({ apiKey, model, prompt, json = false, attempts = 7 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(
        `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              ...(json ? { responseMimeType: "application/json" } : {})
            }
          })
        }
      );
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`Gemini ${response.status}: ${body.slice(0, 500)}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const payload = JSON.parse(body);
      const text = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim();
      if (!text) throw new Error("Gemini returned no text");
      return {
        text,
        usage: {
          prompt_tokens: payload.usageMetadata?.promptTokenCount ?? null,
          response_tokens: payload.usageMetadata?.candidatesTokenCount ?? null,
          total_tokens: payload.usageMetadata?.totalTokenCount ?? null
        }
      };
    } catch (error) {
      lastError = error;
      if (attempt === attempts || error?.retryable === false) break;
      const delay = Math.min(20_000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function normalizeJudge(raw) {
  const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/gu, ""));
  const score = Number(parsed.score);
  if (![0, 0.5, 1].includes(score)) throw new Error(`invalid judge score: ${parsed.score}`);
  return { score, reason: String(parsed.reason ?? "") };
}

export function summarizeBeamAnswers(rows, metadata = {}) {
  const complete = rows.filter((row) => !row.error);
  const rubricScores = complete.flatMap((row) => row.judgments.map((judgment) => judgment.score));
  const categories = {};
  for (const row of rows) {
    const category = categories[row.category] ?? { questions: 0, rubric_items: 0, score_sum: 0, errors: 0 };
    category.questions += 1;
    category.errors += row.error ? 1 : 0;
    for (const judgment of row.judgments ?? []) {
      category.rubric_items += 1;
      category.score_sum += judgment.score;
    }
    categories[row.category] = category;
  }
  for (const category of Object.values(categories)) {
    category.score = category.rubric_items === 0 ? null : category.score_sum / category.rubric_items;
    delete category.score_sum;
  }
  return {
    benchmark: "BEAM official-rubric answer evaluation",
    benchmark_track: "OrgBrain product retrieval; Gemini answer and rubric judge",
    chat_size: metadata.chatSize,
    question_count: rows.length,
    completed_questions: complete.length,
    rubric_item_count: rubricScores.length,
    rubric_score: rubricScores.length === 0
      ? null
      : rubricScores.reduce((sum, score) => sum + score, 0) / rubricScores.length,
    question_full_compliance: complete.length === 0
      ? null
      : complete.filter((row) => row.judgments.every((judgment) => judgment.score === 1)).length / complete.length,
    errors: rows.filter((row) => row.error).length,
    models: metadata.models,
    categories
  };
}

async function loadCases(options, retrievalRows) {
  const retrievalById = new Map(retrievalRows.map((row) => [row.evaluation_id, row]));
  const chatRoot = join(options.datasetRoot, "chats", options.chatSize);
  const chatIds = (await readdir(chatRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Number(left) - Number(right));
  const cases = [];
  const hashParts = [];
  for (const chatId of chatIds) {
    const directory = join(chatRoot, chatId);
    const [chatRaw, questionsRaw] = await Promise.all([
      readFile(join(directory, "chat.json"), "utf8"),
      readFile(join(directory, "probing_questions", "probing_questions.json"), "utf8")
    ]);
    hashParts.push(chatRaw, questionsRaw);
    const turns = flattenMessages(JSON.parse(chatRaw));
    for (const [category, questions] of Object.entries(JSON.parse(questionsRaw))) {
      for (const [index, question] of questions.entries()) {
        const evaluationId = `${options.chatSize}-${chatId}-${category}-${index + 1}`;
        const retrieval = retrievalById.get(evaluationId);
        if (!retrieval) continue;
        cases.push({
          evaluation_id: evaluationId,
          chat_id: chatId,
          category,
          question: String(question.question ?? ""),
          rubric: (Array.isArray(question.rubric) ? question.rubric : []).map(String),
          context: buildContext(turns, retrieval.retrieved_message_ids ?? [])
        });
      }
    }
  }
  return {
    cases: cases.slice(0, options.limit ?? Infinity),
    datasetSha256: sha256(hashParts.join("\n"))
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");
  const retrievalRaw = await readFile(options.retrieval, "utf8");
  const retrievalRows = parseJsonl(retrievalRaw);
  const { cases, datasetSha256 } = await loadCases(options, retrievalRows);
  if (cases.length !== retrievalRows.slice(0, options.limit ?? Infinity).length) {
    throw new Error(`retrieval/case mismatch: ${retrievalRows.length} retrieval rows, ${cases.length} cases`);
  }

  await mkdir(dirname(options.output), { recursive: true });
  let rows = [];
  if (options.resume) {
    try {
      rows = parseJsonl(await readFile(options.output, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } else {
    await writeFile(options.output, "", { mode: 0o600 });
  }
  const completedIds = new Set(rows.filter((row) => !row.error).map((row) => row.evaluation_id));
  const pending = cases.filter((item) => !completedIds.has(item.evaluation_id));
  let nextIndex = 0;
  let appendQueue = Promise.resolve();
  const worker = async () => {
    while (nextIndex < pending.length) {
      const item = pending[nextIndex++];
      let row;
      try {
        const answerResult = await geminiGenerate({
          apiKey,
          model: options.answerModel,
          prompt: buildAnswerPrompt(item)
        });
        const judgments = [];
        for (const rubricItem of item.rubric) {
          const result = await geminiGenerate({
            apiKey,
            model: options.judgeModel,
            prompt: buildJudgePrompt({
              question: item.question,
              rubricItem,
              response: answerResult.text
            }),
            json: true
          });
          judgments.push({
            rubric_item: rubricItem,
            ...normalizeJudge(result.text),
            usage: result.usage
          });
        }
        row = {
          evaluation_id: item.evaluation_id,
          chat_id: item.chat_id,
          category: item.category,
          answer: answerResult.text,
          judgments,
          answer_usage: answerResult.usage,
          error: null
        };
      } catch (error) {
        row = {
          evaluation_id: item.evaluation_id,
          chat_id: item.chat_id,
          category: item.category,
          answer: null,
          judgments: [],
          answer_usage: null,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      rows = rows.filter((existing) => existing.evaluation_id !== item.evaluation_id);
      rows.push(row);
      appendQueue = appendQueue.then(() =>
        appendFile(options.output, `${JSON.stringify(row)}\n`, { mode: 0o600 })
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, () => worker()));
  await appendQueue;
  const summary = {
    dataset: {
      repository: "https://github.com/mohammadtavakoli78/BEAM",
      sha256: datasetSha256,
      retrieval_artifact: options.retrieval,
      retrieval_sha256: sha256(retrievalRaw)
    },
    protocol: {
      answer_prompt: "BEAM answer_generation_for_rag",
      judge_prompt: "BEAM unified_llm_judge_base_prompt",
      answer_context: "OrgBrain hybrid_v3 top-5 product-path retrieval",
      scorer_labels_visible_to_answer_model: false,
      failed_rows_excluded: false,
      resume: options.resume
    },
    summary: summarizeBeamAnswers(rows, {
      chatSize: options.chatSize,
      models: { answer: options.answerModel, judge: options.judgeModel }
    })
  };
  await writeFile(options.summaryOutput, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: options.output, summary_output: options.summaryOutput, ...summary }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
