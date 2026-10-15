import { describe, expect, it } from "vitest";
import { captureMemoryItems, reviseMemory, suppressMemory } from "../src/memory-lifecycle-service";
import { backfillV4RetrievalUnits } from "../src/retrieval-index-service";
import { memoryD1Fixture } from "./fixtures/memory-d1";

describe("versioned retrieval evidence on migrated D1-compatible SQLite", () => {
  it("preserves conditional reuse and source versions through correction, backfill and retraction", async () => {
    const { sql, env } = memoryD1Fixture();
    try {
      const reuse = "Synthetic fixtures only; check the digest before reuse and never use production inputs.";
      const captured = await captureMemoryItems(env, { tenantId: "fixture", source: "synthetic", items: [{
        external_key: "lineage:procedure", project_id: "p", kind: "constraint",
        content: "Always validate the synthetic fixture before replay.",
        rationale: "Its inputs are bounded.", reuse_rule: reuse,
        source_references: [{ type: "file", ref: "fixtures/synthetic.json", captured_at: 1_700_000_000_000 }],
        verification_state: "unverified"
      }] });
      const memoryId = captured.items[0].memory_id;
      const units = () => sql.prepare("SELECT text,metadata_json,source_ref_json FROM memory_retrieval_units_v4 WHERE memory_id=?").all(memoryId);
      expect(units().length).toBeGreaterThan(0);
      expect(units().every((unit: any) => JSON.parse(unit.metadata_json).source_version === 1)).toBe(true);
      expect(units().some((unit: any) => unit.text === `Reuse or avoid: ${reuse}`)).toBe(true);

      await reviseMemory(env, { tenantId: "fixture", memoryId, content: "Always validate the corrected synthetic fixture before replay." });
      const current = sql.prepare("SELECT current_version,content_hash,verification_state,reuse_rule FROM memories WHERE id=?").get(memoryId);
      expect(current.current_version).toBe(2);
      expect(current.verification_state).toBe("unverified");
      expect(current.reuse_rule).toBe(reuse);
      expect(units().every((unit: any) => {
        const metadata = JSON.parse(unit.metadata_json);
        return metadata.source_version === 2 && metadata.source_content_hash === current.content_hash
          && metadata.evidence_status === "extracted_unverified";
      })).toBe(true);
      expect(units().filter((unit: any) => JSON.parse(unit.metadata_json).channel !== "rationale"
        && JSON.parse(unit.metadata_json).channel !== "reuse_or_avoidance")
        .every((unit: any) => unit.text.includes("corrected"))).toBe(true);
      const prior = sql.prepare("SELECT content FROM memory_versions WHERE memory_id=? AND version=1").get(memoryId);
      expect(prior.content).not.toContain("corrected");

      await backfillV4RetrievalUnits(env, { tenantId: "fixture", cursor: "" });
      expect(units().every((unit: any) => JSON.parse(unit.metadata_json).source_version === 2)).toBe(true);
      expect(units().some((unit: any) => unit.text === `Reuse or avoid: ${reuse}`)).toBe(true);

      await suppressMemory(env, { tenantId: "fixture", memoryId, reason: "The source procedure was retracted.", expectedVersion: 2 });
      for (const table of ["memory_retrieval_units_v4", "memory_retrieval_units_v4_fts", "retrieval_units"]) {
        const key = table === "retrieval_units" ? "source_id" : "memory_id";
        expect(sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${key}=?`).get(memoryId).n).toBe(0);
      }
      const after = await backfillV4RetrievalUnits(env, { tenantId: "fixture", cursor: "" });
      expect(after.processed_memories).toBe(0);
      expect(units()).toEqual([]);
      expect(sql.prepare("SELECT count(*) AS n FROM memory_versions WHERE memory_id=?").get(memoryId).n).toBe(3);
    } finally { sql.close(); }
  });
});
