import {
  buildRetrievalUnitsV4,
  type MemorySourceReference,
  type RetrievalUnitV4
} from "@org-brain/shared";
import type { Env } from "./types";

export const RETRIEVAL_V4_GEMINI_MODEL = "gemini-3.5-flash-lite";

type V4ExtractionRecord = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  created_at: number;
  updated_at: number;
  valid_from: number | null;
  valid_until: number | null;
  source_references: MemorySourceReference[];
};

type StructuredUnit = {
  text: string;
  speaker?: "user" | "assistant" | "system" | "tool" | "unknown" | null;
  unit_type?: "atomic" | "profile" | "ledger" | "timeline";
  event_at?: number | null;
  metadata: Record<string, unknown>;
};

export function parseGeminiV4Units(value: unknown): StructuredUnit[] {
  const rows =
    value && typeof value === "object" && Array.isArray((value as { units?: unknown }).units)
      ? (value as { units: unknown[] }).units
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text.trim().slice(0, 64 * 1024) : "";
    if (!text) return [];
    const unitType = ["atomic", "profile", "ledger", "timeline"].includes(String(item.unit_type))
      ? String(item.unit_type) as StructuredUnit["unit_type"]
      : "atomic";
    const speaker = ["user", "assistant", "system", "tool", "unknown"].includes(String(item.speaker))
      ? String(item.speaker) as StructuredUnit["speaker"]
      : null;
    const eventAt = typeof item.normalized_at === "number" && Number.isFinite(item.normalized_at)
      ? item.normalized_at
      : null;
    return [{
      text,
      speaker,
      unit_type: unitType,
      event_at: eventAt,
      metadata: {
        subject: typeof item.subject === "string" ? item.subject : "unknown",
        predicate: typeof item.predicate === "string" ? item.predicate : "mentions",
        object: typeof item.object === "string" ? item.object : text,
        polarity: item.polarity === "negative" ? "negative" : "positive",
        domain: typeof item.domain === "string" ? item.domain : "general",
        normalized_at: eventAt,
        facet_kind: typeof item.facet_kind === "string" ? item.facet_kind : null,
        state_key: typeof item.state_key === "string" ? item.state_key : null,
        supersedes_unit_id:
          typeof item.supersedes_unit_id === "string" ? item.supersedes_unit_id : null,
        starts_at: typeof item.starts_at === "number" ? item.starts_at : eventAt,
        ends_at: typeof item.ends_at === "number" ? item.ends_at : null,
        causes: Array.isArray(item.causes) ? item.causes.slice(0, 16) : [],
        follows: Array.isArray(item.follows) ? item.follows.slice(0, 16) : []
      }
    }];
  }).slice(0, 256);
}

async function geminiStructuredUnits(env: Env, record: V4ExtractionRecord): Promise<StructuredUnit[] | null> {
  if (!env.GEMINI_API_KEY) return null;
  const model = env.RETRIEVAL_V4_EXTRACTOR_MODEL?.trim() || RETRIEVAL_V4_GEMINI_MODEL;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [{
            text: [
              "Extract generic memory units from the supplied text.",
              "Return atomic subject/predicate/object/polarity/domain/time facts,",
              "profile facets, state updates with supersedes, and timeline events.",
              "Do not answer questions and do not infer benchmark labels.",
              JSON.stringify({ summary: record.summary, content: record.content.slice(0, 64 * 1024) })
            ].join("\n")
          }]
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              units: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    text: { type: "STRING" },
                    speaker: { type: "STRING" },
                    unit_type: { type: "STRING" },
                    subject: { type: "STRING" },
                    predicate: { type: "STRING" },
                    object: { type: "STRING" },
                    polarity: { type: "STRING" },
                    domain: { type: "STRING" },
                    normalized_at: { type: "NUMBER" },
                    facet_kind: { type: "STRING" },
                    state_key: { type: "STRING" },
                    supersedes_unit_id: { type: "STRING" },
                    starts_at: { type: "NUMBER" },
                    ends_at: { type: "NUMBER" },
                    causes: { type: "ARRAY", items: { type: "STRING" } },
                    follows: { type: "ARRAY", items: { type: "STRING" } }
                  },
                  required: ["text", "unit_type", "subject", "predicate", "object", "polarity", "domain"]
                }
              }
            },
            required: ["units"]
          }
        }
      })
    }
  );
  if (!response.ok) throw new Error(`Gemini v4 extraction returned ${response.status}`);
  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini v4 extraction returned no JSON");
  return parseGeminiV4Units(JSON.parse(text));
}

export async function extractRetrievalUnitsV4(
  env: Env,
  record: V4ExtractionRecord
): Promise<RetrievalUnitV4[]> {
  try {
    const structuredUnits = await geminiStructuredUnits(env, record);
    return await buildRetrievalUnitsV4(
      record,
      structuredUnits && structuredUnits.length > 0 ? { structuredUnits } : {}
    );
  } catch {
    return await buildRetrievalUnitsV4(record);
  }
}
