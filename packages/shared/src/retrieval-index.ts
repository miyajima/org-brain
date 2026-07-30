export type RetrievalComponent =
  | "lexical"
  | "semantic"
  | "graph"
  | "time"
  | "authority"
  | "utility";

export type RetrievalWeights = Record<RetrievalComponent, number>;

export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = {
  lexical: 0.3,
  semantic: 0.3,
  graph: 0.15,
  time: 0.1,
  authority: 0.1,
  utility: 0.05
};

export type RetrievalIndexDocument = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  text: string;
  entities: string[];
  updated_at: number;
};

export type RetrievalIndexHit = {
  id: string;
  score: number;
};

export type RetrievalIndexQuery = {
  tenant_id: string;
  project_id?: string | null;
  query: string;
  limit: number;
};

/**
 * A rebuildable retrieval projection. Implementations may use Vectorize,
 * pgvector, sqlite-vec, or another backend without changing MemoryStore.
 */
export interface RetrievalIndex {
  readonly kind: "semantic" | "graph";
  readonly provider: string;
  available(): Promise<boolean>;
  upsert(documents: RetrievalIndexDocument[]): Promise<void>;
  remove(tenantId: string, ids: string[]): Promise<void>;
  query(input: RetrievalIndexQuery): Promise<RetrievalIndexHit[]>;
  rebuild(documents: AsyncIterable<RetrievalIndexDocument>): Promise<void>;
}

export type RetrievalSignal = {
  id: string;
  lexical?: number | null;
  semantic?: number | null;
  graph?: number | null;
  created_at: number;
  valid_from?: number | null;
  valid_until?: number | null;
  confidence?: number | null;
  utility?: number | null;
  authority?: number | null;
  allowed?: boolean;
};

export type RetrievalScoreBreakdown = {
  total: number;
  lexical: number | null;
  semantic: number | null;
  graph: number | null;
  time: number;
  authority: number;
  utility: number;
  active_components: RetrievalComponent[];
};

export type FusedRetrievalHit = {
  id: string;
  score: RetrievalScoreBreakdown;
};

export type RetrievalAvailability = {
  semantic: boolean;
  graph: boolean;
};

function clampScore(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function timeScore(createdAt: number, at: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, at - createdAt) / 86_400_000;
  return Math.pow(0.5, ageDays / Math.max(1, halfLifeDays));
}

function normalizedWeights(
  signal: RetrievalSignal,
  availability: RetrievalAvailability,
  weights: RetrievalWeights
): Array<[RetrievalComponent, number, number | null]> {
  const components: Array<[RetrievalComponent, number, number | null]> = [
    ["lexical", weights.lexical, clampScore(signal.lexical)],
    ["semantic", availability.semantic ? weights.semantic : 0, clampScore(signal.semantic)],
    ["graph", availability.graph ? weights.graph : 0, clampScore(signal.graph)],
    ["time", weights.time, null],
    ["authority", weights.authority, null],
    ["utility", weights.utility, null]
  ];
  const enabled = components.filter(([component, weight, value]) => {
    if (weight <= 0) return false;
    if (component === "semantic" || component === "graph" || component === "lexical") {
      return value !== null;
    }
    return true;
  });
  const totalWeight = enabled.reduce((sum, [, weight]) => sum + weight, 0);
  return enabled.map(([component, weight, value]) => [component, weight / totalWeight, value]);
}

/**
 * Deterministic fusion with validity and ACL filtering. Missing providers are
 * removed from the denominator; their scores stay null so degraded retrieval
 * is visible to callers rather than being presented as semantic search.
 */
export function fuseRetrievalSignals(
  signals: RetrievalSignal[],
  options: {
    at?: number;
    halfLifeDays?: number;
    availability?: Partial<RetrievalAvailability>;
    weights?: Partial<RetrievalWeights>;
  } = {}
): FusedRetrievalHit[] {
  const at = options.at ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? 30;
  const availability: RetrievalAvailability = {
    semantic: options.availability?.semantic ?? false,
    graph: options.availability?.graph ?? false
  };
  const weights: RetrievalWeights = { ...DEFAULT_RETRIEVAL_WEIGHTS, ...options.weights };

  return signals
    .filter(
      (signal) =>
        signal.allowed !== false &&
        (signal.valid_from === null || signal.valid_from === undefined || signal.valid_from <= at) &&
        (signal.valid_until === null || signal.valid_until === undefined || signal.valid_until > at)
    )
    .map((signal) => {
      const lexical = clampScore(signal.lexical);
      const semantic = availability.semantic ? clampScore(signal.semantic) : null;
      const graph = availability.graph ? clampScore(signal.graph) : null;
      const time = timeScore(signal.created_at, at, halfLifeDays);
      const confidence = clampScore(signal.confidence) ?? 0.5;
      const authority = (clampScore(signal.authority) ?? 0.5) * confidence;
      const utility = clampScore(signal.utility) ?? 0.5;
      const values: Record<RetrievalComponent, number | null> = {
        lexical,
        semantic,
        graph,
        time,
        authority,
        utility
      };
      const active = normalizedWeights(signal, availability, weights);
      const total = active.reduce(
        (sum, [component, weight]) => sum + (values[component] ?? 0) * weight,
        0
      );

      return {
        id: signal.id,
        score: {
          total: Number(total.toFixed(6)),
          lexical,
          semantic,
          graph,
          time: Number(time.toFixed(6)),
          authority: Number(authority.toFixed(6)),
          utility,
          active_components: active.map(([component]) => component)
        }
      };
    })
    .sort((left, right) => right.score.total - left.score.total || left.id.localeCompare(right.id));
}
