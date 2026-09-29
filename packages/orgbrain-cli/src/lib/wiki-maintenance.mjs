import { wikiStatus } from "./wiki-service.mjs";

export async function wikiMaintenanceContext(service, payload = {}) {
  const status = await wikiStatus(service.config);
  if (!status.enabled || !status.auto_maintenance)
    return {
      context: "",
      reason: !status.enabled ? "feature_disabled" : "maintenance_disabled",
    };
  if (
    ["plan", "ask", "read-only", "readonly"].includes(
      String(payload.mode || "").toLowerCase(),
    ) ||
    payload.read_only === true ||
    payload.no_save === true
  )
    return { context: "", reason: "user_mode" };
  return {
    context:
      "OrgBrain Knowledge Wiki (personal) maintenance is enabled. For a substantive task with reusable source-backed findings, use orgbrain_wiki_search, ingest explicitly selected originals, read relevant pages, then put or patch with the read hash. Validate citations and review orgbrain_wiki_diagnose. Keep confirmed decisions in OrgBrain memory, not duplicated Wiki authority. Do not read transcripts, start another LLM, download models, bypass native permissions, publish, sync, or write an external Wiki. Plan/Ask/read-only/no-save and narrower user instructions take precedence. Feature-disabled responses stop Wiki work. Run the workflow once and name only pages actually updated.",
    wiki_id: "personal",
  };
}
