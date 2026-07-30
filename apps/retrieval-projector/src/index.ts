import type { RetrievalProjectionJob } from "@org-brain/shared";

const EXTRACTION_MODEL = "gemini-3.5-flash-lite";
const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b" as const;
const ATOMIC_TYPES = new Set(["fact", "update", "preference", "event", "quantity"]);

type Env = {
  OPEN_BRAIN_DB: D1Database;
  MEMORY_VECTOR_INDEX_V3: Vectorize;
  AI: Ai;
  GEMINI_API_KEY?: string;
};

type StoredMemory = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  source_refs_json: string | null;
  created_at: number;
  updated_at: number | null;
  valid_from: number | null;
  valid_until: number | null;
  content_hash: string;
  lifecycle_state: string | null;
};

type ExtractedAtomicUnit = {
  type: string;
  text: string;
  speaker?: string | null;
  event_at?: string | null;
};

type ExtractionPayload = {
  synopsis: string;
  atoms: ExtractedAtomicUnit[];
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseExtractionResponse(value: unknown): ExtractionPayload {
  const root = asObject(value);
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  const candidate = asObject(candidates[0]);
  const content = asObject(candidate?.content);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const part = asObject(parts[0]);
  if (typeof part?.text !== "string") throw new Error("Gemini returned no structured extraction");
  const parsed = JSON.parse(part.text) as unknown;
  const payload = asObject(parsed);
  if (!payload) throw new Error("Gemini extraction was not an object");
  return {
    synopsis: typeof payload.synopsis === "string" ? payload.synopsis.trim().slice(0, 4_000) : "",
    atoms: (Array.isArray(payload.atoms) ? payload.atoms : [])
      .flatMap<ExtractedAtomicUnit>((value) => {
        const atom = asObject(value);
        if (!atom || typeof atom.text !== "string" || typeof atom.type !== "string") return [];
        return [{
          type: atom.type,
          text: atom.text.trim().slice(0, 8_000),
          speaker: typeof atom.speaker === "string" ? atom.speaker : null,
          event_at: typeof atom.event_at === "string" ? atom.event_at : null
        }];
      })
      .filter((atom) => ATOMIC_TYPES.has(atom.type) && atom.text.length >= 2)
      .slice(0, 64)
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function extract(memory: StoredMemory, apiKey: string): Promise<ExtractionPayload> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACTION_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: [
              "Extract only explicit durable facts from this session.",
              "Do not infer missing values. Preserve updates, preferences, events, quantities, dates, and speaker.",
              "Return a short neutral synopsis plus atomic statements.",
              "<session>",
              memory.content.slice(0, 60_000),
              "</session>"
            ].join("\n")
          }]
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseJsonSchema: {
            type: "object",
            required: ["synopsis", "atoms"],
            properties: {
              synopsis: { type: "string" },
              atoms: {
                type: "array",
                items: {
                  type: "object",
                  required: ["type", "text"],
                  properties: {
                    type: {
                      type: "string",
                      enum: ["fact", "update", "preference", "event", "quantity"]
                    },
                    text: { type: "string" },
                    speaker: {
                      type: ["string", "null"],
                      enum: ["user", "assistant", "system", "tool", "unknown", null]
                    },
                    event_at: { type: ["string", "null"] }
                  }
                }
              }
            }
          }
        }
      })
    }
  );
  if (!response.ok) throw new Error(`Gemini extraction failed: HTTP ${response.status}`);
  return parseExtractionResponse(await response.json());
}

function eventTimestamp(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function embedMany(texts: string[], env: Env): Promise<number[][]> {
  const output = await env.AI.run(EMBEDDING_MODEL, {
    text: texts.map((text) => text.slice(0, 4_000))
  });
  const data = (output as unknown as { data?: unknown }).data;
  if (!Array.isArray(data) || data.some((vector) => !Array.isArray(vector))) {
    throw new Error("embedding returned no vectors");
  }
  return data.map((vector) => (vector as unknown[]).map(Number));
}

async function project(job: RetrievalProjectionJob, env: Env): Promise<void> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const row = await env.OPEN_BRAIN_DB.prepare(
    `SELECT id, tenant_id, project_id, content, summary, source_refs_json,
            created_at, updated_at, valid_from, valid_until, content_hash, lifecycle_state
     FROM memories WHERE tenant_id = ? AND id = ?`
  ).bind(job.tenant_id, job.memory_id).first<StoredMemory>();
  if (!row || row.content_hash !== job.content_hash || row.lifecycle_state === "suppressed") return;
  const extraction = await extract(row, env.GEMINI_API_KEY);
  const candidates: Array<ExtractedAtomicUnit & { type: string }> = [
    ...(extraction.synopsis ? [{ type: "synopsis", text: extraction.synopsis, speaker: null, event_at: null }] : []),
    ...extraction.atoms
  ];
  const units = [];
  for (const [index, candidate] of candidates.entries()) {
    const contentHash = await sha256(candidate.text);
    const idHash = await sha256(`${row.id}\0${candidate.type}\0${index}\0${candidate.text}`);
    units.push({
      id: `ru_${idHash.slice(0, 28)}`,
      memory_id: row.id,
      tenant_id: row.tenant_id,
      project_id: row.project_id,
      unit_type: candidate.type,
      speaker: candidate.speaker ?? null,
      text: candidate.text,
      event_at: eventTimestamp(candidate.event_at, row.valid_from ?? row.created_at),
      valid_from: row.valid_from,
      valid_until: row.valid_until,
      source_ref_json: JSON.stringify(JSON.parse(row.source_refs_json || "[]")[0] ?? null),
      content_hash: contentHash,
      created_at: row.updated_at ?? row.created_at
    });
  }
  const statements: D1PreparedStatement[] = [
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM memory_retrieval_units_fts
       WHERE tenant_id = ? AND memory_id = ? AND unit_id IN (
         SELECT id FROM memory_retrieval_units
         WHERE tenant_id = ? AND memory_id = ?
           AND unit_type IN ('synopsis','fact','update','preference','event','quantity')
       )`
    ).bind(row.tenant_id, row.id, row.tenant_id, row.id),
    env.OPEN_BRAIN_DB.prepare(
      `DELETE FROM memory_retrieval_units
       WHERE tenant_id = ? AND memory_id = ?
         AND unit_type IN ('synopsis','fact','update','preference','event','quantity')`
    ).bind(row.tenant_id, row.id),
    env.OPEN_BRAIN_DB.prepare(
      `UPDATE memory_retrieval_units
       SET extraction_state = 'ready', degraded_reason = NULL
       WHERE tenant_id = ? AND memory_id = ?`
    ).bind(row.tenant_id, row.id)
  ];
  for (const unit of units) {
    statements.push(
      env.OPEN_BRAIN_DB.prepare(
        `INSERT INTO memory_retrieval_units(
          id, memory_id, tenant_id, project_id, unit_type, speaker, text,
          event_at, valid_from, valid_until, source_ref_json, source_span_start,
          source_span_end, content_hash, extractor, extractor_version,
          extraction_state, degraded_reason, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        unit.id, unit.memory_id, unit.tenant_id, unit.project_id, unit.unit_type,
        unit.speaker, unit.text, unit.event_at, unit.valid_from, unit.valid_until,
        unit.source_ref_json, null, null, unit.content_hash,
        EXTRACTION_MODEL, "1", "ready", null, unit.created_at
      ),
      env.OPEN_BRAIN_DB.prepare(
        "INSERT INTO memory_retrieval_units_fts(unit_id, memory_id, tenant_id, text) VALUES(?,?,?,?)"
      ).bind(unit.id, unit.memory_id, unit.tenant_id, unit.text)
    );
  }
  await env.OPEN_BRAIN_DB.batch(statements);
  const values = units.length > 0 ? await embedMany(units.map((unit) => unit.text), env) : [];
  const vectors = units.map((unit, index) => ({
    id: unit.id,
    namespace: unit.tenant_id,
    values: values[index],
    metadata: {
      tenant_id: unit.tenant_id,
      project_id: unit.project_id ?? "",
      memory_id: unit.memory_id,
      unit_type: unit.unit_type,
      speaker: unit.speaker ?? "",
      updated_at: unit.created_at
    }
  }));
  if (vectors.length > 0) await env.MEMORY_VECTOR_INDEX_V3.upsert(vectors);
}

export default {
  async queue(batch: MessageBatch<RetrievalProjectionJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await project(message.body, env);
        message.ack();
      } catch {
        message.retry();
      }
    }
  }
};
