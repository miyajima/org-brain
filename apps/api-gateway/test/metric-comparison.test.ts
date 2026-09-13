import { describe, expect, it } from "vitest";
import { compareMetric } from "../src/metric-comparison";

describe("metric comparison", () => {
  it.each([
    ["increase", { direction: "increase", value: 10, min: null, max: null }, 10],
    ["decrease", { direction: "decrease", value: 10, min: null, max: null }, 10],
    ["range minimum", { direction: "range", value: null, min: 10, max: 20 }, 10],
    ["range maximum", { direction: "range", value: null, min: 10, max: 20 }, 20]
  ] as const)("includes the %s target boundary", (_label, target, current) => {
    expect(compareMetric(current, null, target)).toMatchObject({ target_state: "on_track", distance_to_target: 0 });
  });

  it("uses distance to the target for trend in every direction", () => {
    expect(compareMetric(8, 7, { direction: "increase", value: 10, min: null, max: null }).trend).toBe("improving");
    expect(compareMetric(12, 13, { direction: "decrease", value: 10, min: null, max: null }).trend).toBe("improving");
    expect(compareMetric(14, 13, { direction: "maintain", value: 15, min: null, max: null }).trend).toBe("improving");
  });
});
