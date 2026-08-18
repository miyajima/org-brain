import type { RouteAuditCase } from "../src/lib/admin-ui";

const allLocales = ["en", "ja", "zh"] as const;

export const routeAuditCases: RouteAuditCase[] = [
  { path: "/overview", states: ["ready", "healthy", "attention"], locales: [...allLocales], keyboardFlow: ["navigation", "recommended-action"] },
  { path: "/memories/constellation", states: ["ready", "fallback", "partial", "error"], locales: [...allLocales], keyboardFlow: ["node-search", "node-selection", "decision-trace"] },
  { path: "/decisions/history", states: ["ready", "empty", "partial", "error"], locales: [...allLocales], keyboardFlow: ["review", "current-content", "evidence", "comparison"] },
  { path: "/tasks", states: ["ready", "empty", "error"], locales: [...allLocales], keyboardFlow: ["task-selection"] },
  { path: "/tasks/task-failed", states: ["attention", "error"], locales: [...allLocales], keyboardFlow: ["cause", "replay", "operations"] },
  { path: "/tasks/new", states: ["ready", "error"], locales: [...allLocales], keyboardFlow: ["task-create"] },
  { path: "/memories", states: ["ready", "empty", "error"], locales: [...allLocales], keyboardFlow: ["search", "memory-selection"] },
  { path: "/memory-impact", states: ["ready", "empty", "error"], locales: [...allLocales], keyboardFlow: ["scope", "period"] },
  { path: "/decisions", states: ["ready", "empty", "error"], locales: [...allLocales], keyboardFlow: ["decision-selection", "evidence"] },
  { path: "/resources", states: ["ready", "empty", "error"], locales: [...allLocales], keyboardFlow: ["resource-search"] },
  { path: "/groups", states: ["ready", "empty", "error"], locales: [...allLocales], keyboardFlow: ["group-create", "group-selection"] },
  { path: "/groups/group-e2e", states: ["ready", "error"], locales: [...allLocales], keyboardFlow: ["member-update", "back"] },
  { path: "/users", states: ["ready", "empty", "error", "success"], locales: [...allLocales], keyboardFlow: ["invite", "access-update"] },
  { path: "/organization", states: ["ready", "empty", "error", "success"], locales: [...allLocales], keyboardFlow: ["organization-update", "ownership-mapping"] },
  { path: "/business-categories", states: ["ready", "empty", "error"], locales: [...allLocales], keyboardFlow: ["category-create"] },
  { path: "/client-installations", states: ["ready", "empty", "error"], locales: [...allLocales], keyboardFlow: ["installation-create", "token-revoke"] },
  { path: "/operations", states: ["healthy", "attention", "error"], locales: [...allLocales], keyboardFlow: ["failed-task", "scheduled-job"] },
  { path: "/profile", states: ["ready", "error", "success"], locales: [...allLocales], keyboardFlow: ["profile-update", "producer-mapping"] }
];

export const primaryFlowPaths = [
  "/overview",
  "/users",
  "/tasks/task-failed",
  "/decisions/history",
  "/memories/constellation"
] as const;

export function auditUrl(path: string, locale: "en" | "ja" | "zh" = "ja") {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}tenant_id=default&project_id=org-brain&lang=${locale}`;
}
