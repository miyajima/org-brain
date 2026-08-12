import { describe, expect, it } from "vitest";
import { dashboardLabel, dashboardLabelPair, dashboardStatusTone, memoryDisplayCopy } from "./dashboard-copy";

describe("dashboard display copy", () => {
  it("translates known operational values for Japanese users", () => {
    expect(dashboardLabel("status", "failed", "ja")).toBe("失敗");
    expect(dashboardLabel("status", "ready", "ja")).toBe("利用可能");
    expect(dashboardLabel("capability", "memory_measurement", "ja")).toBe("記憶品質測定");
    expect(dashboardLabel("relation", "derived_from", "ja")).toBe("根拠");
    expect(dashboardLabel("permission", "task:replay", "ja")).toBe("Taskの再実行");
    expect(dashboardLabel("signal", "task_failed", "ja")).toBe("Taskの失敗");
    expect(dashboardLabel("event", "task.failed", "ja")).toBe("Taskの失敗");
  });

  it("keeps unknown values available as internal values", () => {
    expect(dashboardLabelPair("status", "custom_state", "ja")).toEqual({ label: "custom_state", raw: "custom_state" });
    expect(dashboardLabel("status", "failed", "en")).toBe("failed");
  });

  it("classifies status severity without relying on color alone", () => {
    expect(dashboardStatusTone("succeeded")).toBe("healthy");
    expect(dashboardStatusTone("failed")).toBe("critical");
    expect(dashboardStatusTone("stale")).toBe("warning");
    expect(dashboardStatusTone("unknown")).toBe("neutral");
  });

  it("separates internal memory routing context from the readable title", () => {
    expect(memoryDisplayCopy("org-brain | diagnosis | API Gatewayの確認", "API Gatewayの確認内容です")).toEqual({
      title: "API Gatewayの確認",
      context: "org-brain · diagnosis",
      preview: "API Gatewayの確認内容です",
      rawLabel: "org-brain | diagnosis | API Gatewayの確認"
    });
  });

  it("falls back to the memory content when a summary is missing", () => {
    expect(memoryDisplayCopy(null, "実際に読むべきメモの本文").title).toBe("実際に読むべきメモの本文");
  });
});
