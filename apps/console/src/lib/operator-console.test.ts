import { describe, expect, it } from "vitest";
import { operatorScope, operatorHref, operatorRequestUrl, metricValue, knowledgeRows, readConsoleData, legacyConsoleDestination, safeExternalHref } from "./operator-console";

describe("operator console", () => {
  it("keeps scope and language, drops the previous selection when changing projects", () => {
    const url = new URL("https://console.example/knowledge?tenant_id=team&project_id=old&lang=ja&q=review&id=private&kind=memory");
    expect(operatorHref(url, "/knowledge", { project_id: "new" })).toBe("/knowledge?tenant_id=team&lang=ja&project_id=new");
    expect(operatorScope(new URL("https://console.example/")).lang).toBe("ja");
  });
  it("keeps a cookie-selected tenant in navigation even without a URL parameter", () => {
    const request = new Request("https://console.example/knowledge", { headers: {cookie:"orgbrain_tenant=team"} });
    expect(operatorHref(operatorRequestUrl(request), "/settings")).toContain("tenant_id=team");
  });
  it("does not turn missing or unmeasured values into measured zero", () => {
    expect(metricValue(undefined)).toBe(null);
    expect(metricValue(null)).toBe(null);
    expect(metricValue(0)).toBe(0);
    expect(metricValue(12, "unknown")).toBe(null);
    expect(metricValue(12, "stale")).toBe(null);
    expect(metricValue(12, "verified")).toBe(12);
  });
  it("keeps different knowledge types separate even if identifiers overlap", () => {
    const memory = knowledgeRows("memory", { items: [{ id: "same", summary: "Remember this", content: "Full text" }] });
    const decision = knowledgeRows("decision", { items: [{ id: "same", conclusion: "Choose this", reason_summary: "A reason" }] });
    expect(memory[0]).toMatchObject({ kind: "memory", id: "same", title: "Remember this" });
    expect(decision[0]).toMatchObject({ kind: "decision", id: "same", title: "Choose this" });
  });
  it("reports HTTP, invalid JSON and transport failures without empty-success substitution", async () => {
    const request = new Request("https://console.example/");
    const fail = await readConsoleData(request, "/api/v1/memories", {}, async () => new Response("no", { status: 503 }));
    expect(fail.data).toBe(null); expect(fail.error).toContain("503");
    const invalid = await readConsoleData(request, "/api/v1/memories", {}, async () => new Response("not json"));
    expect(invalid.error).toBeTruthy();
    const offline = await readConsoleData(request, "/api/v1/memories", {}, async () => { throw new Error("secret transport detail"); });
    expect(offline.error).toBeTruthy(); expect(offline.error).not.toContain("secret");
  });
  it("maps existing bookmarks to the same record, with scope preserved", () => {
    expect(legacyConsoleDestination(new URL("https://console.example/memories?selected=m1&tenant_id=team&project_id=p&lang=zh"))).toBe("/knowledge?selected=m1&tenant_id=team&project_id=p&lang=zh&kind=memory&id=m1");
    expect(legacyConsoleDestination(new URL("https://console.example/decisions/d1?tenant_id=t"))).toBe("/knowledge?tenant_id=t&kind=decision&id=d1");
    expect(legacyConsoleDestination(new URL("https://console.example/api/v1/memories"))).toBe(null);
  });
  it("keeps the project-free goals alias on the goals view",()=>{
    expect(legacyConsoleDestination(new URL("https://console.example/knowledge-dashboard?lang=ja"))).toBe("/?lang=ja&view=goals");
  });
  it("keeps the legacy task-dashboard alias on processing with its filters",()=>{
    expect(legacyConsoleDestination(new URL("https://console.example/dashboard?lang=ja&task_q=memory"))).toBe("/settings?lang=ja&task_q=memory&section=operations");
  });
  it("does not make executable or local source URIs clickable", () => {
    expect(safeExternalHref("javascript:alert(1)")).toBe(null);
    expect(safeExternalHref("file:///private/source")).toBe(null);
    expect(safeExternalHref("https://example.com/source")).toBe("https://example.com/source");
  });
});
