import { StrainScore } from "@dofek/scoring/scoring";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClimbingGradeProgression,
  ClimbingSessionSummary,
  ClimbingVolumeByGrade,
} from "../repositories/climbing-repository.ts";
import { VerticalAscentModel } from "../repositories/cycling-advanced-models.ts";
import type { HangboardingSummary } from "../repositories/hangboarding-repository.ts";
import { ProgressiveOverload } from "../repositories/progressive-overload.ts";
import { loadMobileTrainingTab } from "./mobile-training-tab.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("loadMobileTrainingTab", () => {
  const defaultReadinessRows = [
    {
      date: "2026-03-28",
      hrv_score: 62,
      resting_hr_score: 62,
      sleep_score: 62,
      respiratory_rate_score: 62,
    },
  ];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeQuery(
    strainRows: unknown[] = [],
    readinessRows: unknown[] = defaultReadinessRows,
  ): CallableVitestMock {
    return vi.fn(async (_schema: unknown, sqlText: unknown) => {
      const sql = String(sqlText);
      if (sql.includes("analytics.daily_strain")) return strainRows;
      if (sql.includes("analytics.daily_recovery")) return readinessRows;
      return [];
    });
  }

  function makeCtx(
    query: CallableVitestMock,
    accessWindow?: import("../billing/entitlement.ts").AccessWindow,
  ) {
    return {
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      accessWindow,
      sensorStore: { query },
    };
  }

  async function mockTrainingRepos(
    activities: unknown[] = [],
    weeklyVolume: unknown[] = [],
    verticalAscent: VerticalAscentModel[] = [],
    progressiveOverload: ProgressiveOverload[] = [],
    hangboardingSummary: HangboardingSummary = {
      sessionCount: 0,
      totalDurationSeconds: 0,
      averageDurationSeconds: null,
      totalWorkDurationSeconds: null,
      totalRestDurationSeconds: null,
      workIntervalCount: null,
      averageHeartRate: null,
      peakHeartRate: null,
      latestSession: null,
      daily: [],
    },
  ) {
    const trainingSpy = vi
      .spyOn(
        (await import("../repositories/training-repository.ts")).TrainingRepository.prototype,
        "getActivityStatsAndWeeklyVolume",
      )
      .mockResolvedValue({
        activities,
        weeklyVolume,
      });
    const cyclingSpy = vi
      .spyOn(
        (await import("../repositories/cycling-analytics-repository.ts")).CyclingAnalyticsRepository
          .prototype,
        "getActivities",
      )
      .mockResolvedValue({
        activities: { items: [], totalCount: 0 },
        variability: { rows: [], totalCount: 0, emptyReason: null },
        verticalAscent: verticalAscent.map((model) => model.toDetail()),
        aerobicEfficiency: { maxHr: null, activities: [] },
      });
    const strengthSpy = vi
      .spyOn(
        (await import("../repositories/strength-repository.ts")).StrengthRepository.prototype,
        "getProgressiveOverload",
      )
      .mockResolvedValue(progressiveOverload);
    const hangboardingSpy = vi
      .spyOn(
        (await import("../repositories/hangboarding-repository.ts")).HangboardingRepository
          .prototype,
        "getSummary",
      )
      .mockResolvedValue(hangboardingSummary);
    return { trainingSpy, cyclingSpy, strengthSpy, hangboardingSpy };
  }

  async function mockClimbingRepos() {
    const repository = (await import("../repositories/climbing-repository.ts")).ClimbingRepository
      .prototype;
    const gradeProgressionSpy = vi.spyOn(repository, "getGradeProgression").mockResolvedValue([
      new ClimbingGradeProgression({
        date: "2026-03-28",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        gradeSortValue: 4,
      }),
    ]);
    const volumeByGradeSpy = vi.spyOn(repository, "getVolumeByGrade").mockResolvedValue([
      new ClimbingVolumeByGrade({
        climbType: "route",
        gradeSystem: "yds",
        grade: "5.10a",
        gradeSortValue: 5101,
        attempts: 3,
        sends: 2,
      }),
    ]);
    const sessionSummarySpy = vi.spyOn(repository, "getSessionSummaries").mockResolvedValue([
      new ClimbingSessionSummary({
        activityId: "climb-1",
        date: "2026-03-28",
        name: "Kaya climbing at Touchstone Pacific Pipe",
        locationName: "Touchstone Pacific Pipe",
        attempts: 8,
        sends: 5,
        hardestBoulderGrade: "V4",
        hardestBoulderGradeSortValue: 4,
        hardestRouteGrade: "5.10a",
        hardestRouteGradeSortValue: 5101,
      }),
    ]);
    return { gradeProgressionSpy, volumeByGradeSpy, sessionSummarySpy };
  }

  it("caps how many repository reads run at the same time so the pool is never over-demanded", async () => {
    let active = 0;
    let peak = 0;
    const release = deferred<void>();
    function track<T>(value: T): () => Promise<T> {
      return async () => {
        active += 1;
        peak = Math.max(peak, active);
        await release.promise;
        active -= 1;
        return value;
      };
    }

    const { trainingSpy, cyclingSpy, strengthSpy, hangboardingSpy } = await mockTrainingRepos();
    const { gradeProgressionSpy, volumeByGradeSpy, sessionSummarySpy } = await mockClimbingRepos();
    trainingSpy.mockImplementation(track({ activities: [], weeklyVolume: [] }));
    cyclingSpy.mockImplementation(
      track({
        activities: { items: [], totalCount: 0 },
        variability: { rows: [], totalCount: 0, emptyReason: null },
        verticalAscent: [],
        aerobicEfficiency: { maxHr: null, activities: [] },
      }),
    );
    strengthSpy.mockImplementation(track([]));
    hangboardingSpy.mockImplementation(
      track({
        sessionCount: 0,
        totalDurationSeconds: 0,
        averageDurationSeconds: null,
        totalWorkDurationSeconds: null,
        totalRestDurationSeconds: null,
        workIntervalCount: null,
        averageHeartRate: null,
        peakHeartRate: null,
        latestSession: null,
        daily: [],
      }),
    );
    gradeProgressionSpy.mockImplementation(track([]));
    volumeByGradeSpy.mockImplementation(track([]));
    sessionSummarySpy.mockImplementation(track([]));

    const resultPromise = loadMobileTrainingTab(makeCtx(makeQuery()), 30, "2026-03-28");
    // Let every read that is allowed to start reach its running slot before any finish.
    for (let microtaskTurn = 0; microtaskTurn < 20; microtaskTurn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);

    release.resolve();
    await resultPromise;
  });

  it("returns workload ratio, strain target, activities, weekly volume, and vertical ascent", async () => {
    const query = makeQuery(
      [
        {
          date: "2026-03-28",
          daily_load: 50,
          acute_load: 350,
          chronic_load: 300,
          workload_ratio: 1.17,
        },
      ],
      [
        {
          date: "2026-03-28",
          hrv_score: 72,
          resting_hr_score: 68,
          sleep_score: 80,
          respiratory_rate_score: 74,
        },
      ],
    );
    const { cyclingSpy } = await mockTrainingRepos(
      [
        {
          id: "act-1",
          canonical_type: "running",
          name: "Morning Run",
          started_at: "2026-03-28T08:00:00.000Z",
          ended_at: "2026-03-28T09:00:00.000Z",
          avg_hr: 145,
          max_hr: 175,
          avg_power: null,
          max_power: null,
          avg_cadence: 82,
          hr_samples: 3600,
          power_samples: null,
          distance_meters: 10500,
        },
      ],
      [{ week: "2026-03-24", canonical_type: "running", count: 2, hours: 3.5 }],
      [
        new VerticalAscentModel({
          date: "2026-03-28",
          activityName: "Hill Climb",
          activityType: "cycling",
          modality: "road",
          elevationGainMeters: 500,
          elapsedSeconds: 1800,
        }),
      ],
      [
        new ProgressiveOverload("Back Squat", [
          { week: "2026-03-09", totalVolumeKg: 1_000 },
          { week: "2026-03-23", totalVolumeKg: 1_200 },
        ]),
      ],
      {
        sessionCount: 2,
        totalDurationSeconds: 1500,
        averageDurationSeconds: 750,
        totalWorkDurationSeconds: 17,
        totalRestDurationSeconds: 103,
        workIntervalCount: 2,
        averageHeartRate: 125,
        peakHeartRate: 150,
        latestSession: {
          activityId: "activity-2",
          startedAt: "2026-08-08T14:00:00.000Z",
          planName: "7/3 Repeaters",
          boardName: "Tension Board",
          durationSeconds: 900,
        },
        daily: [],
      },
    );
    await mockClimbingRepos();

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.workloadRatio.timeSeries).toHaveLength(1);
    expect(result.workloadRatio.timeSeries[0]?.dailyLoad).toBe(50);
    expect(result.workloadRatio.timeSeries[0]?.workloadRatio).toBe(1.17);
    expect(result.workloadRatio.displayedStrain).toBe(10.9);
    expect(result.strainTarget.readinessScore).toBeGreaterThan(50);
    expect(result.strainTarget.dailyLoad).toBe(50);
    expect(result.activities).toHaveLength(1);
    expect(result.weeklyVolume).toHaveLength(1);
    expect(result.progressiveOverload[0]).toMatchObject({
      exerciseName: "Back Squat",
      slopeKgPerWeek: 100,
      period: { observationCount: 2, elapsedWeekCount: 3 },
    });
    expect(result.verticalAscent[0]?.verticalAscentRate).toBe(1000);
    expect(result.verticalAscent[0]?.activityType).toBe("cycling");
    expect(result.verticalAscent[0]?.modality).toBe("road");
    expect(cyclingSpy).toHaveBeenCalledWith(expect.objectContaining({ days: 30 }), {
      activityLimit: 1,
      activityOffset: 0,
      variabilityLimit: 1,
      variabilityOffset: 0,
    });
    expect(result.climbing).toEqual({
      gradeProgression: [
        {
          date: "2026-03-28",
          climbType: "boulder",
          gradeSystem: "v_scale",
          grade: "V4",
          gradeSortValue: 4,
        },
      ],
      volumeByGrade: [
        {
          climbType: "route",
          gradeSystem: "yds",
          grade: "5.10a",
          gradeSortValue: 5101,
          attempts: 3,
          sends: 2,
        },
      ],
      sessionSummary: [
        {
          activityId: "climb-1",
          date: "2026-03-28",
          name: "Kaya climbing at Touchstone Pacific Pipe",
          locationName: "Touchstone Pacific Pipe",
          attempts: 8,
          sends: 5,
          hardestBoulderGrade: "V4",
          hardestBoulderGradeSortValue: 4,
          hardestRouteGrade: "5.10a",
          hardestRouteGradeSortValue: 5101,
        },
      ],
      hangboarding: {
        sessionCount: 2,
        totalDurationSeconds: 1500,
        averageDurationSeconds: 750,
        totalWorkDurationSeconds: 17,
        totalRestDurationSeconds: 103,
        workIntervalCount: 2,
        averageHeartRate: 125,
        peakHeartRate: 150,
        latestSession: expect.objectContaining({ planName: "7/3 Repeaters" }),
        daily: expect.any(Array),
      },
    });
  });

  it("returns empty workload ratio defaults when no strain rows exist", async () => {
    await mockTrainingRepos();

    const result = await loadMobileTrainingTab(makeCtx(makeQuery()), 30, "2026-03-28");

    expect(result.workloadRatio.timeSeries).toEqual([]);
    expect(result.workloadRatio.displayedStrain).toBe(0);
    expect(result.workloadRatio.displayedDate).toBeNull();
    expect(result.strainTarget.currentStrain).toBe(0);
    expect(result.strainTarget.progressPercent).toBe(0);
  });

  it("reports insufficient chart availability from server-owned observations", async () => {
    await mockTrainingRepos();

    const result = await loadMobileTrainingTab(makeCtx(makeQuery()), 30, "2026-03-28");

    expect(result.chartAvailability).toEqual({
      strainTrend: {
        status: "insufficient_data",
        sourceLabel: "Daily strain model",
        observedCount: 0,
        minimumCount: 2,
        message:
          "No daily strain trend is available from the daily strain model. Record at least 2 training days to show this chart.",
      },
      verticalAscent: {
        status: "insufficient_data",
        sourceLabel: "Cycling activity altitude sensor summaries",
        observedCount: 0,
        minimumCount: 1,
        message:
          "No vertical ascent data is available from cycling activity altitude sensor summaries. Record at least 1 cycling activity with altitude data to show this chart.",
      },
    });
  });

  it("reports available chart availability after each server threshold is met", async () => {
    const query = makeQuery([
      {
        date: "2026-03-27",
        daily_load: 40,
        acute_load: 200,
        chronic_load: 250,
        workload_ratio: 0.8,
      },
      {
        date: "2026-03-28",
        daily_load: 50,
        acute_load: 250,
        chronic_load: 300,
        workload_ratio: 0.83,
      },
    ]);
    await mockTrainingRepos(
      [],
      [],
      [
        new VerticalAscentModel({
          date: "2026-03-28",
          activityName: "Hill Climb",
          activityType: "road_cycling",
          modality: "road",
          elevationGainMeters: 500,
          elapsedSeconds: 1800,
        }),
      ],
    );

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.chartAvailability).toEqual({
      strainTrend: {
        status: "available",
        sourceLabel: "Daily strain model",
        observedCount: 2,
        minimumCount: 2,
        message: "Daily strain trend is available from the daily strain model.",
      },
      verticalAscent: {
        status: "available",
        sourceLabel: "Cycling activity altitude sensor summaries",
        observedCount: 1,
        minimumCount: 1,
        message:
          "Vertical ascent data is available from cycling activity altitude sensor summaries.",
      },
    });
  });

  it("rounds workload ratio fields to expected precision", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-01",
        daily_load: 125.678,
        acute_load: 500.345,
        chronic_load: 400.789,
        workload_ratio: 1.2567,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    const row = result.workloadRatio.timeSeries[0];
    expect(row?.dailyLoad).toBe(125.7);
    expect(row?.acuteLoad).toBeCloseTo(500.3, 1);
    expect(row?.chronicLoad).toBe(400.8);
    expect(row?.workloadRatio).toBe(1.26);
    expect(row?.strain).toBe(StrainScore.fromRawLoad(125.7).value);
  });

  it("handles null workload_ratio in strain rows", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-01",
        daily_load: 50,
        acute_load: 200,
        chronic_load: 300,
        workload_ratio: null,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.workloadRatio.timeSeries[0]?.workloadRatio).toBeNull();
  });

  it("omits the strain target when no recovery summary exists", async () => {
    await mockTrainingRepos();
    const query = makeQuery(
      [
        {
          date: "2026-03-28",
          daily_load: 50,
          acute_load: 350,
          chronic_load: 300,
          workload_ratio: 1.17,
        },
      ],
      [],
    );

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget).toBeUndefined();
  });

  it("workloadRatio is null when chronicLoad is zero", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-28",
        daily_load: 0,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.workloadRatio).toBeNull();
  });

  it("passes limited access windows to strain and recovery queries", async () => {
    const query = makeQuery();
    await mockTrainingRepos();
    const accessWindow = {
      kind: "limited" as const,
      paid: false as const,
      reason: "free_signup_week" as const,
      startDate: "2026-03-10",
      endDateExclusive: "2026-03-20",
    };

    await loadMobileTrainingTab(makeCtx(query, accessWindow), 30, "2026-03-28");

    const strainQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_strain"),
    );
    const recoveryQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_recovery"),
    );

    expect(String(strainQuery?.[1])).toContain("strain.date >= toDate({accessStartDate:String})");
    expect(String(strainQuery?.[1])).toContain("strain.is_deleted = 0");
    expect(String(recoveryQuery?.[1])).toContain("recovery.is_deleted = 0");
    expect(String(strainQuery?.[1])).toContain(
      "strain.date < toDate({accessEndDateExclusive:String})",
    );
    expect(strainQuery?.[2]).toMatchObject({
      accessStartDate: "2026-03-10",
      accessEndDateExclusive: "2026-03-20",
    });

    expect(String(recoveryQuery?.[1])).toContain(
      "recovery.date >= toDate({accessStartDate:String})",
    );
    expect(String(recoveryQuery?.[1])).toContain(
      "recovery.date < toDate({accessEndDateExclusive:String})",
    );
    expect(recoveryQuery?.[2]).toMatchObject({
      accessStartDate: "2026-03-10",
      accessEndDateExclusive: "2026-03-20",
    });
  });

  it("passes dashboard priority to training dashboard read-model queries", async () => {
    const query = makeQuery();
    await mockTrainingRepos();

    await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    const dashboardQueryCalls = query.mock.calls.filter((call) =>
      ["analytics.daily_strain", "analytics.daily_recovery"].some((readModelName) =>
        String(call[1]).includes(readModelName),
      ),
    );
    expect(dashboardQueryCalls).toHaveLength(2);
    for (const queryCall of dashboardQueryCalls) {
      expect(queryCall[3]).toEqual({ priority: "dashboard" });
    }
  });

  it("sets displayedDate from the most recent strain row", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-27",
        daily_load: 10,
        acute_load: 100,
        chronic_load: 200,
        workload_ratio: 0.5,
      },
      {
        date: "2026-03-28",
        daily_load: 50,
        acute_load: 350,
        chronic_load: 300,
        workload_ratio: 1.17,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.workloadRatio.displayedDate).toBe("2026-03-28");
    expect(result.strainTarget.progressPercent).toBeGreaterThan(0);
  });

  it("does not add access filters when access window is full", async () => {
    const query = makeQuery();
    await mockTrainingRepos();

    await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    const strainQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_strain"),
    );
    const recoveryQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_recovery"),
    );

    expect(String(strainQuery?.[1])).not.toContain("accessStartDate");
    expect(String(recoveryQuery?.[1])).not.toContain("accessStartDate");
  });

  it("uses default readiness component scores when recovery fields are null", async () => {
    await mockTrainingRepos();
    const query = makeQuery(
      [
        {
          date: "2026-03-28",
          daily_load: 50,
          acute_load: 350,
          chronic_load: 300,
          workload_ratio: 1.17,
        },
      ],
      [
        {
          date: "2026-03-28",
          hrv_score: 80,
          resting_hr_score: null,
          sleep_score: null,
          respiratory_rate_score: null,
        },
      ],
    );

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.readinessScore).toBeGreaterThan(62);
  });

  it("computes acute and chronic loads from rolling daily loads", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-28",
        daily_load: 70,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
      {
        date: "2026-03-27",
        daily_load: 70,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
      {
        date: "2026-03-21",
        daily_load: 280,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.dailyLoad).toBe(70);
    expect(result.strainTarget.acuteLoad).toBe(20);
    expect(result.strainTarget.chronicLoad).toBe(15);
    expect(result.strainTarget.workloadRatio).toBe(1.33);
  });

  it("uses the end-date row for daily load instead of the first strain row", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-27",
        daily_load: 999,
        acute_load: 100,
        chronic_load: 200,
        workload_ratio: 0.5,
      },
      {
        date: "2026-03-28",
        daily_load: 42,
        acute_load: 350,
        chronic_load: 300,
        workload_ratio: 1.17,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.dailyLoad).toBe(42);
    expect(result.strainTarget.currentStrain).toBe(StrainScore.fromRawLoad(42).value);
  });

  it("computes progress percent from current and target strain", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-28",
        daily_load: 100,
        acute_load: 700,
        chronic_load: 700,
        workload_ratio: 1,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.progressPercent).toBeGreaterThan(0);
    expect(result.strainTarget.progressPercent).toBeLessThanOrEqual(200);
  });

  it("excludes loads exactly seven days ago from the acute window", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-21",
        daily_load: 70,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.acuteLoad).toBe(0);
    expect(result.strainTarget.chronicLoad).toBe(2.5);
  });

  it("includes loads six days ago in the acute window", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-22",
        daily_load: 70,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.acuteLoad).toBe(10);
  });

  it("rounds strain target load fields to one decimal place", async () => {
    await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-28",
        daily_load: 125.678,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
      {
        date: "2026-03-27",
        daily_load: 33.333,
        acute_load: 0,
        chronic_load: 0,
        workload_ratio: null,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.dailyLoad).toBe(125.7);
    expect(result.strainTarget.currentStrain).toBe(StrainScore.fromRawLoad(125.7).value);
    expect(result.strainTarget.acuteLoad).toBe(22.7);
  });
});
