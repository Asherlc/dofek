import { describe, expect, it } from "vitest";
import {
  buildMonthlyDecisionSynthesis,
  buildWeeklyDecisionSynthesis,
} from "./report-decision-synthesis.ts";

describe("buildWeeklyDecisionSynthesis", () => {
  it("turns current-versus-previous metrics into decision support without a causal claim", () => {
    const synthesis = buildWeeklyDecisionSynthesis(
      {
        weekStart: "2026-07-20",
        trainingHours: 6,
        activityCount: 4,
        avgDailyLoad: 80,
        avgSleepMinutes: 420,
        sleepPerformancePct: 95,
        avgReadiness: 0,
        avgRestingHr: 55,
        avgHrv: 48,
      },
      [
        {
          weekStart: "2026-07-13",
          trainingHours: 4,
          activityCount: 3,
          avgDailyLoad: 60,
          avgSleepMinutes: 450,
          sleepPerformancePct: 102,
          avgReadiness: 0,
          avgRestingHr: 54,
          avgHrv: 52,
        },
      ],
    );

    expect(synthesis.whatChanged).toEqual([
      "Training was 6 hours, 50% more than the previous week.",
      "Average nightly sleep was 7 hours, 30 minutes less than the previous week.",
    ]);
    expect(synthesis.likelyAssociations).toEqual([
      "Higher training coincided with less sleep and lower heart rate variability this week. This is a descriptive association, not evidence that one change caused another.",
    ]);
    expect(synthesis.whatWorked).toEqual([
      "You completed 4 activities; no recovery improvement is clear in the available weekly metrics.",
    ]);
    expect(synthesis.whatToTryNext).toEqual([
      "Keep training near 6 hours and protect the sleep schedule next week, then compare sleep and recovery again before increasing volume.",
    ]);
    expect(synthesis.confidenceAndMissingData).toEqual([
      "Confidence is limited because only 2 weekly periods are available.",
      "These period averages can show co-movement, but they cannot establish cause and effect.",
    ]);
  });

  it("names missing recovery data and avoids inventing an association", () => {
    const synthesis = buildWeeklyDecisionSynthesis(
      {
        weekStart: "2026-07-20",
        trainingHours: 2,
        activityCount: 1,
        avgDailyLoad: 20,
        avgSleepMinutes: 0,
        sleepPerformancePct: 0,
        avgReadiness: 0,
        avgRestingHr: null,
        avgHrv: null,
      },
      [],
    );

    expect(synthesis.likelyAssociations).toEqual([
      "No training-and-recovery association can be assessed yet because there is no comparison week with tracked sleep and recovery.",
    ]);
    expect(synthesis.whatToTryNext).toEqual([
      "Track sleep and recovery through the next week so the report can compare training with recovery.",
    ]);
    expect(synthesis.confidenceAndMissingData).toContain(
      "Missing current-period data: sleep, resting heart rate, and heart rate variability.",
    );
  });

  it("pluralizes hours from the displayed rounded value", () => {
    const synthesis = buildWeeklyDecisionSynthesis(
      {
        trainingHours: 0.96,
        activityCount: 1,
        avgSleepMinutes: 420,
        avgRestingHr: 55,
        avgHrv: 48,
      },
      [
        {
          trainingHours: 0,
          activityCount: 0,
          avgSleepMinutes: 420,
          avgRestingHr: 55,
          avgHrv: 48,
        },
      ],
    );

    expect(synthesis.whatChanged[0]).toBe(
      "Training was 1 hour, up from no recorded training in the previous week.",
    );
  });

  it("recognizes a sustained routine without labeling a neutral direction as good or bad", () => {
    const synthesis = buildWeeklyDecisionSynthesis(
      {
        weekStart: "2026-07-20",
        trainingHours: 4,
        activityCount: 3,
        avgDailyLoad: 60,
        avgSleepMinutes: 455,
        sleepPerformancePct: 101,
        avgReadiness: 0,
        avgRestingHr: 53,
        avgHrv: 54,
      },
      [
        {
          weekStart: "2026-07-13",
          trainingHours: 4,
          activityCount: 3,
          avgDailyLoad: 60,
          avgSleepMinutes: 450,
          sleepPerformancePct: 100,
          avgReadiness: 0,
          avgRestingHr: 54,
          avgHrv: 52,
        },
        {
          weekStart: "2026-07-06",
          trainingHours: 3.5,
          activityCount: 3,
          avgDailyLoad: 55,
          avgSleepMinutes: 445,
          sleepPerformancePct: 99,
          avgReadiness: 0,
          avgRestingHr: 54,
          avgHrv: 51,
        },
        {
          weekStart: "2026-06-29",
          trainingHours: 4,
          activityCount: 4,
          avgDailyLoad: 58,
          avgSleepMinutes: 450,
          sleepPerformancePct: 100,
          avgReadiness: 0,
          avgRestingHr: 55,
          avgHrv: 50,
        },
      ],
    );

    expect(synthesis.whatWorked).toEqual([
      "Training volume stayed steady while sleep, resting heart rate, and heart rate variability were stable or improved.",
    ]);
    expect(synthesis.confidenceAndMissingData[0]).toBe(
      "Confidence is moderate because 4 weekly periods are available and the current period includes sleep and recovery data.",
    );
  });
});

describe("buildMonthlyDecisionSynthesis", () => {
  it("synthesizes monthly trade-offs from server-computed trends", () => {
    const synthesis = buildMonthlyDecisionSynthesis(
      {
        monthStart: "2026-07-01",
        trainingHours: 24,
        activityCount: 12,
        avgDailyStrain: 8,
        avgSleepMinutes: 420,
        avgRestingHr: 56,
        avgHrv: 45,
        trainingHoursTrend: 20,
        avgSleepTrend: -6.7,
      },
      [
        {
          monthStart: "2026-06-01",
          trainingHours: 20,
          activityCount: 10,
          avgDailyStrain: 7,
          avgSleepMinutes: 450,
          avgRestingHr: 54,
          avgHrv: 50,
          trainingHoursTrend: null,
          avgSleepTrend: null,
        },
      ],
    );

    expect(synthesis.whatChanged).toEqual([
      "Training was 24 hours, 20% more than the previous month.",
      "Average nightly sleep was 7 hours, 6.7% less than the previous month.",
    ]);
    expect(synthesis.likelyAssociations[0]).toContain(
      "Higher training coincided with less sleep and lower heart rate variability this month.",
    );
    expect(synthesis.whatToTryNext[0]).toContain("Keep training near 24 hours");
  });

  it("reports unavailable monthly comparisons and missing metrics", () => {
    const synthesis = buildMonthlyDecisionSynthesis(
      {
        monthStart: "2026-07-01",
        trainingHours: 0,
        activityCount: 0,
        avgDailyStrain: 0,
        avgSleepMinutes: 0,
        avgRestingHr: null,
        avgHrv: null,
        trainingHoursTrend: null,
        avgSleepTrend: null,
      },
      [],
    );

    expect(synthesis.whatChanged).toEqual([
      "This is the first observed month, so month-over-month changes are not available yet.",
    ]);
    expect(synthesis.confidenceAndMissingData).toContain(
      "Missing current-period data: sleep, resting heart rate, and heart rate variability.",
    );
  });
});
