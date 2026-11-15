import { tokyoDateTimeLocalToIso } from "./format-date";
import { queryHref } from "./query-href";

export function parseLines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

export function optionalText(formData: FormData, name: string): string | null {
  const value = String(formData.get(name) ?? "").trim();
  return value || null;
}

export function optionalDateTime(formData: FormData, name: string): string | null {
  const value = optionalText(formData, name);
  return value ? tokyoDateTimeLocalToIso(value) : null;
}

export function sourceRowError(url: string, updatedAt: string, hasContent: boolean): "invalidUrl" | "invalidDate" | null {
  let error: "invalidUrl" | "invalidDate" | null = null;
  if (url) {
    try { new URL(url); } catch { error = "invalidUrl"; }
  }
  if (hasContent && updatedAt && Number.isNaN(Date.parse(updatedAt))) error = "invalidDate";
  return error;
}

export function decisionEditorHref(url: URL, id: string, tenantId: string, projectId: string | null): string {
  return queryHref(url, url.searchParams, {
    tenant_id: tenantId || "default", project_id: projectId, selected: id, mode: null, view: "editor"
  });
}
