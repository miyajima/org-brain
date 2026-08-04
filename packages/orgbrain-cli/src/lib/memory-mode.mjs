const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

export function parseBooleanFlag(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return false;
}

export function resolveMemoryMode(env = process.env) {
  const cloudMemoryEnabled = parseBooleanFlag(env.ORGBRAIN_ENABLE_CLOUD_MEMORY);
  const orgSharingEnabled = parseBooleanFlag(env.ORGBRAIN_ENABLE_ORG_SHARING);
  const scope = !cloudMemoryEnabled ? "local" : orgSharingEnabled ? "organization" : "personal_cloud";
  const configurationError =
    orgSharingEnabled && !cloudMemoryEnabled
      ? "ORGBRAIN_ENABLE_ORG_SHARING requires ORGBRAIN_ENABLE_CLOUD_MEMORY"
      : "";

  return {
    cloudMemoryEnabled,
    orgSharingEnabled,
    scope,
    cloudWritesAllowed: cloudMemoryEnabled && !configurationError,
    sharedWrite: cloudMemoryEnabled && orgSharingEnabled && !configurationError,
    configurationError
  };
}

export function memoryModeFields(mode) {
  return {
    memory_scope: mode.scope,
    cloud_memory_enabled: mode.cloudMemoryEnabled,
    org_sharing_enabled: mode.orgSharingEnabled,
    shared_write: mode.sharedWrite
  };
}
