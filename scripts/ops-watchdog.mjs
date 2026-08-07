#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { opsAlertUlid } from "./ops-alert-id.mjs";

function requireValue(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function sendFallbackAlert(fetchImpl, webhookUrl, error, now) {
  const payload = {
    schema_version: 1,
    event_id: opsAlertUlid(now),
    alert_key: "watchdog:api-check-failed",
    status: "firing",
    severity: "critical",
    title: "OrgBrain watchdog API check failed",
    summary: error instanceof Error ? error.message : String(error),
    observed_at: now,
    details: {},
    text: "[critical] OrgBrain watchdog API check failed"
  };
  const response = await fetchWithTimeout(fetchImpl, webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`fallback webhook returned HTTP ${response.status}`);
}

export async function runOpsWatchdogCheck(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const apiUrl = requireValue(env.ORGBRAIN_API_URL, "ORGBRAIN_API_URL").replace(/\/+$/u, "");
  const token = requireValue(env.ORGBRAIN_WATCHDOG_TOKEN, "ORGBRAIN_WATCHDOG_TOKEN");
  const webhookUrl = requireValue(env.OPS_ALERT_WEBHOOK_URL, "OPS_ALERT_WEBHOOK_URL");
  try {
    const response = await fetchWithTimeout(fetchImpl, `${apiUrl}/internal/ops/watchdog/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}"
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload?.error?.message || `watchdog API returned HTTP ${response.status}`;
      throw new Error(message);
    }
    if (payload?.ok !== true) throw new Error("watchdog API returned an invalid response");
    return payload;
  } catch (error) {
    try {
      await sendFallbackAlert(fetchImpl, webhookUrl, error, now);
    } catch (fallbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; fallback notification failed: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`
      );
    }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOpsWatchdogCheck()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
