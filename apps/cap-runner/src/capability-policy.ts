export type CapabilityPolicy = {
  maxConcurrency: number;
  costLimitMs: number;
};

export async function loadCapabilityPolicy(
  db: D1Database,
  tenantId: string,
  capability: string
): Promise<CapabilityPolicy> {
  const row = await db.prepare(
    "SELECT max_concurrency, cost_limit_ms FROM capabilities WHERE tenant_id = ? AND name = ?"
  )
    .bind(tenantId, capability)
    .first<{ max_concurrency?: number; cost_limit_ms?: number }>();
  return {
    maxConcurrency: Math.max(1, Number(row?.max_concurrency ?? 2)),
    costLimitMs: Math.max(0, Number(row?.cost_limit_ms ?? 0))
  };
}

export function assertWithinCapabilityCostLimit(
  durationMs: number,
  costLimitMs: number
): void {
  if (costLimitMs > 0 && durationMs > costLimitMs) {
    throw new Error(`capability cost ceiling exceeded: ${durationMs}ms > ${costLimitMs}ms`);
  }
}
