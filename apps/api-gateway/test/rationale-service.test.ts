import { describe, expect, it } from "vitest";
import { confirmProposedMemory, filterMemorySearchResults, proposeMemoryWithRationale } from "../src/rationale-service";

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
    if (this.sql.includes("FROM memories") && this.sql.includes("WHERE tenant_id = ? AND id = ?")) {
      const row = this.db.memories.find((item) => item.tenant_id === this.args[0] && item.id === this.args[1]);
      return (row ?? null) as T | null;
    }
    return null;
  }

  async all<T>() {
    if (this.sql.includes("SELECT id, external_key") && this.sql.includes("external_key IN")) {
      return { results: [] as T[] };
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
        revised_at: Number(this.args[22])
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
