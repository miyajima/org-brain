import { describe, expect, it } from "vitest";
import {
  captureMemoryWithInferredRationale,
  confirmProposedMemory,
  filterMemorySearchResults,
  proposeMemoryWithRationale
} from "../src/rationale-service";
import { deterministicProjectBusinessCategory } from "../src/business-category-service";

type MemoryRecord = {
  id: string;
  tenant_id: string;
  project_id: string | null;
  content: string;
  summary: string | null;
  tags_json: string | null;
  source: string;
  external_key: string | null;
  created_at: number;
  kind?: string | null;
  lifecycle_state?: string | null;
  scope_type?: string | null;
  scope_key?: string | null;
  actor_type?: string | null;
  actor_id?: string | null;
  confidence_score?: number | null;
  utility_score?: number | null;
  canonical_key?: string | null;
  root_memory_id?: string | null;
  current_version?: number | null;
  expires_at?: number | null;
  revised_at?: number | null;
  business_category_id?: string | null;
  work_type?: string | null;
  rationale?: string | null;
  reuse_rule?: string | null;
  capture_origin?: string | null;
  verification_state?: string | null;
  verified_at?: number | null;
  learning_json?: string | null;
  quality_dimensions_json?: string | null;
};

class FakeStatement {
  sql: string;
  db: FakeD1;
  args: unknown[] = [];

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>() {
    if (this.sql.includes("FROM business_categories") && this.sql.includes("tenant_id = ?") && this.sql.includes("id = ?")) {
      const row = this.db.businessCategories.find((item) => item.tenant_id === this.args[0] && item.id === this.args[1]);
      return (row ?? null) as T | null;
    }
    if (this.sql.startsWith("SELECT id, tenant_id, source, payload_json, expires_at, consumed_at FROM memory_confirmations")) {
      const row = this.db.memoryConfirmations.find((item) => item.tenant_id === this.args[0] && item.id === this.args[1]);
      return (row ?? null) as T | null;
    }
    if (this.sql.startsWith("SELECT id FROM entities WHERE tenant_id = ? AND entity_type = ? AND canonical_name = ?")) {
      const row = this.db.entities.find(
        (item) => item.tenant_id === this.args[0] && item.entity_type === this.args[1] && item.canonical_name === this.args[2]
      );
      return (row ? { id: row.id } : null) as T | null;
    }
    if (this.sql.startsWith("SELECT id FROM decision_rationales WHERE tenant_id = ? AND memory_id = ?")) {
      const row = this.db.rationales.find((item) => item.tenant_id === this.args[0] && item.memory_id === this.args[1]);
      return (row ? { id: row.id } : null) as T | null;
    }
    if (this.sql.includes("FROM memories") && this.sql.includes("WHERE tenant_id = ? AND id = ?")) {
      const row = this.db.memories.find((item) => item.tenant_id === this.args[0] && item.id === this.args[1]);
      return (row ?? null) as T | null;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes("SELECT id, external_key") && this.sql.includes("external_key IN")) {
      const keys = new Set(this.args.slice(1).map(String));
      return {
        results: this.db.memories
          .filter((row) => row.tenant_id === this.args[0] && row.external_key && keys.has(row.external_key))
          .map((row) => ({ id: row.id, external_key: row.external_key })) as T[]
      };
    }
    if (this.sql.includes("SELECT id, canonical_key") && this.sql.includes("canonical_key IN")) {
      const keys = new Set(this.args.slice(1).map(String));
      return {
        results: this.db.memories
          .filter((row) => row.tenant_id === this.args[0] && row.canonical_key && keys.has(row.canonical_key))
          .filter((row) => row.lifecycle_state !== "suppressed")
          .map((row) => ({ id: row.id, canonical_key: row.canonical_key })) as T[]
      };
    }
    if (this.sql.startsWith("SELECT DISTINCT r.memory_id")) {
      const tenantId = String(this.args[0]);
      const ids = new Set(this.args.slice(1).filter((value) => typeof value === "string").map(String));
      const reasonText = this.args.find((value) => typeof value === "string" && String(value).startsWith("%")) as string | undefined;
      const entityId = this.args.find((value) => typeof value === "string" && String(value).startsWith("ent-")) as string | undefined;
      const results = this.db.rationales
        .filter((row) => String(row.tenant_id) === tenantId && ids.has(String(row.memory_id)))
        .filter((row) => !reasonText || String(row.reason_summary).toLowerCase().includes(reasonText.replace(/%/g, "").toLowerCase()))
        .filter((row) => {
          if (!entityId) return true;
          return this.db.memoryEntities.some(
            (item) => String(item.tenant_id) === tenantId && String(item.memory_id) === String(row.memory_id) && String(item.entity_id) === entityId
          );
        })
        .map((row) => ({ memory_id: String(row.memory_id) }));
      return { results: results as T[] };
    }
    return { results: [] as T[] };
  }

  async run() {
    if (this.sql.startsWith("INSERT OR IGNORE INTO business_categories(")) {
      if (!this.db.businessCategories.some((item) => item.id === this.args[0])) {
        this.db.businessCategories.push({
          id: String(this.args[0]),
          tenant_id: String(this.args[1]),
          slug: String(this.args[2]),
          label: String(this.args[3]),
          description: (this.args[4] as string | null) ?? null,
          is_active: Number(this.args[5]),
          created_at: Number(this.args[6]),
          updated_at: Number(this.args[7])
        });
      }
      return;
    }
    if (this.sql.startsWith("INSERT INTO memory_confirmations(")) {
      this.db.memoryConfirmations.push({
        id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        source: String(this.args[2]),
        payload_json: String(this.args[3]),
        created_at: Number(this.args[4]),
        expires_at: Number(this.args[5]),
        consumed_at: null
      });
      return;
    }
    if (this.sql.startsWith("UPDATE memory_confirmations SET consumed_at = ?")) {
      const row = this.db.memoryConfirmations.find((item) => item.tenant_id === this.args[1] && item.id === this.args[2]);
      if (row) row.consumed_at = Number(this.args[0]);
      return;
    }
    if (this.sql.startsWith("INSERT INTO entities(")) {
      this.db.entities.push({
        id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        entity_type: String(this.args[2]),
        canonical_name: String(this.args[3]),
        aliases_json: String(this.args[4]),
        external_ref: (this.args[5] as string | null) ?? null,
        created_at: Number(this.args[6])
      });
      return;
    }
    if (this.sql.startsWith("INSERT INTO memories(")) {
      if (this.db.canonicalRaceWinnerId) {
        const winnerId = this.db.canonicalRaceWinnerId;
        this.db.canonicalRaceWinnerId = null;
        this.db.memories.push({
          id: winnerId,
          tenant_id: String(this.args[1]),
          project_id: (this.args[2] as string | null) ?? null,
          content: "concurrent winner",
          summary: "concurrent winner",
          tags_json: "[]",
          source: "hook",
          external_key: "concurrent:winner",
          created_at: Number(this.args[8]),
          kind: String(this.args[9]),
          lifecycle_state: "active",
          canonical_key: (this.args[17] as string | null) ?? null,
          current_version: 1
        });
        throw new Error("D1_ERROR: duplicate_canonical_key: SQLITE_CONSTRAINT");
      }
      this.db.memories.push({
        id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        project_id: (this.args[2] as string | null) ?? null,
        content: String(this.args[3]),
        summary: (this.args[4] as string | null) ?? null,
        tags_json: String(this.args[5]),
        source: String(this.args[6]),
        external_key: (this.args[7] as string | null) ?? null,
        created_at: Number(this.args[8]),
        kind: String(this.args[9]),
        lifecycle_state: String(this.args[10]),
        scope_type: String(this.args[11]),
        scope_key: (this.args[12] as string | null) ?? null,
        actor_type: (this.args[13] as string | null) ?? null,
        actor_id: (this.args[14] as string | null) ?? null,
        confidence_score: (this.args[15] as number | null) ?? null,
        utility_score: (this.args[16] as number | null) ?? null,
        canonical_key: (this.args[17] as string | null) ?? null,
        root_memory_id: (this.args[18] as string | null) ?? null,
        current_version: Number(this.args[19]),
        expires_at: (this.args[21] as number | null) ?? null,
        revised_at: Number(this.args[22]),
        rationale: (this.args[29] as string | null) ?? null,
        business_category_id: (this.args[33] as string | null) ?? null,
        work_type: (this.args[34] as string | null) ?? null,
        reuse_rule: (this.args[35] as string | null) ?? null,
        capture_origin: (this.args[36] as string | null) ?? null,
        verification_state: (this.args[37] as string | null) ?? null,
        verified_at: (this.args[38] as number | null) ?? null,
        learning_json: (this.args[39] as string | null) ?? null,
        quality_dimensions_json: (this.args[40] as string | null) ?? null
      });
      return;
    }
    if (this.sql.startsWith("DELETE FROM memories_fts")) {
      this.db.memoriesFts = this.db.memoriesFts.filter((item) => !(item.memory_id === this.args[0] && item.tenant_id === this.args[1]));
      return;
    }
    if (this.sql.startsWith("INSERT INTO memories_fts")) {
      this.db.memoriesFts.push({ memory_id: String(this.args[0]), tenant_id: String(this.args[1]), content: String(this.args[2]) });
      return;
    }
    if (this.sql.startsWith("INSERT INTO memory_versions(")) {
      this.db.memoryVersions.push({ memory_id: String(this.args[1]), tenant_id: String(this.args[2]), version: Number(this.args[3]) });
      return;
    }
    if (this.sql.startsWith("INSERT INTO decision_rationales(")) {
      this.db.rationales.push({
        id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        memory_id: String(this.args[2]),
        project_id: (this.args[3] as string | null) ?? null,
        decision_type: String(this.args[4]),
        conclusion: String(this.args[5]),
        reason_summary: String(this.args[6]),
        status: String(this.args[7]),
        confirmation_state: String(this.args[8]),
        decider_entity_id: (this.args[9] as string | null) ?? null
      });
      return;
    }
    if (this.sql.startsWith("DELETE FROM memory_entities")) {
      this.db.memoryEntities = this.db.memoryEntities.filter((item) => !(item.tenant_id === this.args[0] && item.memory_id === this.args[1]));
      return;
    }
    if (this.sql.startsWith("DELETE FROM decision_evidence")) {
      this.db.evidence = this.db.evidence.filter((item) => !(item.tenant_id === this.args[0] && item.rationale_id === this.args[1]));
      return;
    }
    if (this.sql.startsWith("INSERT INTO memory_entities(")) {
      this.db.memoryEntities.push({
        id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        memory_id: String(this.args[2]),
        entity_id: String(this.args[3]),
        role: String(this.args[4])
      });
      return;
    }
    if (this.sql.startsWith("INSERT INTO decision_evidence(")) {
      this.db.evidence.push({
        id: String(this.args[0]),
        tenant_id: String(this.args[1]),
        rationale_id: String(this.args[2]),
        evidence_ref: String(this.args[4])
      });
      return;
    }
    if (this.sql.startsWith("UPDATE decision_rationales SET decider_entity_id = ?")) {
      const row = this.db.rationales.find((item) => item.tenant_id === this.args[1] && item.id === this.args[2]);
      if (row) row.decider_entity_id = String(this.args[0]);
    }
  }
}

class FakeD1 {
  canonicalRaceWinnerId: string | null = null;
  businessCategories: Array<Record<string, unknown>> = [];
  memoryConfirmations: Array<Record<string, unknown>> = [];
  entities: Array<Record<string, unknown>> = [];
  memories: MemoryRecord[] = [];
  memoriesFts: Array<Record<string, unknown>> = [];
  memoryVersions: Array<Record<string, unknown>> = [];
  rationales: Array<Record<string, unknown>> = [];
  memoryEntities: Array<Record<string, unknown>> = [];
  evidence: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    for (const statement of statements) {
      await statement.run();
    }
  }
}

describe("rationale service", () => {
  it("proposes a rationale and stores a confirmation token", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof proposeMemoryWithRationale>[0];
    const result = await proposeMemoryWithRationale(env, {
      tenant_id: "default",
      source: "openclaw",
      item: {
        content: "原因は認証不足です。対処として wrangler login を実行し、今後も最初に確認する方針です。",
        project_id: "org-brain"
      }
    });

    expect(result.confirmation_token).toBeTruthy();
    expect(result.proposed_rationale.conclusion.length).toBeGreaterThan(0);
    expect(db.memoryConfirmations).toHaveLength(1);
  });

  it("confirms and persists corrected rationale data", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof proposeMemoryWithRationale>[0];
    const proposed = await proposeMemoryWithRationale(env, {
      tenant_id: "default",
      source: "openclaw",
      item: {
        content: "原因は認証不足です。対処として wrangler login を実行しました。",
        project_id: "org-brain"
      }
    });

    const confirmed = await confirmProposedMemory(env, {
      tenant_id: "default",
      confirmation_token: proposed.confirmation_token,
      approved: true,
      conclusion: "wrangler login を先に実行する",
      reason_summary: "認証不足が原因だったため",
      entities: [{ name: "wrangler", entity_type: "service", role: "decision_maker" }]
    });

    expect(confirmed.saved).toBe(true);
    expect(confirmed.confirmation_state).toBe("user_corrected");
    expect(db.memories).toHaveLength(1);
    expect(db.rationales).toHaveLength(1);
    expect(db.memoryEntities).toHaveLength(1);
  });

  it("captures non-interactive memories with inferred unconfirmed rationale", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof captureMemoryWithInferredRationale>[0];
    const captured = await captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      source: "openclaw",
      actor_type: "system",
      actor_id: "openclaw:turn-1",
      item: {
        external_key: "learning:test",
        content: "## Decision\nUse `wrangler whoami` first.\n\n## Reason\nCloudflare auth often expires.\n\n## Evidence\napps/api-gateway/wrangler.jsonc\nthread:turn-1",
        summary: "org-brain | project-fact | use wrangler whoami first",
        tags: ["project-fact", "curated-memory"],
        project_id: "org-brain"
      }
    });

    expect(captured.memory_id).toBeTruthy();
    expect(captured.confirmation_state).toBe("inferred_unconfirmed");
    expect(db.memories).toHaveLength(1);
    expect(db.memories[0]?.actor_id).toBe("openclaw:turn-1");
    expect(db.rationales).toHaveLength(1);
    expect(db.rationales[0]?.confirmation_state).toBe("inferred_unconfirmed");
    expect(db.evidence.length).toBeGreaterThan(0);
  });

  it("captures one to three v2 items and reports per-candidate status", async () => {
    const db = new FakeD1();
    const projectCategory = await deterministicProjectBusinessCategory("default", "org-brain");
    const env = {
      OPEN_BRAIN_DB: db,
      ORGBRAIN_MEMORY_CAPTURE_V2_MODE: "off"
    } as unknown as Parameters<typeof captureMemoryWithInferredRationale>[0];
    const captured = await captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      source: "hook",
      items: [
        {
          external_key: "evt-1:fact",
          canonical_key: "a".repeat(64),
          kind: "fact",
          content: "ORGBRAIN_API_URL is the canonical variable.",
          rationale: "All adapters need one configuration name.",
          reuse_rule: "When configuring an Org Brain adapter, use this variable.",
          source_refs: [{ type: "file", ref: "docs/SPEC.md" }],
          project_id: "org-brain",
          business_category_id: projectCategory.id
        },
        {
          external_key: "evt-1:pitfall",
          canonical_key: "b".repeat(64),
          kind: "pitfall",
          content: "Authentication fails because stale credentials remain; re-authenticate and verify the command exits with zero.",
          rationale: "Stale credentials caused the failure.",
          project_id: "org-brain",
          business_category_id: projectCategory.id
        }
      ]
    });

    expect(captured.results).toHaveLength(2);
    expect(captured.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ external_key: "evt-1:fact", status: "created", reason_code: "captured", memory_id: expect.any(String) }),
      expect.objectContaining({ external_key: "evt-1:pitfall", status: "created", reason_code: "captured", memory_id: expect.any(String) })
    ]));
    expect(db.businessCategories).toHaveLength(1);
    expect(db.memories.every((memory) => memory.business_category_id === db.businessCategories[0]?.id)).toBe(true);
    expect(db.memories.every((memory) => memory.work_type === "other")).toBe(true);
    expect(db.memories[0]?.rationale).toBe("All adapters need one configuration name.");
    expect(db.memories[0]?.reuse_rule).toBe("When configuring an Org Brain adapter, use this variable.");
    expect(db.memoryVersions[0]).toBeTruthy();
    expect(Number(db.memories[0]?.expires_at) - Number(db.memories[0]?.created_at)).toBe(90 * 24 * 60 * 60 * 1000);
    expect(Number(db.memories[1]?.expires_at) - Number(db.memories[1]?.created_at)).toBe(180 * 24 * 60 * 60 * 1000);

    const duplicate = await captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      source: "hook",
      items: [{
        external_key: "evt-2:fact",
        canonical_key: "a".repeat(64),
        kind: "fact",
        content: "ORGBRAIN_API_URL is the canonical variable.",
        project_id: "org-brain",
        business_category_id: projectCategory.id
      }]
    });
    expect(duplicate.results).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason_code: "duplicate_canonical_key",
        memory_id: db.memories[0]?.id
      })
    ]);
    expect(db.memories).toHaveLength(2);
  });

  it("requires external keys for idempotent batch capture", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof captureMemoryWithInferredRationale>[0];
    await expect(captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      items: [{ kind: "fact", content: "A durable fact uses one source of truth." }]
    })).rejects.toMatchObject({ code: "external_key_required" });
  });

  it("requires memory:attest authority before persisting verified observed learning", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof captureMemoryWithInferredRationale>[0];
    const request = {
      tenant_id: "default",
      source: "hook",
      items: [{
        external_key: "observed:verified-1",
        canonical_key: "e".repeat(64),
        kind: "fact",
        content: "Only same-turn command results attest success.",
        rationale: "Final-answer prose is not an execution result.",
        reuse_rule: "Require an observed exit code or signed attestation.",
        project_id: "org-brain",
        capture_origin: "observed",
        verification: {
          state: "verified",
          verified_at: 1_700_000_000_500,
          attestation_ref: `sha256:${"f".repeat(64)}`
        },
        learning: {
          schema_version: 1,
          lesson_type: "success",
          kind: "fact",
          trigger: "A task reports command success",
          conclusion: "Only same-turn command results attest success",
          rationale: "Final-answer prose is not an execution result",
          reuse_rule: "Require an observed exit code or signed attestation",
          outcome: "The verification passed",
          applicability: { target_files: [], components: ["memory-learning"] },
          evidence_selectors: [{ type: "command", ref: "vitest evidence" }],
          gaps: []
        },
        quality_dimensions: { evidence_support: 100, scope: 100 }
      }]
    };

    const denied = await captureMemoryWithInferredRationale(env, request);
    expect(denied.results).toEqual([
      expect.objectContaining({ status: "skipped", reason_code: "memory_attestation_required" })
    ]);
    expect(db.memories).toHaveLength(0);

    const accepted = await captureMemoryWithInferredRationale(env, request, { canAttest: true });
    expect(accepted.results[0]).toMatchObject({ status: "created" });
    expect(db.memories[0]).toMatchObject({
      capture_origin: "observed",
      verification_state: "verified",
      verified_at: 1_700_000_000_500,
      utility_score: 1
    });
    expect(JSON.parse(db.memories[0]?.learning_json ?? "null")).toMatchObject({ lesson_type: "success" });
  });

  it("keeps a missing v2 rationale out of memory content and marks it for review", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof captureMemoryWithInferredRationale>[0];
    const captured = await captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      source: "hook",
      items: [{
        external_key: "evt-no-rationale:constraint",
        canonical_key: "d".repeat(64),
        kind: "constraint",
        content: "Never store credentials in memory.",
        summary: "Never store credentials",
        tags: ["capture-v2", "constraint"],
        project_id: "org-brain"
      }]
    });

    expect(db.memories[0]?.rationale).toBeNull();
    expect(db.memories[0]?.summary).toBe("Never store credentials");
    expect(db.rationales[0]?.reason_summary).toBe("Rationale was not extracted; review required.");
    expect(db.rationales[0]?.decision_type).toBe("policy");
    expect(captured.results[0]?.classification_warning).toContain("rationale_missing_review_required");
  });

  it("returns the winning memory when a concurrent canonical insert loses", async () => {
    const db = new FakeD1();
    db.canonicalRaceWinnerId = "memory-race-winner";
    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof captureMemoryWithInferredRationale>[0];
    const captured = await captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      source: "hook",
      items: [{
        external_key: "evt-race:fact",
        canonical_key: "c".repeat(64),
        kind: "fact",
        content: "A canonical fact must have one active owner.",
        project_id: "org-brain"
      }]
    });

    expect(captured.results).toEqual([
      expect.objectContaining({
        status: "skipped",
        reason_code: "duplicate_canonical_key",
        memory_id: "memory-race-winner"
      })
    ]);
    expect(db.memories.map((memory) => memory.id)).toEqual(["memory-race-winner"]);
    expect(db.memoryVersions).toHaveLength(0);
  });

  it("never persists credentials and only accepts redacted restricted PII for seven days", async () => {
    const db = new FakeD1();
    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof captureMemoryWithInferredRationale>[0];
    const credential = await captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      source: "hook",
      items: [{
        external_key: "evt-secret",
        kind: "fact",
        content: "The API uses api_key=secret-value-that-must-never-persist.",
        project_id: "org-brain",
        visibility: "restricted",
        allowed_principals: ["principal-1"]
      }]
    });
    expect(credential.results).toEqual([
      expect.objectContaining({ status: "skipped", reason_code: "credential_detected" })
    ]);
    expect(db.memories).toHaveLength(0);

    const credentialInRationale = await captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      source: "hook",
      items: [{
        external_key: "evt-secret-rationale",
        kind: "decision",
        content: "Use the canonical API configuration.",
        rationale: "The old setting used token=secret-value-that-must-never-persist.",
        project_id: "org-brain"
      }]
    });
    expect(credentialInRationale.results).toEqual([
      expect.objectContaining({ status: "skipped", reason_code: "credential_detected" })
    ]);
    expect(db.memories).toHaveLength(0);

    const createdAt = Date.parse("2026-08-12T00:00:00.000Z");
    const restricted = await captureMemoryWithInferredRationale(env, {
      tenant_id: "default",
      source: "hook",
      items: [{
        external_key: "evt-pii",
        kind: "fact",
        content: "The support contact uses alice@example.com.",
        project_id: "org-brain",
        created_at: createdAt,
        valid_until: createdAt + 30 * 24 * 60 * 60 * 1000,
        evidence: [{
          evidence_type: "external",
          evidence_ref: "alice@example.com",
          relation: "supports"
        }],
        visibility: "restricted",
        allowed_principals: ["principal-1"]
      }]
    });
    expect(restricted.results[0]).toMatchObject({ status: "created" });
    expect(db.memories[0]?.content).toContain("[REDACTED_EMAIL]");
    expect(db.memories[0]?.content).not.toContain("alice@example.com");
    expect(db.evidence[0]?.evidence_ref).toBe("[REDACTED_EMAIL]");
    expect(db.memories[0]?.expires_at).toBe(createdAt + 7 * 24 * 60 * 60 * 1000);
  });

  it("filters search results by rationale reason text and entity", async () => {
    const db = new FakeD1();
    db.rationales.push({
      id: "rat-1",
      tenant_id: "default",
      memory_id: "mem-1",
      project_id: "org-brain",
      decision_type: "diagnose",
      conclusion: "use wrangler login",
      reason_summary: "authentication issue in wrangler",
      status: "accepted",
      confirmation_state: "user_confirmed",
      decider_entity_id: "ent-1"
    });
    db.rationales.push({
      id: "rat-2",
      tenant_id: "default",
      memory_id: "mem-2",
      project_id: "org-brain",
      decision_type: "policy",
      conclusion: "keep checks",
      reason_summary: "testing policy",
      status: "accepted",
      confirmation_state: "user_confirmed",
      decider_entity_id: null
    });
    db.memoryEntities.push({ id: "me-1", tenant_id: "default", memory_id: "mem-1", entity_id: "ent-1", role: "subject" });

    const env = { OPEN_BRAIN_DB: db } as unknown as Parameters<typeof filterMemorySearchResults>[0];
    const result = await filterMemorySearchResults(env, "default", ["mem-1", "mem-2"], {
      entityId: "ent-1",
      entityRole: "subject",
      decisionType: null,
      decisionStatus: null,
      confirmationState: null,
      reasonText: "auth"
    });

    expect([...result]).toEqual(["mem-1"]);
  });
});
