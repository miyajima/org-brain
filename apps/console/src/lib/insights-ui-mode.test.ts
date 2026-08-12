import { describe, expect, it } from "vitest";
import {
  insightsUiBehavior,
  normalizeInsightsUiMode,
  resolveInsightsUiMode,
  resolveRequestInsightsUiMode
} from "./insights-ui-mode";

describe("insights UI mode", () => {
  it("defaults unknown and missing values to off", () => {
    expect(normalizeInsightsUiMode(undefined)).toBe("off");
    expect(normalizeInsightsUiMode("preview")).toBe("off");
  });

  it("accepts beta and on", () => {
    expect(normalizeInsightsUiMode("beta")).toBe("beta");
    expect(normalizeInsightsUiMode("on")).toBe("on");
  });

  it("prefers Cloudflare runtime env over direct and process fallbacks", () => {
    expect(resolveInsightsUiMode({ runtime: { env: { INSIGHTS_UI_MODE: "on" } }, env: { INSIGHTS_UI_MODE: "beta" } }, "off")).toBe("on");
    expect(resolveInsightsUiMode({ env: { INSIGHTS_UI_MODE: "beta" } }, "on")).toBe("beta");
    expect(resolveInsightsUiMode({}, "on")).toBe("on");
  });

  it("survives the removed Astro 6 locals.runtime.env getter", async () => {
    const locals = {
      runtime: {
        get env(): never {
          throw new Error("Astro.locals.runtime.env has been removed");
        }
      }
    };
    expect(resolveInsightsUiMode(locals, "beta")).toBe("beta");
    await expect(resolveRequestInsightsUiMode(locals, "on")).resolves.toBe("on");
  });

  it.each([
    ["off", { enableInsightsRoutes: false, renderInsightsHome: false, useInsightsNavigation: false, showOverviewLab: false, showLegacyDashboard: false }],
    ["beta", { enableInsightsRoutes: true, renderInsightsHome: false, useInsightsNavigation: true, showOverviewLab: true, showLegacyDashboard: false }],
    ["on", { enableInsightsRoutes: true, renderInsightsHome: true, useInsightsNavigation: true, showOverviewLab: false, showLegacyDashboard: true }]
  ] as const)("keeps %s route and navigation behavior aligned", (mode, expected) => {
    expect(insightsUiBehavior(mode)).toEqual(expected);
  });
});
