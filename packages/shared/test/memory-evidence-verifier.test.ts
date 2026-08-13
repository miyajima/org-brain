import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { observeMemoryLearningEvent } from "../src/memory-learning";
import {
  collectVerifiedLearningEvents,
  verifyLearningEvent
} from "../../orgbrain-cli/src/lib/memory-learning-transcript.mjs";

function learningEvent(index = 0) {
  return {
    schema_version: 1,
    lesson_type: "success",
    kind: "fact",
    trigger: `hook symptom ${index}`,
    conclusion: "VERIFIED_IDENTIFIER makes capture deterministic",
    rationale: "The changed implementation and successful test independently support the conclusion",
    reuse_rule: "Apply the same verified path when this hook symptom recurs",
    outcome: "The current-turn verification succeeded",
    applicability: { target_files: ["src/hook.ts"], components: ["hook"] },
    evidence_selectors: [
      { type: "file", ref: "src/hook.ts" },
      { type: "command", ref: "vitest hook" }
    ],
    gaps: []
  } as const;
}

describe("current-turn evidence verifier", () => {
  it("accepts an observed event only after file and command evidence match", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "orgbrain-learning-"));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(path.join(root, "base.txt"), "base\n");
    execFileSync("git", ["add", "base.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root, stdio: "ignore" });
    execFileSync("mkdir", ["-p", "src"], { cwd: root });
    writeFileSync(path.join(root, "src/hook.ts"), "export const VERIFIED_IDENTIFIER = true;\n");
    const event = learningEvent();
    const observed = await observeMemoryLearningEvent(event, { workspaceRoot: root });
    const transcript = path.join(root, "session.jsonl");
    const rows = [
      { payload: { type: "turn_context", turn_id: "turn-1" } },
      { payload: { type: "user_message", message: "Implement the verified hook" } },
      { payload: { type: "custom_tool_call", name: "exec", call_id: "exec-1", input: "vitest hook" } },
      { payload: { type: "custom_tool_call_output", call_id: "exec-1", output: "Script completed; exit_code=0" } },
      { payload: {
        type: "mcp_tool_call_end",
        invocation: { tool: "orgbrain_memory_observe", arguments: event },
        result: { Ok: { content: [{ type: "text", text: JSON.stringify(observed) }] } }
      } }
    ];
    writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const result = await collectVerifiedLearningEvents({
      transcriptPath: transcript,
      turnId: "turn-1",
      workspaceRoot: root
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].verification.verification_state).toBe("verified");
    expect(result.events[0].verification.evidence).toHaveLength(2);
  });

  it("rejects at least 60 adversarial self-reported command claims", async () => {
    const attempts = await Promise.all(Array.from({ length: 64 }, async (_, index) => {
      const event = learningEvent(index);
      return verifyLearningEvent(event, {
        rows: [{ payload: { type: "agent_message", phase: "final_answer", message: `vitest hook passed ${index}` } }],
        userText: "",
        workspaceRoot: null
      });
    }));
    expect(attempts).toHaveLength(64);
    expect(attempts.filter((attempt) => attempt.verification_state === "verified")).toHaveLength(0);
    expect(attempts.every((attempt) => attempt.reason_codes.includes("command_not_observed"))).toBe(true);
  });

  it("accepts a valid command attestation and rejects a forged one", async () => {
    const key = "test-attestation-key-that-is-long-enough";
    const payload = {
      schema_version: 1,
      command_hash: crypto.createHash("sha256").update("vitest hook").digest("hex"),
      exit_code: 0,
      started_at: 1_700_000_000_000,
      completed_at: 1_700_000_000_500,
      cwd_hash: crypto.createHash("sha256").update("workspace").digest("hex")
    };
    const signature = crypto.createHmac("sha256", key).update(JSON.stringify(payload)).digest("hex");
    const event = {
      ...learningEvent(),
      lesson_type: "decision" as const,
      applicability: { target_files: [], components: ["hook"] },
      evidence_selectors: [{ type: "command" as const, ref: "vitest hook" }]
    };
    const rows = (attestationRef: string) => [
      { payload: { type: "custom_tool_call", name: "exec_command", call_id: "exec-1", input: { cmd: "orgbrain evidence run -- vitest hook" } } },
      { payload: { type: "custom_tool_call_output", call_id: "exec-1", output: JSON.stringify({ ...payload, attestation_ref: attestationRef }) } }
    ];

    const valid = await verifyLearningEvent(event, { rows: rows(`hmac-sha256:${signature}`), userText: "", workspaceRoot: null, attestationKey: key });
    const forged = await verifyLearningEvent(event, { rows: rows(`hmac-sha256:${"0".repeat(64)}`), userText: "", workspaceRoot: null, attestationKey: key });
    expect(valid.verification_state).toBe("verified");
    expect(valid.evidence[0].attestation_ref).toBe(`hmac-sha256:${signature}`);
    expect(forged.verification_state).toBe("unverified");
    expect(forged.reason_codes).toContain("command_attestation_invalid");
  });
});
