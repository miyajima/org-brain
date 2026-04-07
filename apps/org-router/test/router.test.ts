import { describe, expect, it } from "vitest";
import { handleEnvelope } from "../src/index";

function createDbMock() {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        run: async () => ({ success: true })
      })
    })
  };
}

describe("org-router envelope handling", () => {
  it("routes task.created by capability", async () => {
    const plan: unknown[] = [];
    const code: unknown[] = [];
    const review: unknown[] = [];

    const env = {
      OPEN_BRAIN_DB: createDbMock(),
      CAP_PLAN_OUT: { send: async (m: unknown) => plan.push(m) },
      CAP_CODE_OUT: { send: async (m: unknown) => code.push(m) },
      CAP_REVIEW_OUT: { send: async (m: unknown) => review.push(m) }
    } as any;

    await handleEnvelope(env, {
      message_id: "m1",
      tenant_id: "default",
      type: "task.created",
      ts: Date.now(),
      payload: {
        task_id: "t1",
        capability: "code_gen",
        priority: 0,
        input_ref: "x"
      }
    });

    expect(plan).toHaveLength(0);
    expect(code).toHaveLength(1);
    expect(review).toHaveLength(0);
  });
});
