import type { Env } from "./types";

type RetrievalRolloutEnv = Pick<Env, "HYBRID_V3_MODE" | "HYBRID_V4_MODE" | "RETRIEVAL_PROJECTION_QUEUE">;

export function retrievalProjectionQueue(env: RetrievalRolloutEnv): Env["RETRIEVAL_PROJECTION_QUEUE"] | null {
  return (
    env.RETRIEVAL_PROJECTION_QUEUE &&
    (
      env.HYBRID_V3_MODE === "canary" ||
      env.HYBRID_V3_MODE === "on" ||
      env.HYBRID_V4_MODE === "canary" ||
      env.HYBRID_V4_MODE === "on"
    )
      ? env.RETRIEVAL_PROJECTION_QUEUE
      : null
  );
}

export function shouldEnqueueRetrievalProjection(env: RetrievalRolloutEnv): boolean {
  return retrievalProjectionQueue(env) !== null;
}
