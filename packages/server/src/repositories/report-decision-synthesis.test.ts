import { describe, expect, it } from "vitest";
import {
  buildMonthlyDecisionSynthesis,
  buildWeeklyDecisionSynthesis,
} from "./report-decision-synthesis.ts";

type WeeklyPeriod = Parameters<typeof buildWeeklyDecisionSynthesis>[0];
type MonthlyPeriod = Parameters<typeof buildMonthlyDecisionSynthesis>[0];

function weeklyPeriod(overrides: Partial<WeeklyPeriod> = {}): WeeklyPeriod {
  return {
    trainingHours: 4,
    activityCount: 3,
    avgSleepMinutes: 420,
    avgRestingHr: 55,
    avgHrv: 50,
    ...overrides,
  };
}

function monthlyPeriod(overrides: Partial<MonthlyPeriod> = {}): MonthlyPeriod {
  return {
    ...weeklyPeriod(),
    trainingHoursTrend: 0,
    avgSleepTrend: 0,
    ...overrides,
  };
}

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

  it("renders positive sub-minute sleep values without an empty duration", () => {
    const synthesis = buildWeeklyDecisionSynthesis(weeklyPeriod({ avgSleepMinutes: 0.4 }), [
      weeklyPeriod({ avgSleepMinutes: 1.4 }),
    ]);

    expect(synthesis.whatChanged[1]).toBe(
      "Average nightly sleep was 0 minutes, 1 minute less than the previous week.",
    );
  });

  it("formats fractional, grouped, and lower training values at display precision", () => {
    const synthesis = buildWeeklyDecisionSynthesis(
      weeklyPeriod({ trainingHours: 1_234.56, avgSleepMinutes: 61 }),
      [weeklyPeriod({ trainingHours: 2_000, avgSleepMinutes: 1 })],
    );

    expect(synthesis.whatChanged).toEqual([
      "Training was 1,234.6 hours, 38.3% less than the previous week.",
      "Average nightly sleep was 1 hour 1 minute, 1 hour more than the previous week.",
    ]);
  });

  it("distinguishes no training from unchanged training", () => {
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ trainingHours: 0 }), [
        weeklyPeriod({ trainingHours: 0 }),
      ]).whatChanged[0],
    ).toBe("No training was recorded in either the current or previous week.");

    expect(buildWeeklyDecisionSynthesis(weeklyPeriod(), [weeklyPeriod()]).whatChanged).toEqual([
      "Training held steady at 4 hours versus the previous week.",
      "Average nightly sleep held steady at 7 hours.",
    ]);
  });

  it("requires sleep tracking in each compared week", () => {
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ avgSleepMinutes: 0 }), [weeklyPeriod()])
        .whatChanged[1],
    ).toBe(
      "A week-over-week sleep change is unavailable because sleep was not tracked in both weeks.",
    );
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod(), [weeklyPeriod({ avgSleepMinutes: 0 })])
        .whatChanged[1],
    ).toBe(
      "A week-over-week sleep change is unavailable because sleep was not tracked in both weeks.",
    );
  });

  it("describes lower training alongside improved recovery without implying cause", () => {
    const synthesis = buildWeeklyDecisionSynthesis(
      weeklyPeriod({ trainingHours: 3, avgSleepMinutes: 480, avgHrv: 55 }),
      [weeklyPeriod({ trainingHours: 4, avgSleepMinutes: 420, avgHrv: 50 })],
    );

    expect(synthesis.likelyAssociations).toEqual([
      "Lower training coincided with more sleep and higher heart rate variability this week. This is a descriptive association, not evidence that one change caused another.",
    ]);
  });

  it("describes steady training and recovery directions explicitly", () => {
    const synthesis = buildWeeklyDecisionSynthesis(weeklyPeriod(), [weeklyPeriod()]);

    expect(synthesis.likelyAssociations).toEqual([
      "With training volume steady, sleep was steady and heart rate variability was steady this week. This is a descriptive association, not evidence that one change caused another.",
    ]);
  });

  it("describes steady recovery when training changes", () => {
    const synthesis = buildWeeklyDecisionSynthesis(weeklyPeriod({ trainingHours: 5 }), [
      weeklyPeriod(),
    ]);

    expect(synthesis.likelyAssociations).toEqual([
      "Higher training coincided with steady sleep and steady heart rate variability this week. This is a descriptive association, not evidence that one change caused another.",
    ]);
  });

  it("does not assess associations when either comparison period lacks recovery data", () => {
    const unavailable =
      "No training-and-recovery association can be assessed yet because there is no comparison week with tracked sleep and recovery.";

    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ avgHrv: null }), [weeklyPeriod()])
        .likelyAssociations[0],
    ).toBe(unavailable);
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod(), [weeklyPeriod({ avgSleepMinutes: 0 })])
        .likelyAssociations[0],
    ).toBe(unavailable);
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod(), [weeklyPeriod({ avgHrv: null })])
        .likelyAssociations[0],
    ).toBe(unavailable);
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ avgSleepMinutes: 0 }), [weeklyPeriod()])
        .likelyAssociations[0],
    ).toBe(unavailable);
  });

  it("recognizes recovery stability when training volume changes", () => {
    const synthesis = buildWeeklyDecisionSynthesis(
      weeklyPeriod({
        trainingHours: 5,
        activityCount: 1,
        avgSleepMinutes: 430,
        avgRestingHr: 60,
        avgHrv: 55,
      }),
      [weeklyPeriod()],
    );

    expect(synthesis.whatWorked).toEqual([
      "You completed 1 activity while sleep and heart rate variability were stable or improved.",
    ]);
  });

  it("requires less than a tenth of an hour to classify training as steady", () => {
    const synthesis = buildWeeklyDecisionSynthesis(weeklyPeriod({ trainingHours: 0.1 }), [
      weeklyPeriod({ trainingHours: 0 }),
    ]);

    expect(synthesis.whatWorked).toEqual([
      "You completed 3 activities while sleep and heart rate variability were stable or improved.",
    ]);
  });

  it("requires each stable recovery metric for the complete positive pattern", () => {
    expect(buildWeeklyDecisionSynthesis(weeklyPeriod(), [weeklyPeriod()]).whatWorked).toEqual([
      "Training volume stayed steady while sleep, resting heart rate, and heart rate variability were stable or improved.",
    ]);
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ avgRestingHr: 0 }), [
        weeklyPeriod({ avgRestingHr: null }),
      ]).whatWorked,
    ).toEqual([
      "You completed 3 activities while sleep and heart rate variability were stable or improved.",
    ]);
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ avgHrv: null }), [weeklyPeriod({ avgHrv: 0 })])
        .whatWorked,
    ).toEqual([
      "You completed 3 activities; no recovery improvement is clear in the available weekly metrics.",
    ]);
  });

  it("reports when no recovery improvement is clear", () => {
    const synthesis = buildWeeklyDecisionSynthesis(
      weeklyPeriod({ trainingHours: 5, activityCount: 1, avgSleepMinutes: 410, avgHrv: 45 }),
      [weeklyPeriod()],
    );

    expect(synthesis.whatWorked).toEqual([
      "You completed 1 activity; no recovery improvement is clear in the available weekly metrics.",
    ]);
  });

  it.each([
    {
      name: "changed training",
      current: { trainingHours: 5 },
      previous: {},
      expected:
        "You completed 3 activities while sleep and heart rate variability were stable or improved.",
    },
    {
      name: "less sleep",
      current: { avgSleepMinutes: 410 },
      previous: {},
      expected:
        "You completed 3 activities; no recovery improvement is clear in the available weekly metrics.",
    },
    {
      name: "higher resting heart rate",
      current: { avgRestingHr: 56 },
      previous: {},
      expected:
        "You completed 3 activities while sleep and heart rate variability were stable or improved.",
    },
    {
      name: "lower heart rate variability",
      current: { avgHrv: 49 },
      previous: {},
      expected:
        "You completed 3 activities; no recovery improvement is clear in the available weekly metrics.",
    },
    {
      name: "missing current sleep",
      current: { avgSleepMinutes: 0 },
      previous: {},
      expected:
        "You completed 3 activities; no recovery improvement is clear in the available weekly metrics.",
    },
    {
      name: "missing previous sleep",
      current: {},
      previous: { avgSleepMinutes: 0 },
      expected:
        "You completed 3 activities; no recovery improvement is clear in the available weekly metrics.",
    },
    {
      name: "missing current resting heart rate",
      current: { avgRestingHr: null },
      previous: {},
      expected:
        "You completed 3 activities while sleep and heart rate variability were stable or improved.",
    },
    {
      name: "missing previous resting heart rate",
      current: {},
      previous: { avgRestingHr: null },
      expected:
        "You completed 3 activities while sleep and heart rate variability were stable or improved.",
    },
    {
      name: "missing current heart rate variability",
      current: { avgHrv: null },
      previous: {},
      expected:
        "You completed 3 activities; no recovery improvement is clear in the available weekly metrics.",
    },
    {
      name: "missing previous heart rate variability",
      current: {},
      previous: { avgHrv: null },
      expected:
        "You completed 3 activities; no recovery improvement is clear in the available weekly metrics.",
    },
    {
      name: "lower sleep with stable heart rate variability",
      current: { avgSleepMinutes: 410 },
      previous: { avgSleepMinutes: 420 },
      expected:
        "You completed 3 activities; no recovery improvement is clear in the available weekly metrics.",
    },
  ])("requires every positive-pattern input when $name", ({ current, previous, expected }) => {
    const synthesis = buildWeeklyDecisionSynthesis(weeklyPeriod(current), [weeklyPeriod(previous)]);

    expect(synthesis.whatWorked).toEqual([expected]);
  });

  it("lists one or two missing recovery metrics with correct grammar", () => {
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ avgSleepMinutes: 0 }), [weeklyPeriod()])
        .confidenceAndMissingData,
    ).toContain("Missing current-period data: sleep.");
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ avgRestingHr: null, avgHrv: null }), [
        weeklyPeriod(),
      ]).confidenceAndMissingData,
    ).toContain("Missing current-period data: resting heart rate and heart rate variability.");
  });

  it("names missing recovery data as the confidence limit when history is sufficient", () => {
    const synthesis = buildWeeklyDecisionSynthesis(weeklyPeriod({ avgHrv: null }), [
      weeklyPeriod(),
      weeklyPeriod(),
      weeklyPeriod(),
    ]);

    expect(synthesis.confidenceAndMissingData[0]).toBe(
      "Confidence is limited because current-period recovery data is incomplete.",
    );
  });

  it("describes a complete first period as a low-confidence baseline", () => {
    const synthesis = buildWeeklyDecisionSynthesis(weeklyPeriod(), []);

    expect(synthesis).toEqual({
      whatChanged: [
        "This is the first observed week, so week-over-week changes are not available yet.",
      ],
      likelyAssociations: [
        "No training-and-recovery association can be assessed yet because there is no comparison week with tracked sleep and recovery.",
      ],
      whatWorked: ["There is not enough history yet to identify a repeatable positive pattern."],
      whatToTryNext: [
        "Repeat or deliberately adjust one part of the routine next week, then compare it with this baseline.",
      ],
      confidenceAndMissingData: [
        "Confidence is low because only 1 weekly period is available.",
        "These period averages can show co-movement, but they cannot establish cause and effect.",
      ],
    });
  });

  it("requires both higher training and lower sleep before recommending volume restraint", () => {
    const defaultStep =
      "Keep one major input steady next week—training volume or sleep schedule—so the following comparison is easier to interpret.";

    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ trainingHours: 5 }), [
        weeklyPeriod({ trainingHours: 4 }),
      ]).whatToTryNext[0],
    ).toBe(defaultStep);
    expect(
      buildWeeklyDecisionSynthesis(weeklyPeriod({ avgSleepMinutes: 410 }), [
        weeklyPeriod({ avgSleepMinutes: 420 }),
      ]).whatToTryNext[0],
    ).toBe(defaultStep);
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

  it("uses month-specific wording for a complete first period", () => {
    const synthesis = buildMonthlyDecisionSynthesis(monthlyPeriod(), []);

    expect(synthesis).toEqual({
      whatChanged: [
        "This is the first observed month, so month-over-month changes are not available yet.",
      ],
      likelyAssociations: [
        "No training-and-recovery association can be assessed yet because there is no comparison month with tracked sleep and recovery.",
      ],
      whatWorked: ["There is not enough history yet to identify a repeatable positive pattern."],
      whatToTryNext: [
        "Repeat or deliberately adjust one part of the routine next month, then compare it with this baseline.",
      ],
      confidenceAndMissingData: [
        "Confidence is low because only 1 monthly period is available.",
        "These period averages can show co-movement, but they cannot establish cause and effect.",
      ],
    });
  });

  it("distinguishes stable monthly trends from unavailable sleep comparisons", () => {
    expect(buildMonthlyDecisionSynthesis(monthlyPeriod(), [monthlyPeriod()]).whatChanged).toEqual([
      "Training held steady at 4 hours versus the previous month.",
      "Average nightly sleep held steady at 7 hours.",
    ]);

    expect(
      buildMonthlyDecisionSynthesis(monthlyPeriod({ avgSleepTrend: null }), [monthlyPeriod()])
        .whatChanged[1],
    ).toBe(
      "A month-over-month sleep change is unavailable because sleep was not tracked in both months.",
    );
    expect(
      buildMonthlyDecisionSynthesis(monthlyPeriod({ avgSleepMinutes: 0, avgSleepTrend: 10 }), [
        monthlyPeriod(),
      ]).whatChanged[1],
    ).toBe(
      "A month-over-month sleep change is unavailable because sleep was not tracked in both months.",
    );
  });

  it("formats positive monthly sleep and training trends", () => {
    const synthesis = buildMonthlyDecisionSynthesis(
      monthlyPeriod({ trainingHours: 5, trainingHoursTrend: 25, avgSleepTrend: 10 }),
      [monthlyPeriod()],
    );

    expect(synthesis.whatChanged).toEqual([
      "Training was 5 hours, 25% more than the previous month.",
      "Average nightly sleep was 7 hours, 10% more than the previous month.",
    ]);
  });

  it("rounds supplied monthly trends to one decimal place", () => {
    const synthesis = buildMonthlyDecisionSynthesis(
      monthlyPeriod({ trainingHours: 5, trainingHoursTrend: 12.34, avgSleepTrend: 12.34 }),
      [monthlyPeriod()],
    );

    expect(synthesis.whatChanged).toEqual([
      "Training was 5 hours, 12.3% more than the previous month.",
      "Average nightly sleep was 7 hours, 12.3% more than the previous month.",
    ]);
  });

  it("uses every observed month when reporting moderate confidence", () => {
    const synthesis = buildMonthlyDecisionSynthesis(monthlyPeriod(), [
      monthlyPeriod(),
      monthlyPeriod(),
      monthlyPeriod(),
    ]);

    expect(synthesis.confidenceAndMissingData).toEqual([
      "Confidence is moderate because 4 monthly periods are available and the current period includes sleep and recovery data.",
      "These period averages can show co-movement, but they cannot establish cause and effect.",
    ]);
  });
});
