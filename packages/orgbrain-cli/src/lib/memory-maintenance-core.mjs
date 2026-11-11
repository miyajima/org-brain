import { planMemoryMaintenanceCore } from "../../../shared/src/memory-maintenance-runtime.mjs";

/**
 * Local/operator entry point. The planning policy lives in the shared runtime so
 * the cloud runner and the CLI cannot drift; this wrapper only fixes the option
 * names consumed by scripts/memory-maintenance.mjs and personal-maintenance.mjs.
 */
export function planMemoryMaintenance(rows, options = {}) {
  return planMemoryMaintenanceCore(rows, {
    tenantId: options.tenantId,
    now: options.now,
    digestOlderThanDays: options.digestOlderThanDays,
    duplicateOlderThanDays: options.duplicateOlderThanDays,
    digestGroupMin: options.digestGroupMin
  });
}
