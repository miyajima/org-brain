import { describe, expect, it } from "vitest";
import type { RecallProfileV1 } from "@org-brain/contracts";
import { rankDomainRecallCandidates, selectDomainRecallCandidates, type DomainRecallRankingCandidate } from "../src/domain-recall";

const profile = (overrides: Partial<RecallProfileV1> = {}): RecallProfileV1 => ({
  intent_aliases: ["CI改善", "timeout"],
  object_type_keys: ["repository", "service"],
  primary_metric_keys: ["build_duration_p95"],
  guardrail_metric_keys: ["build_success_rate"],
  risk_mode: "standard",
  auto_recall_threshold: 0.6,
  required_scope_keys: [],
  ...overrides
});

const candidate = (overrides: Partial<DomainRecallRankingCandidate> = {}): DomainRecallRankingCandidate => ({
  id: "unit-build",
  tenant_id: "tenant-a",
  project_id: "checkout",
  object_type_key: "repository",
  object_id: "checkout-web",
  intent_aliases: ["test削除"],
  scope: { repository: "checkout-web", pipeline: "ci-main" },
  relation: "primary",
  has_decision_link: true,
  decision_state: "confirmed",
  evidence_verified: true,
  metric_fresh: true,
  acl_allowed: true,
  ...overrides
});

describe("Domain Recall ranking", () => {
  it("recalls a same-object decision and rejects the wrong repository before scoring", () => {
    const query = { tenant_id: "tenant-a", project_id: "checkout", prompt: "CI改善でtest削除を検討", object_type_key: "repository", object_id: "checkout-web", scope: { repository: "checkout-web", pipeline: "ci-main" } };
    expect(rankDomainRecallCandidates(profile(), query, [candidate()])[0]?.score.total).toBe(1);
    expect(rankDomainRecallCandidates(profile(), { ...query, object_id: "billing-worker" }, [candidate()])).toEqual([]);
  });

  it("requires exact service and dependency scope in high assurance mode", () => {
    const sre = profile({ risk_mode: "high_assurance", auto_recall_threshold: 0.72, required_scope_keys: ["service", "dependency"] });
    const query = { tenant_id: "tenant-a", prompt: "timeoutを延長したい", object_type_key: "service", object_id: "payments-api", scope: { service: "payments-api", dependency: "fraud-provider" } };
    const item = candidate({ id: "unit-sre", project_id: null, object_type_key: "service", object_id: "payments-api", scope: query.scope });
    expect(rankDomainRecallCandidates(sre, query, [item])).toHaveLength(1);
    expect(rankDomainRecallCandidates(sre, { ...query, scope: { ...query.scope, dependency: "search" } }, [item])).toEqual([]);
  });

  it("honors explicit required scope keys in standard mode", () => {
    const sales = profile({ object_type_keys: ["segment"], required_scope_keys: ["segment", "team", "quarter"] });
    const item = candidate({ object_type_key: "segment", object_id: "mid-market-jp", scope: { segment: "mid-market-jp", team: "sdr-tokyo", quarter: "FY26-Q3" } });
    const query = { tenant_id: "tenant-a", project_id: "checkout", prompt: "増員", object_type_key: "segment", object_id: "mid-market-jp", scope: { segment: "mid-market-jp", team: "sdr-tokyo", quarter: "FY26-Q3" } };
    expect(rankDomainRecallCandidates(sales, query, [item])).toHaveLength(1);
    expect(rankDomainRecallCandidates(sales, { ...query, scope: { segment: "mid-market-jp", team: "sdr-tokyo" } }, [item])).toEqual([]);
  });

  it("filters ACL and personal suppressions before score and retains visible conflicts", () => {
    const query = { tenant_id: "tenant-a", project_id: "checkout", prompt: "CI改善", object_type_key: "repository", object_id: "checkout-web", scope: { repository: "checkout-web", pipeline: "ci-main" } };
    const selected = selectDomainRecallCandidates(profile(), query, [
      candidate(),
      candidate({ id: "conflict", relation: "conflict", decision_state: "conflict" }),
      candidate({ id: "forbidden", acl_allowed: false }),
      candidate({ id: "dismissed", personally_suppressed: true })
    ]);
    expect(selected.primary?.id).toBe("unit-build");
    expect(selected.conflicts.map((item) => item.id)).toEqual(["conflict"]);
    expect(selected.supporting).toEqual([]);
  });
});
