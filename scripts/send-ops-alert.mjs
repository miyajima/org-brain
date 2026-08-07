#!/usr/bin/env node

import { opsAlertUlid } from "./ops-alert-id.mjs";

const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL?.trim();
if (!webhookUrl) {
  process.stderr.write("OPS_ALERT_WEBHOOK_URL is not configured; skipping alert\n");
  process.exit(0);
}
const severity = process.env.OPS_ALERT_SEVERITY?.trim() || "critical";
const title = process.env.OPS_ALERT_TITLE?.trim() || "OrgBrain operation failed";
const summary = process.env.OPS_ALERT_SUMMARY?.trim() || title;
const payload = {
  schema_version: 1,
  event_id: opsAlertUlid(),
  alert_key: process.env.OPS_ALERT_KEY?.trim() || "github-operation",
  status: "firing",
  severity,
  title,
  summary,
  observed_at: Date.now(),
  details: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    run_id: process.env.GITHUB_RUN_ID ?? null,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? null
  },
  text: `[${severity}] ${title}`
};
const response = await fetch(webhookUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
});
if (!response.ok) throw new Error(`ops alert webhook returned HTTP ${response.status}`);
