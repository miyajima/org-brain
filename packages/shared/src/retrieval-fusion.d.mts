export type RetrievalFusionChannel = { name: string; weight?: number; hits: Array<{id: string; sourceId: string; score?: number}> };
export function boundedRetrievalFusion(channels: RetrievalFusionChannel[], options?: {constant?: number; perChannel?: number; candidateLimit?: number}): {scores: Map<string,number>; unitScores: Map<string,number>; candidateIds: string[]; protectedIds: string[]};
