import { memoryReadAccessSql, type MemoryReadAccess, type MemoryRecordedBy } from "@org-brain/shared";
import type { Env } from "./types";

export type MemoryRecording = { principal: string; client: string | null };
export const PRIVATE_MEMORY_CONFIRMATION_KEY_PREFIX = "private-confirmation:";

export async function loadMemoryRecordedBy(
  env: Env,
  tenantId: string,
  memoryIds: string[],
  access?: MemoryReadAccess
): Promise<Map<string, MemoryRecordedBy>> {
  // Publishing a memory across tenants does not publish the originating account profile.
  if (tenantId === "all" || !memoryIds.length) return new Map();
  const { results } = await env.OPEN_BRAIN_DB.prepare(
    `SELECT m.id,
            CASE WHEN instr(u.display_name, '@') = 0 AND u.display_name <> m.recording_principal
                 THEN nullif(trim(u.display_name), '') END AS name,
            m.recording_client AS client
     FROM memories m
     LEFT JOIN user_profiles u ON u.tenant_id = m.tenant_id AND u.principal = m.recording_principal
     WHERE m.tenant_id = ? AND m.id IN (${memoryIds.map(() => "?").join(",")})
       AND m.recording_principal IS NOT NULL AND ${memoryReadAccessSql("m", access)}`
  ).bind(tenantId, ...memoryIds).all<{ id: string } & MemoryRecordedBy>();
  return new Map(results.map(({ id, name, client }) => [id, { name, client }]));
}
