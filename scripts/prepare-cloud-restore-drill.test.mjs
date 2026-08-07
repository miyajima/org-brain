import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareCloudRestoreConfig } from "./prepare-cloud-restore-drill.mjs";

test("prepareCloudRestoreConfig resolves D1 UUIDs into an ephemeral Wrangler config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-cloud-restore-"));
  const databasesJson = join(directory, "databases.json");
  const output = join(directory, "wrangler.toml");
  await writeFile(databasesJson, JSON.stringify([
    { name: "open-brain-staging", uuid: "source-uuid" },
    { name: "drill-123", uuid: "drill-uuid" }
  ]));
  const result = await prepareCloudRestoreConfig({
    databasesJson,
    sourceName: "open-brain-staging",
    drillName: "drill-123",
    output
  });
  const config = await readFile(output, "utf8");
  assert.equal(result.source.uuid, "source-uuid");
  assert.equal(result.drill.uuid, "drill-uuid");
  assert.match(config, /binding = "SOURCE_DB"[\s\S]*database_id = "source-uuid"/u);
  assert.match(config, /binding = "DRILL_DB"[\s\S]*database_id = "drill-uuid"/u);
});

test("prepareCloudRestoreConfig fails before any restore when the source is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orgbrain-cloud-restore-"));
  const databasesJson = join(directory, "databases.json");
  await writeFile(databasesJson, "[]");
  await assert.rejects(prepareCloudRestoreConfig({
    databasesJson,
    sourceName: "missing",
    drillName: null,
    output: join(directory, "wrangler.toml")
  }), /source D1 database not found/u);
});

test("cloud restore workflow resolves UUIDs and cleans up only a created drill database", async () => {
  const workflow = await readFile(new URL("../.github/workflows/cloud-restore-drill.yml", import.meta.url), "utf8");
  assert.ok(
    workflow.indexOf("Require staging credentials") < workflow.indexOf("pnpm install --frozen-lockfile"),
    "credential preflight must happen before dependency installation"
  );
  assert.match(workflow, /wrangler d1 list --json/u);
  assert.match(workflow, /prepare-cloud-restore-drill\.mjs/u);
  assert.match(workflow, /always\(\) && steps\.create-drill\.outputs\.created == 'true'/u);
  assert.match(workflow, /if: failure\(\)[\s\S]*send-ops-alert\.mjs/u);
});

test("hourly watchdog workflow exposes dispatch and the required secrets", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ops-watchdog.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /cron: "17 \* \* \* \*"/u);
  for (const secret of ["ORGBRAIN_API_URL", "ORGBRAIN_WATCHDOG_TOKEN", "OPS_ALERT_WEBHOOK_URL"]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`, "u"));
  }
  assert.match(workflow, /node scripts\/ops-watchdog\.mjs/u);
});
