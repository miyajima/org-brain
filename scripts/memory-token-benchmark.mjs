#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import {
  buildFtsQuery,
  formatJst,
  parseLocationArgs,
  runD1Queries,
  sqlString
} from "./lib/metrics-common.mjs";
import {
  TOKEN_ESTIMATE_MODEL,
  buildFullContextPrompt,
  buildTreatmentPrompt,
  buildTransientBenchmarkIndex,
  collapseWhitespace,
  computeAnswerTextHitAtK,
  computeEvidenceCoverageAtK,
  computeEvidenceRecallAtK,
  computeTokenReduction,
  estimateTokens,
  parseLongMemEvalDataset,
  retrieveFromTransientBenchmarkIndex,
  summarizeBenchmarkResults
} from "./lib/memory-token-benchmark-core.mjs";

const DEFAULT_DATASET_URL = "https://huggingface.co/datasets/LIXINYI33/longmemeval-s/resolve/main/longmemeval_s_cleaned.json";
const STRATEGIES = new Set(["bm25_v1", "bm25_rewrite_v1", "hybrid_memory_docs_v1"]);
const BENCHMARK_INDEXES = new Set(["transient-sqlite", "transient-memory", "production-d1"]);
const TRANSIENT_STRATEGIES = new Set(["bm25_lite_v1", "longmemeval_session_v2"]);

function printHelp() {
  console.log(`Org Brain token reduction benchmark

Usage:
  pnpm benchmark:tokens -- --dataset-path <json|jsonl> [options]
  node ./scripts/memory-token-benchmark.mjs [options]

Options:
  --tenant <tenant_id>         Tenant to inspect (default: default)
  --database <name>            D1 database binding/name (default: open-brain)
  --local|--preview|--remote   D1 location (default: remote)
  --env <name>                 Wrangler environment name
  --benchmark <name>           Benchmark name (default: longmemeval-s)
  --benchmark-index <name>     transient-sqlite|transient-memory|production-d1 (default: transient-sqlite)
  --transient-strategy <name>  bm25_lite_v1|longmemeval_session_v2 (default: longmemeval_session_v2)
  --strategy <name>            bm25_v1|bm25_rewrite_v1|hybrid_memory_docs_v1 (default: hybrid_memory_docs_v1)
  --limit <n>                  Number of benchmark items (default: 500)
  --dataset-path <path>        Local LongMemEval JSON/JSONL dataset
  --dataset-url <url>          Dataset URL when no local path is provided
  --context-char-limit <n>     Characters kept per retrieved context item (default: 1200)
  --judge-provider <name>      Judge provider (default: gemini)
  --judge-model <name>         Gemini judge model (default: gemini-3.5-flash)
  --generator-model <name>     Gemini generator model (default: gemini-3.5-flash)
  --write-retrieval-failures <path>
                              Write failed evidence retrieval examples as JSONL
  --skip-llm                   Skip Gemini generation/judging and use token accounting only
  --dry-run                    Alias for --skip-llm
  --json                       Emit machine-readable JSON
  --help                       Show this message
`);
}

function parseArgs(argv) {
  const options = {
    ...parseLocationArgs(argv),
    benchmark: "longmemeval-s",
    benchmarkIndex: "transient-sqlite",
    transientStrategy: "longmemeval_session_v2",
    strategy: "hybrid_memory_docs_v1",
    limit: 500,
    datasetPath: undefined,
    datasetUrl: DEFAULT_DATASET_URL,
    contextCharLimit: 1200,
    judgeProvider: "gemini",
    judgeModel: "gemini-3.5-flash",
    generatorModel: "gemini-3.5-flash",
    writeRetrievalFailures: undefined,
    skipLlm: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (
      arg === "--" ||
      arg === "--help" ||
      arg === "-h" ||
      arg === "--json" ||
      arg === "--local" ||
      arg === "--preview" ||
      arg === "--remote" ||
      arg === "--tenant" ||
      arg.startsWith("--tenant=") ||
      arg === "--database" ||
      arg.startsWith("--database=") ||
      arg === "--env" ||
      arg.startsWith("--env=")
    ) {
      if (["--tenant", "--database", "--env"].includes(arg)) index += 1;
      continue;
    }
    if (arg === "--skip-llm" || arg === "--dry-run") {
      options.skipLlm = true;
      continue;
    }
    if (arg === "--benchmark" || arg.startsWith("--benchmark=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--benchmark requires a value");
      options.benchmark = value;
      continue;
    }
    if (arg === "--benchmark-index" || arg.startsWith("--benchmark-index=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!BENCHMARK_INDEXES.has(value)) throw new Error(`--benchmark-index must be one of ${[...BENCHMARK_INDEXES].join(", ")}`);
      options.benchmarkIndex = value;
      continue;
    }
    if (arg === "--transient-strategy" || arg.startsWith("--transient-strategy=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!TRANSIENT_STRATEGIES.has(value)) throw new Error(`--transient-strategy must be one of ${[...TRANSIENT_STRATEGIES].join(", ")}`);
      options.transientStrategy = value;
      continue;
    }
    if (arg === "--strategy" || arg.startsWith("--strategy=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!STRATEGIES.has(value)) throw new Error(`--strategy must be one of ${[...STRATEGIES].join(", ")}`);
      options.strategy = value;
      continue;
    }
    if (arg === "--limit" || arg.startsWith("--limit=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--limit requires a positive integer");
      options.limit = parsed;
      continue;
    }
    if (arg === "--context-char-limit" || arg.startsWith("--context-char-limit=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--context-char-limit requires a positive integer");
      options.contextCharLimit = parsed;
      continue;
    }
    if (arg === "--dataset-path" || arg.startsWith("--dataset-path=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--dataset-path requires a value");
      options.datasetPath = value;
      continue;
    }
    if (arg === "--dataset-url" || arg.startsWith("--dataset-url=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--dataset-url requires a value");
      options.datasetUrl = value;
      continue;
    }
    if (arg === "--judge-provider" || arg.startsWith("--judge-provider=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--judge-provider requires a value");
      options.judgeProvider = value;
      continue;
    }
    if (arg === "--judge-model" || arg.startsWith("--judge-model=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--judge-model requires a value");
      options.judgeModel = value;
      continue;
    }
    if (arg === "--generator-model" || arg.startsWith("--generator-model=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--generator-model requires a value");
      options.generatorModel = value;
      continue;
    }
    if (arg === "--write-retrieval-failures" || arg.startsWith("--write-retrieval-failures=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      if (!value) throw new Error("--write-retrieval-failures requires a value");
      options.writeRetrievalFailures = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function tokenizeForRewrite(raw) {
  return [...new Set(
    collapseWhitespace(raw)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s/_.:-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  )].slice(0, 8);
}

function singularizeToken(token) {
  if (token.length <= 3) return token;
  return token.endsWith("s") ? token.slice(0, -1) : token;
}

function buildQueryVariants(raw, rewrite = false) {
  const normalized = collapseWhitespace(raw);
  if (!normalized) return [];
  const seen = new Set();
  const variants = [];
  const push = (query) => {
    if (!query || seen.has(query)) return;
    seen.add(query);
    variants.push(query);
  };

  if (rewrite) push(`"${normalized.replace(/"/g, '""')}"`);
  push(buildFtsQuery(normalized));

  if (rewrite) {
    const splitTokens = tokenizeForRewrite(normalized);
    if (splitTokens.length > 0) {
      push(splitTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR "));
      const singularTokens = [...new Set(splitTokens.map(singularizeToken).filter((token) => token.length >= 2))];
      push(singularTokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(" OR "));
    }
  }

  return variants.slice(0, rewrite ? 4 : 1);
}

function buildDocQuery(rawVariant) {
  const cleaned = rawVariant.replace(/\*/g, "").replace(/"/g, " ");
  return buildFtsQuery(cleaned.replace(/\s+OR\s+/g, " "));
}

function compareRank(left, right) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

function sortByRank(left, right) {
  return compareRank(left.raw_rank, right.raw_rank) || Number(right.created_at ?? 0) - Number(left.created_at ?? 0);
}

function clip(value, limit) {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}...`;
}

async function loadDataset(options) {
  if (options.datasetPath) {
    return readFile(options.datasetPath, "utf8");
  }

  const response = await fetch(options.datasetUrl);
  if (!response.ok) {
    throw new Error(`Failed to download dataset: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function runStrategy(options, queryText) {
  const startedAt = Date.now();
  const rewrite = options.strategy !== "bm25_v1";
  const variants = buildQueryVariants(queryText, rewrite);
  if (variants.length === 0) {
    return {
      strategy: options.strategy,
      matched_count: 0,
      returned_count: 0,
      fallback_used: true,
      latency_ms: Date.now() - startedAt,
      contexts: []
    };
  }

  const memoryById = new Map();
  for (const variant of variants) {
    const response = await runD1Queries(options, {
      matched: `
        SELECT m.id, m.project_id, m.source, m.summary,
               substr(COALESCE(m.content, ''), 1, ${options.contextCharLimit}) AS content_preview,
               m.created_at, bm25(memories_fts) AS raw_rank
        FROM memories_fts
        JOIN memories m
          ON m.id = memories_fts.memory_id
         AND m.tenant_id = memories_fts.tenant_id
        WHERE memories_fts.tenant_id = ${sqlString(options.tenant)}
          AND memories_fts.content MATCH ${sqlString(variant)}
        ORDER BY bm25(memories_fts) ASC, m.created_at DESC
        LIMIT 10;
      `
    });

    for (const row of response.matched) {
      const existing = memoryById.get(row.id);
      if (!existing || compareRank(row.raw_rank ?? null, existing.raw_rank ?? null) < 0) {
        memoryById.set(row.id, {
          kind: "memory",
          id: row.id,
          project_id: row.project_id ?? null,
          source: row.source ?? null,
          title: row.summary ?? row.id,
          summary: row.summary ?? null,
          content_preview: clip(row.content_preview ?? "", options.contextCharLimit),
          created_at: row.created_at,
          raw_rank: row.raw_rank ?? null
        });
      }
    }
  }

  const lexicalRows = [...memoryById.values()].sort(sortByRank);
  let contexts = lexicalRows.slice(0, 5);

  if (options.strategy === "hybrid_memory_docs_v1" && lexicalRows.length < 3) {
    const docById = new Map();
    for (const variant of variants) {
      const docQuery = buildDocQuery(variant);
      if (!docQuery) continue;
      const response = await runD1Queries(options, {
        docs: `
          SELECT d.id, d.title, d.summary,
                 substr(COALESCE(d.body_text, ''), 1, ${options.contextCharLimit}) AS body_preview,
                 d.updated_at AS created_at, bm25(knowledge_docs_fts) AS raw_rank
          FROM knowledge_docs_fts
          JOIN knowledge_docs d
            ON d.id = knowledge_docs_fts.doc_id
           AND d.tenant_id = knowledge_docs_fts.tenant_id
          WHERE knowledge_docs_fts.tenant_id = ${sqlString(options.tenant)}
            AND knowledge_docs_fts MATCH ${sqlString(docQuery)}
            AND d.deleted_at IS NULL
          ORDER BY bm25(knowledge_docs_fts) ASC, d.updated_at DESC
          LIMIT 4;
        `
      });
      for (const row of response.docs) {
        const id = `doc:${row.id}`;
        const existing = docById.get(id);
        if (!existing || compareRank(row.raw_rank ?? null, existing.raw_rank ?? null) < 0) {
          docById.set(id, {
            kind: "doc",
            id: row.id,
            title: row.title ?? row.id,
            summary: row.summary ?? null,
            body_preview: clip(row.body_preview ?? "", options.contextCharLimit),
            created_at: row.created_at,
            raw_rank: row.raw_rank ?? null
          });
        }
      }
    }

    contexts = [...contexts, ...[...docById.values()].sort(sortByRank).slice(0, 2)].slice(0, 5);
  }

  return {
    strategy: options.strategy,
    matched_count: lexicalRows.length,
    returned_count: contexts.length,
    fallback_used: contexts.length === 0,
    latency_ms: Date.now() - startedAt,
    contexts
  };
}

function useTransientIndex(options) {
  return options.benchmarkIndex === "transient-sqlite" || options.benchmarkIndex === "transient-memory";
}

async function runRetrieval(options, item) {
  if (useTransientIndex(options)) {
    const itemIndex = buildTransientBenchmarkIndex([item], {
      chunkCharLimit: Math.max(options.contextCharLimit, 1800),
      transientStrategy: options.transientStrategy
    });
    return retrieveFromTransientBenchmarkIndex(itemIndex, item, {
      strategy: `${options.strategy}:transient_${options.transientStrategy}`,
      transientStrategy: options.transientStrategy,
      topK: 5,
      contextCharLimit: options.contextCharLimit
    });
  }
  return runStrategy(options, item.question);
}

function geminiKey(env = process.env) {
  return env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "";
}

async function geminiRequest(model, method, payload, apiKey) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gemini ${method} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function countPromptTokens(text, model, apiKey) {
  if (!apiKey) return { tokens: estimateTokens(text), token_source: TOKEN_ESTIMATE_MODEL };
  try {
    const body = await geminiRequest(model, "countTokens", { contents: [{ parts: [{ text }] }] }, apiKey);
    const tokens = Number(body.totalTokens ?? body.total_tokens);
    if (Number.isFinite(tokens)) return { tokens, token_source: "gemini_count_tokens" };
  } catch {
    // Fall back below; token accounting must not block deterministic benchmark runs.
  }
  return { tokens: estimateTokens(text), token_source: TOKEN_ESTIMATE_MODEL };
}

function extractGeminiText(body) {
  return (body.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

async function generateWithGemini(prompt, model, apiKey) {
  const body = await geminiRequest(
    model,
    "generateContent",
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, topP: 1 }
    },
    apiKey
  );
  return extractGeminiText(body);
}

function parseJudgeText(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/u);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const passed = parsed.passed === true || String(parsed.verdict ?? "").toLowerCase() === "pass";
      return {
        verdict: passed ? "pass" : "fail",
        passed,
        rationale: collapseWhitespace(parsed.rationale ?? parsed.reason ?? "")
      };
    } catch {
      // Fall through to text parsing.
    }
  }
  const passed = /\b(pass|correct|yes)\b/i.test(text) && !/\b(fail|incorrect|no)\b/i.test(text);
  return {
    verdict: passed ? "pass" : "fail",
    passed,
    rationale: collapseWhitespace(text)
  };
}

async function judgeWithGemini(item, generatedAnswer, model, apiKey) {
  const prompt = [
    "You are a deterministic benchmark judge.",
    "Decide whether the model answer correctly answers the question given the gold answer.",
    "Return strict JSON only: {\"verdict\":\"pass\"|\"fail\",\"passed\":boolean,\"rationale\":\"short reason\"}.",
    "",
    `Question: ${item.question}`,
    `Gold answer: ${item.answer || "(missing)"}`,
    `Model answer: ${generatedAnswer || "(empty)"}`
  ].join("\n");
  const text = await generateWithGemini(prompt, model, apiKey);
  return parseJudgeText(text);
}

async function fetchExistingMeasurementRuns(options) {
  try {
    const data = await runD1Queries(options, {
      runs: `
        SELECT r.id, r.measurement_session_id, r.created_at,
               c.input_tokens_saved, c.input_savings_rate, c.quality_verdict, c.quality_passed,
               control.input_tokens AS control_input_tokens,
               treatment.input_tokens AS treatment_input_tokens
        FROM measurement_runs r
        LEFT JOIN measurement_comparisons c
          ON c.tenant_id = r.tenant_id
         AND c.run_id = r.id
        LEFT JOIN measurement_variants control
          ON control.tenant_id = r.tenant_id
         AND control.run_id = r.id
         AND control.variant = 'control'
        LEFT JOIN measurement_variants treatment
          ON treatment.tenant_id = r.tenant_id
         AND treatment.run_id = r.id
         AND treatment.variant = 'treatment'
        WHERE r.tenant_id = ${sqlString(options.tenant)}
        ORDER BY r.created_at DESC
        LIMIT 10;
      `
    });
    return data.runs.map((row) => ({
      id: row.id,
      measurement_session_id: row.measurement_session_id ?? null,
      created_at: Number(row.created_at ?? 0),
      created_at_jst: formatJst(Number(row.created_at ?? 0)),
      control_input_tokens: row.control_input_tokens === null || row.control_input_tokens === undefined ? null : Number(row.control_input_tokens),
      treatment_input_tokens: row.treatment_input_tokens === null || row.treatment_input_tokens === undefined ? null : Number(row.treatment_input_tokens),
      input_tokens_saved: row.input_tokens_saved === null || row.input_tokens_saved === undefined ? null : Number(row.input_tokens_saved),
      input_savings_rate: row.input_savings_rate === null || row.input_savings_rate === undefined ? null : Number(row.input_savings_rate),
      quality_verdict: row.quality_verdict ?? null,
      quality_passed: row.quality_passed === null || row.quality_passed === undefined ? null : Number(row.quality_passed) > 0
    }));
  } catch (error) {
    return [{ error: error instanceof Error ? error.message : String(error) }];
  }
}

async function runItem(options, item, apiKey) {
  const retrieval = await runRetrieval(options, item);
  const fullPrompt = buildFullContextPrompt(item);
  const treatmentPrompt = buildTreatmentPrompt(item, retrieval.contexts);
  const [fullTokenCount, treatmentTokenCount] = await Promise.all([
    countPromptTokens(fullPrompt, options.generatorModel, apiKey),
    countPromptTokens(treatmentPrompt, options.generatorModel, apiKey)
  ]);
  const reduction = computeTokenReduction(fullTokenCount.tokens, treatmentTokenCount.tokens);
  const evidenceRecallAtFive = computeEvidenceRecallAtK(item, retrieval.contexts);
  const evidenceCoverageAtFive = computeEvidenceCoverageAtK(item, retrieval.contexts);
  const answerTextHitAtFive = computeAnswerTextHitAtK(item.answer, retrieval.contexts);

  let generatedAnswer = null;
  let judge = { verdict: "not_run", passed: null, rationale: options.skipLlm ? "LLM skipped" : "Gemini API key missing" };
  if (!options.skipLlm && apiKey) {
    generatedAnswer = await generateWithGemini(treatmentPrompt, options.generatorModel, apiKey);
    judge = await judgeWithGemini(item, generatedAnswer, options.judgeModel, apiKey);
  }

  return {
    id: item.id,
    category: item.category,
    question_preview: item.question.slice(0, 160),
    ...reduction,
    token_source:
      fullTokenCount.token_source === treatmentTokenCount.token_source
        ? fullTokenCount.token_source
        : `${fullTokenCount.token_source}+${treatmentTokenCount.token_source}`,
    retrieval_count: retrieval.returned_count,
    retrieval_latency_ms: retrieval.latency_ms,
    fallback_used: retrieval.fallback_used,
    matched_count: retrieval.matched_count,
    recall_at_5: evidenceRecallAtFive,
    evidence_recall_at_5: evidenceRecallAtFive,
    evidence_coverage_at_5: evidenceCoverageAtFive,
    answer_text_hit_at_5: answerTextHitAtFive,
    retrieved_context_ids: retrieval.contexts.map((context) => context.kind === "doc" ? `doc:${context.id}` : context.id),
    retrieved_session_ids: [...new Set(retrieval.contexts.map((context) => context.session_id).filter(Boolean))],
    answer_session_ids: item.answer_session_ids ?? [],
    generated_answer: generatedAnswer,
    judge
  };
}

async function writeRetrievalFailures(path, items, results) {
  if (!path) return;
  const itemById = new Map(items.map((item) => [item.id, item]));
  const lines = results
    .filter((result) => result.evidence_recall_at_5 === false)
    .map((result) => {
      const item = itemById.get(result.id);
      return JSON.stringify({
        id: result.id,
        category: result.category,
        question: item?.question ?? result.question_preview,
        answer: item?.answer ?? null,
        answer_session_ids: result.answer_session_ids,
        retrieved_session_ids: result.retrieved_session_ids,
        retrieved_context_ids: result.retrieved_context_ids,
        evidence_coverage_at_5: result.evidence_coverage_at_5,
        answer_text_hit_at_5: result.answer_text_hit_at_5
      });
    })
    .join("\n");
  await writeFile(path, lines ? `${lines}\n` : "", "utf8");
}

function printText(snapshot) {
  const accuracy = snapshot.summary.accuracy === null ? "n/a" : `${(snapshot.summary.accuracy * 100).toFixed(1)}%`;
  console.log("Org Brain token reduction benchmark");
  console.log(`Scope: tenant=${snapshot.scope.tenant} benchmark=${snapshot.scope.benchmark} strategy=${snapshot.scope.strategy} source=${snapshot.scope.location}`);
  console.log(`Captured: ${snapshot.captured_at_jst}`);
  console.log(`Token source: ${snapshot.token_source}`);
  console.log("");
  console.log("Summary");
  console.log(`  items=${snapshot.summary.item_count} judged=${snapshot.summary.judged_count} pass=${snapshot.summary.judge_pass_count} accuracy=${accuracy}`);
  const recallAtFive = snapshot.summary.recall_at_5 === null ? "n/a" : `${(snapshot.summary.recall_at_5 * 100).toFixed(1)}%`;
  const answerTextHit = snapshot.summary.answer_text_hit_at_5 === null ? "n/a" : `${(snapshot.summary.answer_text_hit_at_5 * 100).toFixed(1)}%`;
  const evidenceCoverage = snapshot.summary.evidence_coverage_at_5 === null ? "n/a" : `${(snapshot.summary.evidence_coverage_at_5 * 100).toFixed(1)}%`;
  console.log(`  evidence_recall@5=${recallAtFive} recall_pass=${snapshot.summary.recall_at_5_pass_count}/${snapshot.summary.recall_eligible_count}`);
  console.log(`  answer_text_hit@5=${answerTextHit} evidence_coverage@5=${evidenceCoverage}`);
  console.log(
    `  full_context_tokens=${snapshot.summary.full_context_tokens} org_brain_context_tokens=${snapshot.summary.org_brain_context_tokens} tokens_saved=${snapshot.summary.tokens_saved} reduction=${(snapshot.summary.token_reduction_rate * 100).toFixed(1)}%`
  );
  console.log(
    `  retrieval_count=${snapshot.summary.retrieval_count} fallback_count=${snapshot.summary.fallback_count} fallback_rate=${(snapshot.summary.fallback_rate * 100).toFixed(1)}% avg_latency_ms=${snapshot.summary.avg_retrieval_latency_ms.toFixed(1)}`
  );
  console.log("");
  console.log("Categories");
  for (const category of snapshot.summary.categories) {
    const categoryAccuracy = category.accuracy === null ? "n/a" : `${(category.accuracy * 100).toFixed(1)}%`;
    const categoryRecall = category.recall_at_5 === null ? "n/a" : `${(category.recall_at_5 * 100).toFixed(1)}%`;
    const categoryTextHit = category.answer_text_hit_at_5 === null ? "n/a" : `${(category.answer_text_hit_at_5 * 100).toFixed(1)}%`;
    const categoryCoverage = category.evidence_coverage_at_5 === null ? "n/a" : `${(category.evidence_coverage_at_5 * 100).toFixed(1)}%`;
    console.log(
      `  ${category.category}: items=${category.item_count} accuracy=${categoryAccuracy} evidence_recall@5=${categoryRecall} answer_text_hit@5=${categoryTextHit} evidence_coverage@5=${categoryCoverage} saved=${category.tokens_saved} reduction=${(category.token_reduction_rate * 100).toFixed(1)}% fallback=${category.fallback_count}`
    );
  }
  console.log("");
  console.log("Existing measurement runs");
  if (snapshot.summary.existing_measurement_runs.length === 0) {
    console.log("  none");
  } else {
    for (const run of snapshot.summary.existing_measurement_runs) {
      if (run.error) {
        console.log(`  unavailable: ${run.error}`);
        continue;
      }
      const rate = run.input_savings_rate === null ? "n/a" : `${(run.input_savings_rate * 100).toFixed(1)}%`;
      console.log(
        `  ${run.id}: ${run.control_input_tokens ?? "n/a"} -> ${run.treatment_input_tokens ?? "n/a"} saved=${run.input_tokens_saved ?? "n/a"} reduction=${rate} quality=${run.quality_verdict ?? "n/a"}`
      );
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.judgeProvider !== "gemini") {
    throw new Error("Only --judge-provider gemini is supported in v1");
  }

  const rawDataset = await loadDataset(options);
  const items = parseLongMemEvalDataset(rawDataset).slice(0, options.limit);
  const apiKey = options.skipLlm ? "" : geminiKey();
  if (!apiKey) options.skipLlm = true;

  const existingMeasurementRuns = await fetchExistingMeasurementRuns(options);
  const results = [];
  for (const item of items) {
    results.push(await runItem(options, item, apiKey));
  }
  await writeRetrievalFailures(options.writeRetrievalFailures, items, results);

  const summary = summarizeBenchmarkResults(results, existingMeasurementRuns);
  const tokenSources = [...new Set(results.map((result) => result.token_source))];
  const now = Date.now();
  const snapshot = {
    captured_at: now,
    captured_at_jst: formatJst(now),
    scope: {
      tenant: options.tenant,
      database: options.database,
      location: options.location,
      env: options.env ?? null,
      benchmark: options.benchmark,
      benchmark_index: options.benchmarkIndex,
      transient_strategy: options.transientStrategy,
      strategy: options.strategy,
      limit: options.limit,
      dataset_path: options.datasetPath ?? null,
      dataset_url: options.datasetPath ? null : options.datasetUrl,
      judge_provider: options.judgeProvider,
      judge_model: options.judgeModel,
      generator_model: options.generatorModel,
      write_retrieval_failures: options.writeRetrievalFailures ?? null,
      skip_llm: options.skipLlm
    },
    token_source: tokenSources.length === 1 ? tokenSources[0] : tokenSources.join("+"),
    summary,
    results
  };

  if (options.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  printText(snapshot);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
