import {
  buildTodayPlan,
  formatTodayPlanConfidence,
  formatTodayPlanFreshness,
} from "./today-plan.ts";

describe("buildTodayPlan", () => {
  it("returns insufficient_data when readiness/strain target is missing", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: null,
      sleepPerformanceScore: null,
      sleepPerformanceTier: null,
      recoveryDate: null,
      sleepDate: null,
    });

    expect(plan).toEqual({
      status: "insufficient_data",
      date: "2026-07-26",
      action: null,
      supportingFacts: [],
      confidence: "low",
      freshness: {
        recoveryDate: null,
        sleepDate: null,
      },
      missingInputs: ["recovery"],
      message:
        "Connect a recovery source and wait for today's recovery score before a training plan can be generated.",
    });
  });

  it("builds a Push-zone action with readiness and sleep supporting facts", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 16.2,
        zone: "Push",
        explanation: "Recovery is strong (82). Push for a high-strain day to build fitness.",
        readinessScore: 82,
        workloadRatio: 0.95,
      },
      sleepPerformanceScore: 88,
      sleepPerformanceTier: "Good",
      recoveryDate: "2026-07-26",
      sleepDate: "2026-07-26",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.action).toEqual({
      id: "strain_target",
      title: "Train hard today — aim for 16.2 strain",
      summary: "Recovery is strong (82). Push for a high-strain day to build fitness.",
      zone: "Push",
    });
    expect(plan.supportingFacts).toEqual([
      { label: "Recovery", value: "82/100" },
      { label: "Sleep performance", value: "88 (Good)" },
    ]);
    expect(plan.confidence).toBe("high");
    expect(plan.freshness).toEqual({
      recoveryDate: "2026-07-26",
      sleepDate: "2026-07-26",
    });
    expect(plan.missingInputs).toEqual([]);
  });

  it("uses workload ratio when sleep performance is unavailable", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 12,
        zone: "Maintain",
        explanation: "Moderate recovery (60). Aim for a steady training day.",
        readinessScore: 60,
        workloadRatio: 1.12,
      },
      sleepPerformanceScore: null,
      sleepPerformanceTier: null,
      recoveryDate: "2026-07-25",
      sleepDate: null,
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.action.title).toBe("No change needs attention — aim for 12 strain");
    expect(plan.action.zone).toBe("Maintain");
    expect(plan.supportingFacts).toEqual([
      { label: "Recovery", value: "60/100" },
      { label: "Recent-to-baseline workload ratio", value: "1.12" },
    ]);
    expect(plan.confidence).toBe("moderate");
    expect(plan.missingInputs).toEqual(["sleep"]);
  });

  it("builds a Recovery-zone action and low confidence when recovery is stale", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 6.5,
        zone: "Recovery",
        explanation: "Recovery is low (40). Keep it light and focus on restoration.",
        readinessScore: 40,
        workloadRatio: null,
      },
      sleepPerformanceScore: 55,
      sleepPerformanceTier: "Fair",
      recoveryDate: "2026-07-23",
      sleepDate: "2026-07-23",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.action.title).toBe("Keep training light today — aim for 6.5 strain");
    expect(plan.action.zone).toBe("Recovery");
    expect(plan.confidence).toBe("low");
    expect(plan.supportingFacts[1]).toEqual({
      label: "Sleep performance",
      value: "55 (Fair)",
    });
  });

  it("falls back to a generic second fact when sleep and workload are both missing", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 11,
        zone: "Maintain",
        explanation: "Moderate recovery (55). Aim for a steady training day.",
        readinessScore: 55,
        workloadRatio: null,
      },
      sleepPerformanceScore: null,
      sleepPerformanceTier: null,
      recoveryDate: "2026-07-26",
      sleepDate: null,
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.supportingFacts).toEqual([
      { label: "Recovery", value: "55/100" },
      { label: "Strain target", value: "11" },
    ]);
    expect(plan.missingInputs).toEqual(["sleep"]);
    expect(plan.confidence).toBe("moderate");
  });

  it("returns server-authored caveats for missing and stale inputs", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 6.5,
        zone: "Recovery",
        explanation: "Recovery is low (40). Keep it light and focus on restoration.",
        readinessScore: 40,
        workloadRatio: null,
      },
      sleepPerformanceScore: null,
      sleepPerformanceTier: null,
      recoveryDate: "2026-07-23",
      sleepDate: null,
    });

    expect(plan).toMatchObject({
      caveats: [
        "Sleep and recent workload data were unavailable, so this plan uses recovery and the strain target.",
        "Recovery data is from 2026-07-23, so this plan may be less current.",
      ],
    });
  });
});

describe("Today Plan presentation helpers", () => {
  it("formats confidence labels for clients", () => {
    expect(formatTodayPlanConfidence("high")).toBe("High confidence");
    expect(formatTodayPlanConfidence("moderate")).toBe("Moderate confidence");
    expect(formatTodayPlanConfidence("low")).toBe("Low confidence");
  });

  it("formats freshness summaries from recovery and sleep dates", () => {
    expect(
      formatTodayPlanFreshness({
        recoveryDate: "2026-07-26",
        sleepDate: "2026-07-26",
      }),
    ).toBe("Recovery data from 2026-07-26 · Sleep data from 2026-07-26");

    expect(
      formatTodayPlanFreshness({
        recoveryDate: "2026-07-26",
        sleepDate: null,
      }),
    ).toBe("Recovery data from 2026-07-26");

    expect(
      formatTodayPlanFreshness({
        recoveryDate: null,
        sleepDate: null,
      }),
    ).toBeNull();
  });
});
