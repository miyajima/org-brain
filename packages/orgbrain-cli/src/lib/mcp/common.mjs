import { loadWorkspaceConfig, resolveWorkspaceMapping, workspacesFileFromEnv } from "../workspace-config.mjs";
export async function canonicalLocalProjectId(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const requested = value.trim();
  const config = await loadWorkspaceConfig(workspacesFileFromEnv());
  const ids = [...new Set(Object.values(config.workspaces ?? {}).map((entry) => entry?.project_id).filter(Boolean))];
  if (ids.includes(requested)) return requested;
  if (requested.startsWith("/")) {
    const mapped = await resolveWorkspaceMapping(config, requested);
    if (mapped.entry?.project_id) return mapped.entry.project_id;
  }
  const matches = ids.filter((id) => id.toLocaleLowerCase() === requested.toLocaleLowerCase());
  return matches.length === 1 ? matches[0] : requested;
}

export function boundedString(value, limit, fallback = null) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, limit) : fallback;
}

