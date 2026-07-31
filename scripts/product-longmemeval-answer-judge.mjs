#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-3.6-flash";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonl(raw) {
  return raw.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

function parseArgs(argv) {
  const options = {
    dataset: null,
    retrieval: null,
    output: null,
    summaryOutput: null,
    answerModel: DEFAULT_MODEL,
    judgeModel: DEFAULT_MODEL,
    repeat: 1,
    concurrency: 6,
    resume: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => {
      index += 1;
      if (!argv[index]) throw new Error(`${value} requires a value`);
      return argv[index];
    };
    if (value === "--dataset") options.dataset = next();
    else if (value === "--retrieval") options.retrieval = next();
    else if (value === "--output") options.output = next();
    else if (value === "--summary-output") options.summaryOutput = next();
    else if (value === "--answer-model") options.answerModel = next();
    else if (value === "--judge-model") options.judgeModel = next();
    else if (value === "--repeat") options.repeat = Number(next());
    else if (value === "--concurrency") options.concurrency = Number(next());
    else if (value === "--resume") options.resume = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  for (const key of ["dataset", "retrieval", "output"]) {
    if (!options[key]) throw new Error(`--${key} is required`);
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1) throw new Error("--repeat must be >= 1");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) {
    throw new Error("--concurrency must be between 1 and 16");
  }
  options.summaryOutput ??= options.output.replace(/\.jsonl$/u, "-summary.json");
  return options;
}

function sessionText(session) {
  return (Array.isArray(session) ? session : [])
    .map((message) => `${message.role ?? "unknown"}: ${message.content ?? ""}`)
    .join("\n");
}

export function buildLongMemEvalAnswerPrompt({ contexts, questionDate, question }) {
  return `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.

History Chats:

${contexts.join("\n\n")}

Current Date: ${questionDate}
Question: ${question}
Answer:`;
}

export function buildLongMemEvalJudgePrompt({ category, questionId, question, answer, response }) {
  if (String(questionId).endsWith("_abs")) {
    return `Judge whether the response correctly identifies the question as unanswerable from the history. It may say the information is incomplete or that the asked information was not given.
Question: ${question}
Explanation: ${answer}
Response: ${response}
Return JSON only: {"label": true or false, "reason": "brief reason"}.`;
  }
  if (category === "preference" || category === "single-session-preference") {
    return `Judge whether the response satisfies the personalized-response rubric. It need not reflect every point, but must recall and use the user's personal information correctly.
Question: ${question}
Rubric: ${answer}
Response: ${response}
Return JSON only: {"label": true or false, "reason": "brief reason"}.`;
  }
  const tolerance = category === "temporal-reasoning"
    ? "Do not penalize an off-by-one error in a number of days, weeks, or months."
    : category === "knowledge-update"
      ? "If previous information is also mentioned, accept the response as long as the required updated answer is present."
      : "Equivalent wording and complete intermediate reasoning are acceptable; a response containing only a required subset is not.";
  return `Judge whether the response contains the correct answer. ${tolerance}
Question: ${question}
Correct Answer: ${answer}
Response: ${response}
Return JSON only: {"label": true or false, "reason": "brief reason"}.`;
}

async function generate({ apiKey, model, prompt, json = false, attempts = 7 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            ...(json ? { responseMimeType: "application/json" } : {})
          }
        })
      });
      const body = await response.text();
      if (!response.ok) {
        const error = new Error(`Gemini ${response.status}: ${body.slice(0, 500)}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const payload = JSON.parse(body);
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
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
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(20_000, 500 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250))
      );
    }
  }
  throw lastError;
}

function normalizeJudge(raw) {
  const cleaned = raw.replace(/^```json\s*|\s*```$/gu, "").trim();
  const parseJson = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return JSON.parse(value.replace(/\\(?!["\\/bfnrtu])/gu, "\\\\"));
    }
  };
  let parsed;
  try {
    parsed = parseJson(cleaned);
  } catch {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = 0; index < cleaned.length; index += 1) {
      const character = cleaned[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
      } else if (character === "\"") inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) {
        end = index + 1;
        break;
      }
    }
    parsed = parseJson(cleaned.slice(0, end));
  }
  if (typeof parsed.label !== "boolean") throw new Error("judge label must be boolean");
  return { label: parsed.label, reason: String(parsed.reason ?? "") };
}

export function summarizeLongMemEvalAnswers(rows, models) {
  const categories = {};
  for (const row of rows) {
    const category = categories[row.category] ?? { correct: 0, total: 0, errors: 0 };
    category.total += 1;
    category.correct += row.label === true ? 1 : 0;
    category.errors += row.error ? 1 : 0;
    categories[row.category] = category;
  }
  for (const category of Object.values(categories)) {
    category.accuracy = category.total ? category.correct / category.total : null;
  }
  return {
    benchmark: "LongMemEval unseen product-path answer accuracy",
    question_count: rows.length,
    correct: rows.filter((row) => row.label === true).length,
    accuracy: rows.length ? rows.filter((row) => row.label === true).length / rows.length : null,
    errors: rows.filter((row) => row.error).length,
    failed_rows_excluded: false,
    models,
    categories
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");
  const [datasetRaw, retrievalRaw] = await Promise.all([
    readFile(options.dataset, "utf8"),
    readFile(options.retrieval, "utf8")
  ]);
  const dataset = JSON.parse(datasetRaw);
  const references = new Map(dataset.map((row) => [String(row.question_id), row]));
  const retrievalRows = parseJsonl(retrievalRaw).filter((row) => row.repeat === options.repeat);
  const cases = retrievalRows.map((retrieval) => {
    const reference = references.get(String(retrieval.evaluation_id));
    if (!reference) throw new Error(`missing dataset row: ${retrieval.evaluation_id}`);
    const sessions = new Map(reference.haystack_session_ids.map((id, index) => [
      String(id),
      {
        date: reference.haystack_dates[index],
        session: reference.haystack_sessions[index]
      }
    ]));
    const contexts = retrieval.retrieved_source_ids
      .map((id) => sessions.get(String(id)))
      .filter(Boolean)
      .map((session) => `Session Date: ${session.date}\n${sessionText(session.session)}`);
    return { reference, contexts };
  });

  await mkdir(dirname(options.output), { recursive: true });
  let rows = [];
  if (options.resume) {
    try {
      rows = parseJsonl(await readFile(options.output, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    rows = [...new Map(rows.map((row) => [row.evaluation_id, row])).values()];
  }
  await writeFile(options.output, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 });
  const complete = new Set(rows.filter((row) => !row.error).map((row) => row.evaluation_id));
  const pending = cases.filter(({ reference }) => !complete.has(String(reference.question_id)));
  let nextIndex = 0;
  let appendQueue = Promise.resolve();
  const worker = async () => {
    while (nextIndex < pending.length) {
      const { reference, contexts } = pending[nextIndex++];
      let row;
      try {
        const answer = await generate({
          apiKey,
          model: options.answerModel,
          prompt: buildLongMemEvalAnswerPrompt({
            contexts,
            questionDate: reference.question_date,
            question: reference.question
          })
        });
        const judgment = await generate({
          apiKey,
          model: options.judgeModel,
          prompt: buildLongMemEvalJudgePrompt({
            category: reference.question_type,
            questionId: reference.question_id,
            question: reference.question,
            answer: reference.answer,
            response: answer.text
          }),
          json: true
        });
        row = {
          evaluation_id: String(reference.question_id),
          category: reference.question_type,
          answer: answer.text,
          ...normalizeJudge(judgment.text),
          answer_usage: answer.usage,
          judge_usage: judgment.usage,
          error: null
        };
      } catch (error) {
        row = {
          evaluation_id: String(reference.question_id),
          category: reference.question_type,
          answer: null,
          label: false,
          reason: null,
          answer_usage: null,
          judge_usage: null,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      rows = rows.filter((existing) => existing.evaluation_id !== row.evaluation_id);
      rows.push(row);
      appendQueue = appendQueue.then(() =>
        appendFile(options.output, `${JSON.stringify(row)}\n`, { mode: 0o600 })
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, () => worker()));
  await appendQueue;
  const report = {
    output: options.output,
    protocol: {
      answer_prompt: "LongMemEval official retrieved-chat generation prompt",
      judge_prompt: "LongMemEval official category-specific answer check",
      scorer_labels_visible_to_answer_model: false,
      retrieval_repeat: options.repeat,
      dataset_sha256: sha256(datasetRaw),
      retrieval_sha256: sha256(retrievalRaw)
    },
    summary: summarizeLongMemEvalAnswers(rows, {
      answer: options.answerModel,
      judge: options.judgeModel
    })
  };
  await writeFile(options.summaryOutput, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ summary_output: options.summaryOutput, ...report }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
