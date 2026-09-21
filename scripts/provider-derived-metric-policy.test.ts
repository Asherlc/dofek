import { describe, expect, it } from "vitest";
import { findProviderDerivedMetricViolations } from "./provider-derived-metric-policy.ts";

describe("provider-derived-metric-policy", () => {
  it("rejects provider-derived values in canonical writes", () => {
    const source = `
      dailyMetrics.stressHighMinutes = parsed.stressHighMinutes;
      values({ stress: sample.stressLevel });
      sleepNeedBaselineMinutes: parsed.sleepNeedBaselineMinutes,
      type: "oura_daily_resilience",
      eventType: "oura_sleep_time",
    `;

    expect(findProviderDerivedMetricViolations(source, "provider.ts")).toEqual([
      "provider.ts:2: canonical provider-derived field stressHighMinutes",
      "provider.ts:3: canonical provider-derived stress channel",
      "provider.ts:4: canonical provider-derived field sleepNeedBaselineMinutes",
      "provider.ts:5: canonical provider-derived health event",
      "provider.ts:6: canonical provider-derived health event",
    ]);
  });

  it("allows provider-derived fields inside raw provenance", () => {
    const source = `raw: { trainingStressScore: value, normalizedPower: value }`;

    expect(findProviderDerivedMetricViolations(source, "provider.ts")).toEqual([]);
  });

  it("rejects provider-derived SQL column writes", () => {
    expect(
      findProviderDerivedMetricViolations(
        "daily_metrics.stress_high_minutes = parsed.value;",
        "fixture.ts",
      ),
    ).toHaveLength(1);
  });
});
