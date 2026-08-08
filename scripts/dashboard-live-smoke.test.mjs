import assert from "node:assert/strict";
import test from "node:test";
import { runDashboardLiveSmoke } from "./dashboard-live-smoke.mjs";

function response(data) {
  return new Response(JSON.stringify({ ok: true, data: { contract_version: "dashboard/v1", ...data } }), {
    headers: { "content-type": "application/json" }
  });
}

test("dashboard live smoke checks all list views and an available strata detail", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    const pathname = new URL(url).pathname;
    if (pathname === "/base/v1/dashboard/activity") return response({ events: [] });
    if (pathname === "/base/v1/dashboard/knowledge-graph") return response({ nodes: [] });
    if (pathname === "/base/v1/dashboard/strata") {
      return response({ chains: [{ source_type: "memory", source_id: "m/1" }] });
    }
    return response({ chain: { revisions: [], sources: [] } });
  };

  const result = await runDashboardLiveSmoke({
    env: {
      ORGBRAIN_API_URL: "https://api.example.test/base",
      ORGBRAIN_API_KEY: "secret",
      ORGBRAIN_TENANT_ID: "tenant-a",
      ORGBRAIN_PROJECT_ID: "project-a"
    },
    fetchImpl
  });

  assert.deepEqual(result, {
    activity_events: 0,
    graph_nodes: 0,
    strata_chains: 1,
    strata_detail_checked: true
  });
  assert.equal(requests.length, 4);
  assert.match(requests[3].url, /\/base\/v1\/dashboard\/strata\/memory\/m%2F1/u);
  assert.ok(requests.every((request) => request.url.includes("tenant_id=tenant-a")));
  assert.ok(requests.every((request) => request.headers["x-api-key"] === "secret"));
});

test("dashboard live smoke rejects sensitive response fields", async () => {
  await assert.rejects(
    runDashboardLiveSmoke({
      env: {
        ORGBRAIN_API_URL: "https://api.example.test",
        ORGBRAIN_API_KEY: "secret",
        ORGBRAIN_TENANT_ID: "tenant-a"
      },
      fetchImpl: async () => response({ events: [{ payload: { secret: true } }] })
    }),
    /forbidden field data\.events\[0\]\.payload/u
  );
});
