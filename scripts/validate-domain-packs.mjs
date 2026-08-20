import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../domain-packs/first-party", import.meta.url));
const allowedAdapters = new Set([
  "github-actions", "observability", "incident-management", "crm",
  "product-analytics", "search-analytics", "commerce", "catalog"
]);
const allowedOperations = new Set(["count", "sum", "average", "ratio", "percentile", "duration", "distinct_count"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function unique(items, label) {
  invariant(new Set(items).size === items.length, `${label} must be unique`);
}

export async function validateDomainPacks() {
  const directories = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  invariant(directories.length === 4, "exactly four first-party Domain Packs are required");
  const results = [];
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(join(root, directory, "manifest.json"), "utf8"));
    invariant(manifest.contract_version === "domain-pack/v1", `${directory}: invalid contract_version`);
    invariant(manifest.classification === "function", `${directory}: first-party pack must be a function pack`);
    invariant(/^\d+\.\d+\.\d+/.test(manifest.version), `${directory}: invalid version`);
    invariant(Array.isArray(manifest.object_types) && manifest.object_types.length, `${directory}: object_types required`);
    invariant(Array.isArray(manifest.metrics) && manifest.metrics.length, `${directory}: metrics required`);
    invariant(Array.isArray(manifest.dashboards) && manifest.dashboards.length, `${directory}: dashboards required`);
    invariant(manifest.recall_profile && typeof manifest.recall_profile === "object", `${directory}: recall_profile required`);
    invariant(["standard", "high_assurance"].includes(manifest.recall_profile.risk_mode), `${directory}: invalid recall risk mode`);
    invariant(manifest.recall_profile.auto_recall_threshold >= 0.6, `${directory}: recall threshold too low`);
    invariant(manifest.recall_profile.object_type_keys.every((key) => manifest.object_types.some((item) => item.key === key)), `${directory}: recall object type missing from pack`);
    invariant([...manifest.recall_profile.primary_metric_keys, ...manifest.recall_profile.guardrail_metric_keys].every((key) => manifest.metrics.some((item) => item.key === key)), `${directory}: recall metric missing from pack`);
    if (manifest.recall_profile.risk_mode === "high_assurance") {
      invariant(manifest.recall_profile.auto_recall_threshold >= 0.72, `${directory}: high assurance threshold must be at least 0.72`);
      invariant(manifest.recall_profile.required_scope_keys.length > 0, `${directory}: high assurance scope keys required`);
    }
    unique(manifest.object_types.map((item) => item.key), `${directory}: object type keys`);
    unique(manifest.metrics.map((item) => item.key), `${directory}: metric keys`);
    unique(manifest.dashboards.map((item) => item.key), `${directory}: dashboard keys`);
    for (const connector of manifest.connectors ?? []) {
      invariant(allowedAdapters.has(connector.adapter_id), `${directory}: unregistered adapter ${connector.adapter_id}`);
    }
    for (const metric of manifest.metrics) {
      invariant(metric.origin_type === "pack", `${directory}/${metric.key}: origin_type must be pack`);
      invariant(["manual", "connector", "derived"].includes(metric.source_type), `${directory}/${metric.key}: invalid source`);
      if (metric.source_type === "connector") {
        invariant(allowedAdapters.has(metric.connector?.adapter_id), `${directory}/${metric.key}: unregistered connector`);
        invariant(/^[a-z0-9][a-z0-9._-]*$/u.test(metric.connector?.query_template ?? ""), `${directory}/${metric.key}: query_template must be a registered template ID, not SQL or code`);
      }
      if (metric.source_type === "derived") {
        invariant(allowedOperations.has(metric.formula?.operation), `${directory}/${metric.key}: unsafe derived operation`);
        invariant(Array.isArray(metric.formula?.metric_keys) && metric.formula.metric_keys.length, `${directory}/${metric.key}: derived inputs required`);
      }
      invariant(!("script" in metric) && !("sql" in metric) && !("code" in metric), `${directory}/${metric.key}: executable content is forbidden`);
    }
    for (const ref of manifest.example_refs ?? []) {
      const story = JSON.parse(await readFile(join(root, directory, ref), "utf8"));
      invariant(story.install_fixture === false, `${directory}: examples must never load during a normal install`);
      invariant(typeof story.story_id === "string" && typeof story.fixture_date === "string", `${directory}: fixed story ID and date required`);
      invariant(story.decision?.id, `${directory}: decision trace fixture required`);
      invariant(story.recall_fixture?.prompt && story.recall_fixture?.expected_decision_id === story.decision.id, `${directory}: recall fixture must target its Decision`);
      invariant(JSON.stringify(story.recall_fixture).length < 6 * 1024, `${directory}: recall fixture exceeds hook payload budget`);
      invariant(!/customer_(?:id|name)|contact_email|secret|token/iu.test(JSON.stringify(story.recall_fixture.scope ?? {})), `${directory}: recall scope contains forbidden customer or secret fields`);
    }
    const digest = createHash("sha256").update(JSON.stringify(canonical(manifest))).digest("hex");
    results.push({ directory, pack_id: manifest.pack_id, version: manifest.version, digest });
  }
  const pdm = JSON.parse(await readFile(join(root, "pdm-b2c", "manifest.json"), "utf8"));
  invariant(!pdm.metrics.some((metric) => metric.key === "quality_adjusted_activation_rate"), "custom metric must remain outside the PdM manifest");
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await validateDomainPacks();
  for (const result of results) process.stdout.write(`${result.pack_id}@${result.version} ${result.digest}\n`);
}
