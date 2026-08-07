import assert from "node:assert/strict";
import test from "node:test";
import { runOpsWatchdogCheck } from "./ops-watchdog.mjs";

const env = {
  ORGBRAIN_API_URL: "https://orgbrain.example/",
  ORGBRAIN_WATCHDOG_TOKEN: "watchdog-token",
  OPS_ALERT_WEBHOOK_URL: "https://hooks.example/ops"
};

test("watchdog accepts active alerts without failing the workflow", async () => {
  const calls = [];
  const result = await runOpsWatchdogCheck({
    env,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, active_alert_count: 2 }), { status: 200 });
    }
  });
  assert.equal(result.active_alert_count, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://orgbrain.example/internal/ops/watchdog/run");
  assert.equal(calls[0].init.headers.authorization, "Bearer watchdog-token");
});

test("watchdog sends a direct fallback alert when the API is unavailable", async () => {
  const calls = [];
  let fallbackPayload;
  await assert.rejects(
    runOpsWatchdogCheck({
      env,
      now: 123,
      fetchImpl: async (url, init) => {
        calls.push(url);
        if (String(url).includes("/internal/")) throw new Error("network unavailable");
        fallbackPayload = JSON.parse(init?.body ?? "null");
        return new Response("ok", { status: 200 });
      }
    }),
    /network unavailable/u
  );
  assert.deepEqual(calls, [
    "https://orgbrain.example/internal/ops/watchdog/run",
    "https://hooks.example/ops"
  ]);
  assert.match(fallbackPayload.event_id, /^[0-9A-HJKMNP-TV-Z]{26}$/u);
});

test("watchdog reports both the API and fallback webhook failure", async () => {
  await assert.rejects(
    runOpsWatchdogCheck({
      env,
      fetchImpl: async (url) => String(url).includes("/internal/")
        ? new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 })
        : new Response("no", { status: 500 })
    }),
    /unauthorized; fallback notification failed/u
  );
});
