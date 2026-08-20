import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVerifiedKnowledgeBundle, verifySignedVerifiedKnowledgeBundle, type LocalSessionV1 } from "../src/verified-knowledge-bundle";
import { createCollectorIdentity, signVerifiedBundle } from "../../orgbrain-cli/src/verified-collector.mjs";

const session: LocalSessionV1 = {
  tenant_id: "tenant-compat",
  project_id: "project-compat",
  task_id: "task-compat",
  decision_thread_id: "thread-compat",
  events: [{
    event_id: "event-compat",
    turn_id: "turn-compat",
    tenant_id: "tenant-compat",
    project_id: "project-compat",
    task_id: "task-compat",
    decision_thread_id: "thread-compat",
    role: "user",
    actor_type: "human",
    actor_id: "user:compat",
    occurred_at: 1,
    text: "決定: src/compat.ts を採用する。理由は検証可能だから。",
    file_change: { path: "src/compat.ts", content_hash: "a".repeat(64) }
  }]
};

describe("verified collector compatibility", () => {
  it("verifies a CLI-signed bundle with optional safety flags omitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orgbrain-collector-compat-"));
    try {
      const keyId = "compat-collector";
      const identity = await createCollectorIdentity({ keyId, directory });
      const unsigned = await buildVerifiedKnowledgeBundle(session, { collector_key_id: keyId });
      const cliShape = {
        ...unsigned,
        candidates: unsigned.candidates.map(({ safety_flags: _safetyFlags, ...candidate }) => candidate)
      };
      const signed = await signVerifiedBundle(cliShape, { keyId, directory });
      const verification = await verifySignedVerifiedKnowledgeBundle(signed, identity.public_key);
      expect(verification.valid).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
