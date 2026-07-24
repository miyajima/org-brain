import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildApiUrl, parseTarget, resolveApiBase } from "./agent-messages.mjs";

describe("agent messages CLI helpers", () => {
  it("parses typed message targets", () => {
    assert.deepEqual(parseTarget("principal:service:codex"), {
      target_type: "principal",
      target_key: "service:codex"
    });
    assert.deepEqual(parseTarget("agent:codex"), {
      target_type: "agent",
      target_key: "codex"
    });
    assert.throws(() => parseTarget("codex"), /invalid target/i);
    assert.throws(() => parseTarget("unknown:codex"), /invalid target/i);
  });

  it("prefers ORGBRAIN_API_URL over the compatibility alias", () => {
    assert.equal(resolveApiBase({ ORGBRAIN_API_BASE: "https://legacy.example.test" }), "https://legacy.example.test");
    assert.equal(
      resolveApiBase({
        ORGBRAIN_API_URL: "https://canonical.example.test",
        ORGBRAIN_API_BASE: "https://legacy.example.test"
      }),
      "https://canonical.example.test"
    );
  });

  it("builds API URLs under a configured base path", () => {
    assert.equal(
      buildApiUrl("https://example.test/base", "/v1/agent-messages").toString(),
      "https://example.test/base/v1/agent-messages"
    );
  });
});
