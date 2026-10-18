import { readFileSync } from "node:fs";
import { workingLlmCandidates } from "./working-llm-candidates.mjs";

export const LOCAL_RERANKER_MODEL = "Qwen/Qwen3-Reranker-0.6B";
export const LOCAL_RERANKER_SCORING = "memory-relevance-yes-no/v1";
export const LOCAL_RERANKER_INSTRUCTION_HASH = "74da2544e72fb2ef80f31edb1eee497aee6121eaf5c74b679fdc190ac890118e";

export function relevanceDocument(memory) {
  return [memory.summary, memory.rationale, memory.reuse_rule, memory.content]
    .filter(Boolean).join("\n").slice(0, 4000);
}

export class LocalRelevanceSelector {
  constructor(options = {}) {
    this.provider = "qwen3-reranker-mlx";
    const url = new URL(options.url || "http://127.0.0.1:11435");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("local_relevance_endpoint_must_be_loopback");
    this.url = url.origin;
    this.revision = String(options.revision || "");
    this.minimumScore = Number(options.minimum_score ?? 0.5);
    this.candidateLimit = Number(options.candidate_limit ?? 20);
    this.timeoutMs = Number(options.timeout_ms ?? 30_000);
    if (!/^[a-f0-9]{40}$/.test(this.revision) || !Number.isFinite(this.minimumScore) || this.minimumScore < 0 || this.minimumScore > 1
      || !Number.isInteger(this.candidateLimit) || this.candidateLimit < 1 || this.candidateLimit > 50
      || !Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new Error("local_relevance_settings_invalid");
  }

  async select(query, results) {
    const candidates = results.slice(0, this.candidateLimit);
    const metadata = {model:LOCAL_RERANKER_MODEL,revision:this.revision,scoring_version:LOCAL_RERANKER_SCORING,instruction_hash:LOCAL_RERANKER_INSTRUCTION_HASH,
      minimum_score:this.minimumScore,candidate_count:results.length,scored_count:0,kept_count:0,
      unscored_count:results.length-candidates.length,status:"complete"};
    if (!candidates.length) return {results:[],metadata};
    try {
      const response = await fetch(`${this.url}/rerank`, {method:"POST",redirect:"error",headers:{"content-type":"application/json"},
        signal:AbortSignal.timeout(this.timeoutMs),
        body:JSON.stringify({query:String(query).slice(0,2000),documents:candidates.map(({memory})=>({id:memory.id,text:relevanceDocument(memory)}))})});
      if (!response.ok) throw new Error("local_relevance_provider_http");
      const body = await response.json();
      if (body.model !== LOCAL_RERANKER_MODEL || body.revision !== this.revision || body.scoring_version !== LOCAL_RERANKER_SCORING
        || body.instruction_hash !== LOCAL_RERANKER_INSTRUCTION_HASH
        || !Array.isArray(body.scores) || body.scores.length !== candidates.length) throw new Error("local_relevance_invalid_response");
      const known = new Set(candidates.map(({memory})=>memory.id));
      const scores = new Map();
      for (const row of body.scores) {
        if (!known.has(row.id) || scores.has(row.id) || typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 1) throw new Error("local_relevance_invalid_score");
        scores.set(row.id,row.score);
      }
      const selected = candidates.map((row,index)=>({...row,relevance:{score:scores.get(row.memory.id)},original_index:index}))
        .filter((row)=>row.relevance.score >= this.minimumScore)
        .sort((a,b)=>b.relevance.score-a.relevance.score || a.original_index-b.original_index)
        .map(({original_index,...row})=>row);
      return {results:selected,metadata:{...metadata,scored_count:scores.size,kept_count:selected.length}};
    } catch {
      // An unavailable or invalid verifier must not silently inject the broad set.
      return {results:[],metadata:{...metadata,status:"unavailable",reason:"local_relevance_unavailable"}};
    }
  }
}

export function localRelevanceSelectorFromSettings(env = process.env, dbPath = null) {
  const override = env.ORGBRAIN_LOCAL_RELEVANCE_PROVIDER;
  if (override !== undefined && ["", "off"].includes(String(override).trim())) return null;
  let settings = null;
  if (dbPath) {
    try { settings = JSON.parse(readFileSync(`${dbPath}.retrieval.json`, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("local_relevance_settings_invalid",{cause:error}); }
    if (settings !== null && settings.version !== 1) throw new Error("local_relevance_settings_invalid");
  }
  const provider = override ?? settings?.provider ?? "working-llm";
  if (["", "off"].includes(provider)) return null;
  if (provider === "working-llm") return new WorkingLlmRelevanceSelector();
  if (provider !== "qwen3-reranker-mlx") throw new Error("local_relevance_unknown_provider");
  const options = {...settings};
  for (const [name,key] of Object.entries({URL:"url",REVISION:"revision",MINIMUM_SCORE:"minimum_score",CANDIDATE_LIMIT:"candidate_limit",TIMEOUT_MS:"timeout_ms"})) {
    const value = env[`ORGBRAIN_LOCAL_RELEVANCE_${name}`];
    if (value !== undefined) options[key] = value;
  }
  return new LocalRelevanceSelector(options);
}


export class WorkingLlmRelevanceSelector {
  constructor() { this.provider = "working-llm"; this.candidateLimit = 20; }
  async select(_query, results, context = {}) {
    return { results:[], candidates:workingLlmCandidates(results, results.length, context), metadata:{provider:this.provider,
      status:"pending_host_selection", candidate_count:results.length, returned_candidate_count:results.length,
      scored_count:0, kept_count:0} };
  }
}
