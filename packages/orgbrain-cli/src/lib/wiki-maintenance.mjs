import { wikiStatus } from "./wiki-service.mjs";

const STATIC_MARKER_CHARS = 80;

export async function wikiMaintenanceContext(service, payload = {}, env = process.env) {
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
  const context = WIKI_MAINTENANCE_GUIDANCE;
  // Opt-in: a prompt hook need not repeat guidance that is still in a developer
  // message after the latest compaction. Without that evidence it is delivered.
  if (String(env?.ORGBRAIN_HOOK_STATIC_INSTRUCTIONS ?? "").trim().toLowerCase() === "once"
    && (payload.hook_event_name ?? payload.hookEventName) === "UserPromptSubmit") {
    const { deliveredStaticInstructions } = await import("./hook-static-instructions.mjs");
    const marker = context.slice(0, STATIC_MARKER_CHARS);
    if ((await deliveredStaticInstructions(payload, [marker])).has(marker)) return { context: "", reason: "already_delivered" };
  }
  return {
    context,
    wiki_id: "personal",
  };
}

const WIKI_MAINTENANCE_GUIDANCE =
  "OrgBrain Knowledge Wiki (personal) maintenance is enabled. For a substantive task with reusable source-backed findings, use orgbrain_wiki_search, ingest explicitly selected originals, read relevant pages, then put or patch with the read hash. Validate citations and review orgbrain_wiki_diagnose. Keep confirmed decisions in OrgBrain memory, not duplicated Wiki authority. During Wiki maintenance, do not read transcripts, start another LLM, download models, publish, sync, or write an external Wiki. These restrictions apply to operations undertaken for Wiki maintenance; they do not add restrictions to separate tasks explicitly requested by the user. Separate tasks remain subject to their own applicable instructions and permissions. Never bypass native permissions. Plan/Ask/read-only/no-save and narrower user instructions take precedence. Feature-disabled responses stop Wiki work. Run the workflow once and name only pages actually updated.";
