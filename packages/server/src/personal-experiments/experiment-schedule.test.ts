import { describe, expect, it } from "vitest";
import { resolveExperimentSchedule, resolveOutcomeMetricLabel } from "./experiment-schedule.ts";

describe("resolveOutcomeMetricLabel", () => {
  it("returns the catalog label for a known correlation metric id", () => {
    expect(resolveOutcomeMetricLabel("hrv")).toBe("Heart Rate Variability");
  });

  it("falls back to the metric id when the catalog has no match", () => {
    expect(resolveOutcomeMetricLabel("unknown_metric")).toBe("unknown_metric");
  });
});

describe("resolveExperimentSchedule", () => {
  const base = {
    startDate: "2026-07-01",
    baselineDays: 7,
    interventionDays: 14,
    status: "active" as const,
    stoppedAt: null,
  };

  it("reports upcoming when the start date is still in the future", () => {
    const schedule = resolveExperimentSchedule({ ...base, today: "2026-06-30" });

    expect(schedule.phase).toBe("upcoming");
    expect(schedule.phaseLabel).toBe("Upcoming");
    expect(schedule.dayInPhase).toBeNull();
    expect(schedule.daysRemainingInPhase).toBeNull();
    expect(schedule.scheduleSummary).toBe("Starts on 2026-07-01");
  });

  it("reports baseline phase dates and remaining days during baseline", () => {
    const schedule = resolveExperimentSchedule({ ...base, today: "2026-07-03" });

    expect(schedule).toEqual({
      phase: "baseline",
      phaseLabel: "Baseline",
      baselineStartDate: "2026-07-01",
      baselineEndDate: "2026-07-07",
      interventionStartDate: "2026-07-08",
      interventionEndDate: "2026-07-21",
      dayInPhase: 3,
      daysRemainingInPhase: 5,
      scheduleSummary: "Day 3 of baseline (5 days remaining)",
    });
  });

  it("reports intervention phase after the baseline window", () => {
    const schedule = resolveExperimentSchedule({ ...base, today: "2026-07-10" });

    expect(schedule.phase).toBe("intervention");
    expect(schedule.phaseLabel).toBe("Intervention");
    expect(schedule.dayInPhase).toBe(3);
    expect(schedule.daysRemainingInPhase).toBe(12);
    expect(schedule.scheduleSummary).toBe("Day 3 of intervention (12 days remaining)");
  });

  it("reports complete once the intervention window has ended", () => {
    const schedule = resolveExperimentSchedule({ ...base, today: "2026-07-22" });

    expect(schedule.phase).toBe("complete");
    expect(schedule.phaseLabel).toBe("Complete");
    expect(schedule.dayInPhase).toBeNull();
    expect(schedule.daysRemainingInPhase).toBeNull();
    expect(schedule.scheduleSummary).toBe("Experiment schedule finished on 2026-07-21");
  });

  it("reports stopped when the experiment status is stopped", () => {
    const schedule = resolveExperimentSchedule({
      ...base,
      status: "stopped",
      stoppedAt: "2026-07-05",
      today: "2026-07-10",
    });

    expect(schedule.phase).toBe("stopped");
    expect(schedule.phaseLabel).toBe("Stopped");
    expect(schedule.dayInPhase).toBeNull();
    expect(schedule.daysRemainingInPhase).toBeNull();
    expect(schedule.scheduleSummary).toBe("Stopped on 2026-07-05");
  });

  it("uses singular day wording on the final baseline day", () => {
    const schedule = resolveExperimentSchedule({ ...base, today: "2026-07-07" });

    expect(schedule.dayInPhase).toBe(7);
    expect(schedule.daysRemainingInPhase).toBe(1);
    expect(schedule.scheduleSummary).toBe("Day 7 of baseline (1 day remaining)");
  });
});
