import { describe, expect, it } from "vitest";
import { formatHealthStatusLabel } from "./health-status.ts";

describe("formatHealthStatusLabel", () => {
  it.each([
    { intent: "lower" as const, goal: "Weight loss goal" },
    { intent: "higher" as const, goal: "Weight gain goal" },
    { intent: "maintain" as const, goal: "Weight maintenance goal" },
  ])("preserves the server interpretation and $intent weight goal", ({ intent, goal }) => {
    expect(
      formatHealthStatusLabel({
        metric: "trend_weight",
        statusLabel: "Server interpretation",
        intent,
      }),
    ).toBe(`Server interpretation · ${goal}`);
  });

  it("preserves a weight interpretation when no weight goal is set", () => {
    expect(
      formatHealthStatusLabel({
        metric: "trend_weight",
        statusLabel: "Near baseline",
        intent: "neutral",
      }),
    ).toBe("Near baseline");
  });

  it("preserves other metrics' server interpretations", () => {
    expect(
      formatHealthStatusLabel({
        metric: "hrv",
        statusLabel: "Moving as intended",
        intent: "higher",
      }),
    ).toBe("Moving as intended");
  });
});
