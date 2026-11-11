import { describe, expect, it } from "vitest";
import { domainCapabilities } from "../src/domain-routes";
import { assertMetricsReadable, assertMetricsWritable } from "../src/domain-metric-service";
import { featureMode } from "../src/feature-mode";
import { isKnowledgeLoopWritable } from "../src/knowledge-loop-feature";
import type { Env } from "../src/types";

const env = (vars: Record<string, unknown>) => vars as unknown as Env;

describe("featureMode", () => {
  it("treats unset, blank and off as disabled and passes any other value through", () => {
    expect(featureMode(undefined)).toBe("off");
    expect(featureMode("")).toBe("off");
    expect(featureMode("   ")).toBe("off");
    expect(featureMode("off")).toBe("off");
    expect(featureMode(" off ")).toBe("off");
    expect(featureMode("shadow")).toBe("shadow");
    expect(featureMode("on")).toBe("on");
    expect(featureMode(" preview ")).toBe("preview");
  });
});

describe("feature flag policy", () => {
  it("reports blank flags as disabled in capabilities", () => {
    const capabilities = domainCapabilities(env({
      DOMAIN_PACKS_MODE: "", DOMAIN_METRICS_MODE: "  ", DOMAIN_WORKSPACES_MODE: "off", RETROSPECTIVE_MODE: "",
      METRIC_IMPORT_MODE: "preview"
    }), "t1") as Record<string, { mode: string; enabled: boolean }>;
    expect(capabilities.domain_packs).toMatchObject({ mode: "off", enabled: false });
    expect(capabilities.domain_metrics).toMatchObject({ mode: "off", enabled: false });
    expect(capabilities.domain_workspaces).toMatchObject({ mode: "off", enabled: false });
    expect(capabilities.retrospective).toMatchObject({ mode: "off", enabled: false });
    expect(capabilities.metric_import).toMatchObject({ mode: "preview", enabled: true });
  });

  it("disables domain metrics when the flag is unset or blank", () => {
    for (const value of [undefined, "", "off"]) {
      expect(() => assertMetricsReadable(env({ DOMAIN_METRICS_MODE: value }))).toThrowError(expect.objectContaining({ code: "domain_metrics_disabled" }));
    }
    expect(() => assertMetricsReadable(env({ DOMAIN_METRICS_MODE: "shadow" }))).not.toThrow();
    expect(() => assertMetricsWritable(env({ DOMAIN_METRICS_MODE: "shadow" }))).toThrowError(expect.objectContaining({ code: "domain_metrics_shadow" }));
    expect(() => assertMetricsWritable(env({ DOMAIN_METRICS_MODE: "on" }))).not.toThrow();
  });

  it("normalizes whitespace in knowledge loop writability", () => {
    expect(isKnowledgeLoopWritable(env({ METRIC_IMPORT_MODE: " on " }), "METRIC_IMPORT_MODE", "t1")).toBe(true);
  });
});
