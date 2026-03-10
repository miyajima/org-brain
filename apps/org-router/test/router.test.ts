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
      WF_SPEC2CODE: {
        get: async () => ({
          sendEvent: async () => {}
        })
      },
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

  it("forwards task.result to workflow event", async () => {
    const events: unknown[] = [];

    const env = {
      OPEN_BRAIN_DB: createDbMock(),
      WF_SPEC2CODE: {
        get: async () => ({
          sendEvent: async (event: unknown) => {
            events.push(event);
          }
        })
      },
      CAP_PLAN_OUT: { send: async () => {} },
      CAP_CODE_OUT: { send: async () => {} },
      CAP_REVIEW_OUT: { send: async () => {} }
    } as any;

    await handleEnvelope(env, {
      message_id: "m2",
      tenant_id: "default",
      type: "task.result",
      trace_id: "wf-123",
      ts: Date.now(),
      payload: {
        task_id: "t2",
        capability: "code_gen",
        status: "succeeded",
        output_ref: "r2://a",
        wait_event_type: "task.wf-123.code.done"
      }
    });

    expect(events).toHaveLength(1);
    expect((events[0] as any).type).toBe("task.wf-123.code.done");
  });
});
