import { describe, expect, it } from "vitest";
import {
  decisionConsoleBehavior,
  normalizeDecisionConsoleMode,
  resolveDecisionConsoleMode,
  resolveRequestDecisionConsoleMode
} from "./decision-console-mode";

describe("decision console mode", () => {
  it("fails closed for missing and unknown values", () => {
    expect(normalizeDecisionConsoleMode(undefined)).toBe("off");
    expect(normalizeDecisionConsoleMode("preview")).toBe("off");
  });

  it("accepts beta and on", () => {
    expect(normalizeDecisionConsoleMode("beta")).toBe("beta");
    expect(normalizeDecisionConsoleMode("on")).toBe("on");
  });

  it("prefers request runtime values", () => {
    expect(resolveDecisionConsoleMode({ runtime: { env: { DECISION_CONSOLE_MODE: "on" } } }, "off")).toBe("on");
    expect(resolveDecisionConsoleMode({ env: { DECISION_CONSOLE_MODE: "beta" } }, "on")).toBe("beta");
  });

  it("survives a throwing legacy runtime getter", async () => {
    const locals = { runtime: { get env(): never { throw new Error("removed"); } } };
    await expect(resolveRequestDecisionConsoleMode(locals, "beta")).resolves.toBe("beta");
  });

  it.each([
    ["off", { enabled: false, renderDecisionHome: false, useDecisionNavigation: false, showBetaLabel: false }],
    ["beta", { enabled: true, renderDecisionHome: true, useDecisionNavigation: true, showBetaLabel: true }],
    ["on", { enabled: true, renderDecisionHome: true, useDecisionNavigation: true, showBetaLabel: false }]
  ] as const)("keeps %s behavior aligned", (mode, expected) => {
    expect(decisionConsoleBehavior(mode)).toEqual(expected);
  });
});
