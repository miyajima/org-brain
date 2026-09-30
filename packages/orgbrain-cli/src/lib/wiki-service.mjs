import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rmdir,
  lstat,
  rm,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { countContextTokens } from "./compact-memory-context.mjs";
import { OllamaEmbeddingProvider } from "./local-dense-embedding.mjs";

export const DEFAULT_FEATURES_FILE = join(
  homedir(),
  ".org-brain",
  "features.json",
);
export const DEFAULT_WIKI_ROOT = join(
  homedir(),
  ".org-brain",
  "wiki",
  "personal",
);
const sourceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function settings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_feature_config");
  const wiki = value.features?.llm_wiki;
  if (
    wiki &&
    (typeof wiki !== "object" ||
      typeof wiki.enabled !== "boolean" ||
      !Number.isSafeInteger(wiki.epoch) ||
      wiki.epoch < 0)
  )
    throw new Error("invalid_feature_config");
  return {
    enabled: wiki?.enabled ?? false,
    epoch: wiki?.epoch ?? 0,
    auto_maintenance: wiki?.auto_maintenance === true,
  };
}
export function wikiStatusSync(
  config = process.env.ORGBRAIN_FEATURES_FILE || DEFAULT_FEATURES_FILE,
) {
  if (!existsSync(config)) return settings({});
  if (readFileSync(config).length > 65536)
    throw new Error("invalid_feature_config");
  try {
    return settings(JSON.parse(readFileSync(config, "utf8")));
  } catch (error) {
    throw new Error("invalid_feature_config", { cause: error });
  }
}
export async function wikiStatus(
  config = process.env.ORGBRAIN_FEATURES_FILE || DEFAULT_FEATURES_FILE,
) {
  try {
    const text = await readFile(config, "utf8");
    if (text.length > 65536) throw new Error("invalid_feature_config");
    return settings(JSON.parse(text));
  } catch (error) {
    if (error.code === "ENOENT") return settings({});
    throw new Error("invalid_feature_config", { cause: error });
  }
}
async function rejectSymlink(path) {
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("symlink_rejected");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
export async function setWikiFeature(
  config,
  enabled,
  { autoMaintenance } = {},
) {
  if (typeof enabled !== "boolean") throw new Error("invalid_feature_config");
  if (autoMaintenance !== undefined && typeof autoMaintenance !== "boolean")
    throw new Error("invalid_feature_config");
  config = resolve(config);
  await rejectSymlink(config);
  await mkdir(dirname(config), { recursive: true, mode: 0o700 });
  const lock = `${config}.lock`;
  let acquired = false;
  for (let n = 0; n < 500; n++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  if (!acquired) throw new Error("wiki_busy");
  const temporary = `${config}.${randomUUID()}.tmp`;
  try {
    let value = {};
    try {
      value = JSON.parse(await readFile(config, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new Error("invalid_feature_config", { cause: error });
    }
    const before = settings(value);
    value.features = {
      ...value.features,
      llm_wiki: {
        ...value.features?.llm_wiki,
        enabled,
        epoch: before.epoch + 1,
        auto_maintenance: autoMaintenance ?? before.auto_maintenance,
      },
    };
    await writeFile(temporary, JSON.stringify(value, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, config);
    return settings(value);
  } finally {
    await rm(temporary, { force: true });
    await rmdir(lock);
  }
}

function engineBinary() {
  if (process.env.ORGBRAIN_WIKI_ENGINE)
    return resolve(process.env.ORGBRAIN_WIKI_ENGINE);
  const executable =
    process.platform === "win32"
      ? "orgbrain-wiki-engine.exe"
      : "orgbrain-wiki-engine";
  const candidates = [
    fileURLToPath(
      new URL(
        `../bin/${process.platform}-${process.arch}/${executable}`,
        import.meta.url,
      ),
    ),
    fileURLToPath(
      new URL(
        `../../bin/${process.platform}-${process.arch}/${executable}`,
        import.meta.url,
      ),
    ),
    join(sourceRoot, "packages/wiki-engine/target/release", executable),
    join(sourceRoot, "packages/wiki-engine/target/debug", executable),
  ];
  const binary = candidates.find(existsSync);
  if (!binary)
    throw new Error(
      "wiki_engine_unavailable: install the matching OrgBrain native package or run build:wiki",
    );
  return binary;
}
export class WikiService {
  constructor(options = {}) {
    this.config = resolve(
      options.config ||
        process.env.ORGBRAIN_FEATURES_FILE ||
        DEFAULT_FEATURES_FILE,
    );
    this.root = resolve(
      options.root || process.env.ORGBRAIN_WIKI_ROOT || DEFAULT_WIKI_ROOT,
    );
    this.binary = options.binary;
  }
  async request(input, epoch = null) {
    const status = await wikiStatus(this.config);
    if (!status.enabled) throw new Error("feature_disabled");
    if (epoch !== null && epoch !== status.epoch)
      throw new Error("wiki_operation_cancelled");
    const binary = this.binary || engineBinary();
    const result = await new Promise((resolveResult, reject) => {
      const child = spawn(
        binary,
        [this.root, this.config, String(epoch ?? status.epoch)],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "",
        stderr = "",
        finished = false;
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            "wiki_engine_timeout: inspect state before retrying a write",
          ),
        );
      }, 120_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.on("data", (data) => {
        stdout += data;
        if (stdout.length > 20_000_000) {
          child.kill();
          reject(new Error("wiki_response_too_large"));
        }
      });
      child.stderr.on("data", (data) => {
        stderr = (stderr + data).slice(-4000);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (finished) return;
        finished = true;
        try {
          const value = JSON.parse(stdout);
          if (value.error) reject(new Error(value.error));
          else if (code !== 0)
            reject(new Error(stderr || "wiki_engine_failed"));
          else resolveResult(value);
        } catch (error) {
          reject(
            new Error(stderr || "wiki_engine_invalid_response", {
              cause: error,
            }),
          );
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input));
    });
    return result;
  }
  async search(input) {
    const status = await wikiStatus(this.config);
    if (!status.enabled) throw new Error("feature_disabled");
    const mode = input.mode || "lexical";
    if (!["lexical", "literal", "hybrid"].includes(mode))
      throw new Error("invalid_search_mode");
    let vector = null,
      model = null,
      fallback = null;
    if (mode === "hybrid") {
      try {
        const provider = this.embeddingProvider();
        if (!provider) throw new Error("embedding_not_configured");
        model = await this.modelKey(provider);
        const current = await wikiStatus(this.config);
        if (!current.enabled) throw new Error("feature_disabled");
        if (current.epoch !== status.epoch)
          throw new Error("wiki_operation_cancelled");
        vector = await provider.embedQuery(input.query);
        if (model !== (await this.modelKey(provider)))
          throw new Error("embedding_model_changed");
      } catch (error) {
        fallback = error.message;
      }
    }
    const result = await this.request(
      { ...input, op: "search", mode, vector, model },
      status.epoch,
    );
    const budget = Math.max(
      128,
      Math.min(16000, Number(input.token_budget) || 4000),
    );
    const output = {
      ...result,
      fallback: fallback || result.fallback || null,
      hits: [],
      estimated_tokens: 0,
      tokenizer: "o200k_base",
    };
    for (const hit of result.hits) {
      output.hits.push(hit);
      if (countWikiTokens(output) > budget - 16) {
        output.hits.pop();
        break;
      }
    }
    output.truncated =
      result.truncated || output.hits.length !== result.hits.length;
    for (let n = 0; n < 4; n++)
      output.estimated_tokens = countWikiTokens(output);
    return output;
  }
  embeddingProvider() {
    if (process.env.ORGBRAIN_WIKI_EMBEDDING_PROVIDER !== "qwen-ollama")
      return null;
    const provider = new OllamaEmbeddingProvider({
      endpoint: process.env.ORGBRAIN_LOCAL_EMBEDDING_URL,
      model: process.env.ORGBRAIN_LOCAL_EMBEDDING_MODEL,
      dimensions: process.env.ORGBRAIN_LOCAL_EMBEDDING_DIMENSIONS,
    });
    provider.embedQuery = async (text) =>
      (
        await provider.embedDocuments([
          `Instruct: Retrieve source-backed wiki passages relevant to the question.\nQuery: ${text}`,
        ])
      )[0];
    return provider;
  }
  async modelKey(provider) {
    let revision = process.env.ORGBRAIN_WIKI_EMBEDDING_REVISION;
    if (!revision) {
      const response = await fetch(`${provider.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("embedding_model_unavailable");
      const models = (await response.json()).models;
      revision = models?.find(
        (m) =>
          m.name === provider.model ||
          m.name === `${provider.model}:latest` ||
          m.model === provider.model,
      )?.digest;
      if (typeof revision !== "string" || !revision)
        throw new Error("embedding_model_digest_unavailable");
    }
    return createHash("sha256")
      .update(
        JSON.stringify({
          provider: provider.provider,
          dimensions: provider.dimensions,
          revision,
          instruction: "wiki-v1",
        }),
      )
      .digest("hex");
  }
  async reindexEmbeddings() {
    const status = await wikiStatus(this.config);
    if (!status.enabled) throw new Error("feature_disabled");
    const provider = this.embeddingProvider();
    if (!provider) throw new Error("embedding_not_configured");
    const model = await this.modelKey(provider);
    let indexed = 0;
    while (true) {
      const { chunks: batch } = await this.request(
        { op: "embedding_pending", model, limit: 8 },
        status.epoch,
      );
      if (!batch.length) break;
      const current = await wikiStatus(this.config);
      if (!current.enabled) throw new Error("feature_disabled");
      if (current.epoch !== status.epoch)
        throw new Error("wiki_operation_cancelled");
      const vectors = await provider.embedDocuments(
        batch.map((c) => c.embedding_text),
      );
      if (model !== (await this.modelKey(provider)))
        throw new Error("embedding_model_changed");
      await this.request(
        {
          op: "embedding_put",
          model,
          items: batch.map((c, i) => ({ hash: c.hash, vector: vectors[i] })),
        },
        status.epoch,
      );
      indexed += batch.length;
    }
    return { indexed, model };
  }
}

export function countWikiTokens(value) {
  return countContextTokens(value);
}

export function wikiServiceForStore(store) {
  return new WikiService({
    root:
      process.env.ORGBRAIN_WIKI_ROOT ||
      join(dirname(store.dbPath), "wiki", "personal"),
  });
}
