import { describe, expect, it } from "vitest";
import {
  RETENTION_SWEEP_LIMITS,
  decideRetentionQueueAction,
  retentionFailureStatus
} from "../src/retention-queue-service";
import {
  effectiveRetentionPolicy,
  isRetentionEligible,
  type RetentionPolicy
} from "../src/retention-service";
import {
  alertStatusForObservationCount,
  runOpsWatchdog,
  shouldNotifyAlert
} from "../src/ops-watchdog-service";

const tenantPolicy: RetentionPolicy = {
  id: "tenant-policy",
  tenant_id: "default",
  project_id: null,
  retention_days: 30,
  legal_hold: 0,
  updated_by_principal: "admin",
  created_at: 1,
  updated_at: 1
};

describe("retention operations", () => {
  it("uses project policy precedence and blocks every scope under a tenant legal hold", () => {
    const projectPolicy = { ...tenantPolicy, id: "project-policy", project_id: "project-a", retention_days: 7 };
    expect(effectiveRetentionPolicy([tenantPolicy, projectPolicy], "project-a")?.id).toBe("project-policy");
    expect(effectiveRetentionPolicy([tenantPolicy, projectPolicy], "project-b")?.id).toBe("tenant-policy");
    expect(isRetentionEligible(projectPolicy, 0, 31 * 86_400_000, tenantPolicy)).toBe(true);
    expect(isRetentionEligible({ ...projectPolicy, retention_days: 60 }, 0, 31 * 86_400_000, tenantPolicy)).toBe(false);
    expect(isRetentionEligible(projectPolicy, 0, 31 * 86_400_000, { ...tenantPolicy, legal_hold: 1 })).toBe(false);
  });

  it("waits through the grace period and requires an unchanged suppressed version", () => {
    const row = { suppressed_version: 4, delete_after: 8 * 86_400_000 };
    expect(decideRetentionQueueAction(row, { current_version: 4 }, true, 7 * 86_400_000)).toBe("wait");
    expect(decideRetentionQueueAction(row, { current_version: 5 }, true, 9 * 86_400_000)).toBe("manual_review");
    expect(decideRetentionQueueAction(row, { current_version: 4 }, true, 9 * 86_400_000)).toBe("delete");
    expect(decideRetentionQueueAction(row, { current_version: 4 }, false, 9 * 86_400_000)).toBe("cancel");
    expect(decideRetentionQueueAction({ ...row, suppressed_version: null }, { current_version: 4 }, true, 9 * 86_400_000)).toBe("prepare");
  });

  it("moves the fifth failed attempt to manual review and keeps global limits bounded", () => {
    expect(retentionFailureStatus(3)).toBe("failed");
    expect(retentionFailureStatus(4)).toBe("manual_review");
    expect(RETENTION_SWEEP_LIMITS).toMatchObject({ discovery: 500, deletion: 100, maxFailures: 5 });
    expect(RETENTION_SWEEP_LIMITS.gracePeriodMs).toBe(7 * 86_400_000);
  });

  it("notifies on first fire, fingerprint changes, and the six-hour reminder", () => {
    const sixHours = 6 * 60 * 60_000;
    expect(shouldNotifyAlert(null, null, "a", null, 1_000)).toBe(true);
    expect(shouldNotifyAlert("firing", "a", "a", 1_000, 1_000 + sixHours - 1)).toBe(false);
    expect(shouldNotifyAlert("firing", "a", "b", 1_000, 2_000)).toBe(true);
    expect(shouldNotifyAlert("firing", "a", "a", 1_000, 1_000 + sixHours)).toBe(true);
  });

  it("requires two consecutive observations for warnings", () => {
    expect(alertStatusForObservationCount(1, 2)).toBe("pending");
    expect(alertStatusForObservationCount(2, 2)).toBe("firing");
    expect(alertStatusForObservationCount(1, 1)).toBe("firing");
  });

  it("does not mark a notification as sent when the webhook is not 2xx", async () => {
    const executedSql: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() {
            executedSql.push(sql);
            return { success: true, meta: { changes: 1 } };
          }
        };
      }
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("no", { status: 503 });
    try {
      await expect(runOpsWatchdog({
        OPEN_BRAIN_DB: db,
        OPS_ALERT_WEBHOOK_URL: "https://alerts.example.test"
      } as any, 1_000)).rejects.toThrow("HTTP 503");
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(executedSql.some((sql) => sql.includes("SET last_notified_at"))).toBe(false);
  });
});
