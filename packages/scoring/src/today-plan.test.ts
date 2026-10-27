import { buildTodayPlan, formatTodayPlanFreshness } from "./today-plan.ts";

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
      epistemicStatus: { kind: "unavailable", label: "Unavailable" },
      date: "2026-07-26",
      action: null,
      supportingFacts: [],
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

    expect(plan.epistemicStatus).toEqual({ kind: "suggested", label: "Suggested" });
    expect(plan.action).toEqual({
      id: "strain_target",
      title: "Suggested strain: 16.2",
      zone: "Push",
    });
    expect(plan.supportingFacts).toEqual([
      { label: "Recovery", value: "82/100" },
      { label: "Sleep performance", value: "88 (Good)" },
    ]);
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
        readinessScore: 60,
        workloadRatio: 1.12,
      },
      sleepPerformanceScore: null,
      sleepPerformanceTier: null,
      recoveryDate: "2026-07-26",
      sleepDate: null,
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.action.title).toBe("Suggested strain: 12");
    expect(plan.action.zone).toBe("Maintain");
    expect(plan.supportingFacts).toEqual([
      { label: "Recovery", value: "60/100" },
      { label: "Recent-to-baseline workload ratio", value: "1.12" },
    ]);
    expect(plan.missingInputs).toEqual(["sleep"]);
    expect(plan.caveats).toEqual([
      "Sleep performance was unavailable; recent workload is shown for context.",
    ]);
  });

  it("builds a Recovery-zone action with dated observations", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 6.5,
        zone: "Recovery",
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

    expect(plan.action.title).toBe("Suggested strain: 6.5");
    expect(plan.action.zone).toBe("Recovery");
    expect(plan.supportingFacts[1]).toEqual({
      label: "Sleep performance",
      value: "55 (Fair)",
    });
  });

  it("shows the available recovery observation when sleep and workload are missing", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 11,
        zone: "Maintain",
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

    expect(plan.supportingFacts).toEqual([{ label: "Recovery", value: "55/100" }]);
    expect(plan.missingInputs).toEqual(["sleep"]);
    expect(plan.caveats).toEqual([
      "Sleep and recent workload data were unavailable, so this suggestion uses recovery only.",
    ]);
  });

  it("explains unknown recovery recency", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 8,
        zone: "Recovery",
        readinessScore: 45,
        workloadRatio: 0.8,
      },
      sleepPerformanceScore: 75,
      sleepPerformanceTier: "Good",
      recoveryDate: null,
      sleepDate: "2026-07-26",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;
    expect(plan.caveats).toEqual(["Recovery data has no date; its recency is unknown."]);
  });

  it("does not mark recovery or sleep data from the plan date as stale", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 14,
        zone: "Push",
        readinessScore: 80,
        workloadRatio: 1.1,
      },
      sleepPerformanceScore: 90,
      sleepPerformanceTier: "Excellent",
      recoveryDate: "2026-07-26",
      sleepDate: "2026-07-26",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.caveats).toEqual([]);
  });

  it("does not add a sleep caveat when sleep has no date", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 10,
        zone: "Maintain",
        readinessScore: 65,
        workloadRatio: 1,
      },
      sleepPerformanceScore: 78,
      sleepPerformanceTier: "Good",
      recoveryDate: "2026-07-26",
      sleepDate: null,
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.caveats).toEqual([]);
  });

  it("reports when sleep data is stale", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 12,
        zone: "Maintain",
        readinessScore: 65,
        workloadRatio: 1,
      },
      sleepPerformanceScore: 78,
      sleepPerformanceTier: "Good",
      recoveryDate: "2026-07-26",
      sleepDate: "2026-07-24",
    });

    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") return;

    expect(plan.caveats).toEqual([
      "Sleep data is from 2026-07-24, so it may not reflect the latest night.",
    ]);
  });

  it("returns server-authored caveats for missing and stale inputs", () => {
    const plan = buildTodayPlan({
      endDate: "2026-07-26",
      strainTarget: {
        targetStrain: 6.5,
        zone: "Recovery",
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
        "Sleep and recent workload data were unavailable, so this suggestion uses recovery only.",
        "Recovery data is from 2026-07-23, so this plan may be less current.",
      ],
    });
  });
});

describe("Today Plan presentation helpers", () => {
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
