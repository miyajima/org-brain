#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import {
  COMPETITIVE_RANKED_ADAPTERS,
  COMPETITIVE_ACCEPTANCE_TARGETS,
  buildCompetitiveTasks,
  evaluateCompetitiveRanking,
  runCompetitiveBenchmark
} from "./lib/competitive-memory-benchmark-core.mjs";
import { LocalMemoryStore } from "../../orgbrain-cli/src/lib/local-memory-store.mjs";

const ADAPTER_ENV = {
  mem0: "MEM0_BENCHMARK_URL",
  hindsight: "HINDSIGHT_BENCHMARK_URL",
  mnemosyne: "MNEMOSYNE_BENCHMARK_URL"
};

const ADAPTER_REVISIONS = {
  mem0: "760dca6f391277d79c3c7d2096c1bf1d037526c3",
  hindsight: "a90f9223765af3c8ad5692ce2b9fa22efbb656ba",
  mnemosyne: "22c60e2af2335e05864dfc32b803d7bb6439ed62"
};

function parseArgs(argv) {
  const options = {
    adapters: ["orgbrain-local"],
    output: resolve("benchmark-results", "competitive-memory-latest.json"),
    db: resolve(".benchmark", "competitive-memory.sqlite"),
    repeat: 5,
    evidence: null,
    modelId: null,
    budgetUsd: null,
    hardwareId: null,
    json: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--adapter" || arg.startsWith("--adapter=")) {
      const value = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
      options.adapters = value === "all"
        ? [...COMPETITIVE_RANKED_ADAPTERS]
        : value.split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      options.output = resolve(arg.includes("=") ? arg.split("=", 2)[1] : argv[++index]);
    } else if (arg === "--db" || arg.startsWith("--db=")) {
      options.db = resolve(arg.includes("=") ? arg.split("=", 2)[1] : argv[++index]);
    } else if (arg === "--repeat" || arg.startsWith("--repeat=")) {
      options.repeat = Number(arg.includes("=") ? arg.split("=", 2)[1] : argv[++index]);
    } else if (arg === "--evidence" || arg.startsWith("--evidence=")) {
      options.evidence = resolve(arg.includes("=") ? arg.split("=", 2)[1] : argv[++index]);
    } else if (arg === "--model-id" || arg.startsWith("--model-id=")) {
      options.modelId = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else if (arg === "--budget-usd" || arg.startsWith("--budget-usd=")) {
      options.budgetUsd = Number(arg.includes("=") ? arg.split("=", 2)[1] : argv[++index]);
    } else if (arg === "--hardware-id" || arg.startsWith("--hardware-id=")) {
      options.hardwareId = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node packages/benchmarks/scripts/competitive-memory-benchmark.mjs [options]

Options:
  --adapter orgbrain-local|mem0|hindsight|mnemosyne|all
  --output <path>   Raw settings and results JSON
  --db <path>       Isolated OrgBrain local benchmark database
  --repeat <n>      Attempts used for pass^5 (default: 5)
  --evidence <path> Capability evidence JSON keyed by adapter
  --model-id <id>   Shared model identifier required for ranking
  --budget-usd <n>  Shared per-adapter budget required for ranking
  --hardware-id <id> Shared hardware identifier required for ranking
  --json            Print the full result

External adapters use <NAME>_BENCHMARK_URL and the benchmark bridge contract:
POST /reset, POST /capture, POST /search -> {results, usage}; optional
POST /capabilities returns evidence-backed personal and organization scores.
`);
      process.exit(0);
    }
  }
  return options;
}

class OrgBrainLocalAdapter {
  name = "orgbrain-local";

  constructor(path, capabilities = {}) {
    this.store = new LocalMemoryStore(path);
    this.capabilities = capabilities;
  }

  async describe() {
    return this.capabilities;
  }

  async reset() {
    await this.store.init();
    const db = this.store.open();
    try {
      db.exec(`
        DELETE FROM memories_fts;
        DELETE FROM memory_retrieval_units_fts;
        DELETE FROM memory_retrieval_units;
        DELETE FROM memory_retrieval_units_v4_fts;
        DELETE FROM memory_retrieval_units_v4;
        DELETE FROM memory_retrieval_unit_features_v4;
        DELETE FROM memory_retrieval_unit_feature_stats_v4;
        DELETE FROM memory_retrieval_unit_embeddings_v4;
        DELETE FROM memory_embedding_features;
        DELETE FROM memory_embedding_feature_stats;
        DELETE FROM memory_embeddings;
        DELETE FROM memory_edges;
        DELETE FROM memory_versions;
        DELETE FROM memory_deletions;
        DELETE FROM memories;
      `);
    } finally {
      db.close();
    }
  }

  async capture(record) {
    return this.store.capture(record);
  }

  async search(query) {
    return this.store.retrieveContext({
      ...query,
      search_mode: "hybrid_v4",
      top_k: 5,
      token_budget: 8_000
    });
  }
}

class HttpBenchmarkAdapter {
  constructor(name, baseUrl, capabilities = {}, harness = {}) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.capabilities = capabilities;
    this.harness = harness;
  }

  async request(path, body, { optional = false } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (optional && [404, 405, 501].includes(response.status)) return null;
    if (!response.ok) throw new Error(`${this.name} ${path} returned ${response.status}`);
    return response.json();
  }

  async describe() {
    if (Object.keys(this.capabilities).length > 0) return this.capabilities;
    return await this.request("/capabilities", { harness: this.harness }, { optional: true }) ?? {};
  }

  async reset() {
    await this.request("/reset", { harness: this.harness });
  }

  async capture(record) {
    return this.request("/capture", { record, harness: this.harness });
  }

  async search(query) {
    const response = await this.request("/search", { query, harness: this.harness });
    return response;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(options.repeat) || options.repeat < 1) {
    throw new Error("--repeat must be a positive number");
  }
  if (options.budgetUsd !== null && (!Number.isFinite(options.budgetUsd) || options.budgetUsd < 0)) {
    throw new Error("--budget-usd must be a non-negative number");
  }
  const evidenceDocument = options.evidence
    ? JSON.parse(await readFile(options.evidence, "utf8"))
    : {};
  const evidenceByAdapter = evidenceDocument.adapters ?? evidenceDocument;
  const harness = {
    model_id: options.modelId,
    budget_usd: options.budgetUsd,
    hardware_id: options.hardwareId
  };
  const tasks = buildCompetitiveTasks();
  const results = [];
  const unavailable = [];
  for (const name of options.adapters) {
    let adapter;
    if (name === "orgbrain-local") {
      adapter = new OrgBrainLocalAdapter(options.db, evidenceByAdapter[name] ?? {});
    } else if (ADAPTER_ENV[name]) {
      const url = process.env[ADAPTER_ENV[name]];
      if (!url) {
        unavailable.push({ adapter: name, reason: `${ADAPTER_ENV[name]} is not configured` });
        continue;
      }
      adapter = new HttpBenchmarkAdapter(name, url, evidenceByAdapter[name] ?? {}, harness);
    } else {
      throw new Error(`unknown adapter: ${name}`);
    }
    results.push(await runCompetitiveBenchmark(adapter, tasks, {
      repeat: options.repeat,
      harness
    }));
  }

  const ranking = evaluateCompetitiveRanking(results, unavailable, harness);
  const report = {
    benchmark: "competitive-memory-v1",
    comparison_scope: {
      ranked_adapters: COMPETITIVE_RANKED_ADAPTERS,
      adapter_revisions: ADAPTER_REVISIONS,
      revision_manifest: "config/competitive-memory-revisions-2026-07-31.json",
      claim: "same-harness leader among Mem0, Hindsight, and Mnemosyne",
      universal_oss_first_place_claim_allowed: false
    },
    generated_at: new Date().toISOString(),
    acceptance_targets: COMPETITIVE_ACCEPTANCE_TARGETS,
    harness,
    environment: {
      node: process.version,
      platform: platform(),
      os_release: release(),
      cpu_model: cpus()[0]?.model ?? "unknown",
      cpu_count: cpus().length,
      total_memory_bytes: totalmem(),
      free_memory_bytes: freemem()
    },
    dataset: {
      tasks: tasks.length,
      personal: tasks.filter((task) => task.mode === "personal").length,
      organization: tasks.filter((task) => task.mode === "organization").length,
      families: Object.fromEntries(
        [...new Set(tasks.map((task) => task.dataset_family))].map((family) => [
          family,
          tasks.filter((task) => task.dataset_family === family).length
        ])
      ),
      categories: Object.fromEntries(
        [...new Set(tasks.map((task) => task.category))].map((category) => [
          category,
          tasks.filter((task) => task.category === category).length
        ])
      )
    },
    unavailable,
    results,
    ranking
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(JSON.stringify({
      output: options.output,
      dataset: report.dataset,
      harness,
      unavailable,
      ranking,
      results: results.map((result) => ({
        adapter: result.adapter,
        metrics: result.metrics,
        personal: result.personal,
        organization: result.organization,
        scorecards: result.scorecards,
        ranking: result.ranking
      }))
    }, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
