import { StrainScore } from "@dofek/scoring/scoring";
import { describe, expect, it, vi } from "vitest";
import { VerticalAscentModel } from "../repositories/cycling-advanced-models.ts";
import { loadMobileTrainingTab } from "./mobile-training-tab.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

describe("loadMobileTrainingTab", () => {
  function makeQuery(
    strainRows: unknown[] = [],
    readinessRows: unknown[] = [],
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async (_schema: unknown, sqlText: unknown) => {
      const sql = String(sqlText);
      if (sql.includes("analytics.daily_strain")) return strainRows;
      if (sql.includes("analytics.daily_recovery")) return readinessRows;
      return [];
    });
  }

  function makeCtx(
    query: ReturnType<typeof vi.fn>,
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
        (await import("../repositories/cycling-advanced-repository.ts")).CyclingAdvancedRepository
          .prototype,
        "getVerticalAscentRates",
      )
      .mockResolvedValue(verticalAscent);
    return { trainingSpy, cyclingSpy };
  }

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
    const repos = await mockTrainingRepos(
      [
        {
          id: "act-1",
          activity_type: "running",
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
      [{ week: "2026-03-24", activity_type: "running", count: 2, hours: 3.5 }],
      [
        new VerticalAscentModel({
          date: "2026-03-28",
          activityName: "Hill Climb",
          elevationGainMeters: 500,
          climbingSeconds: 1800,
        }),
      ],
    );

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.workloadRatio.timeSeries).toHaveLength(1);
    expect(result.workloadRatio.timeSeries[0]?.dailyLoad).toBe(50);
    expect(result.workloadRatio.timeSeries[0]?.workloadRatio).toBe(1.17);
    expect(result.workloadRatio.displayedStrain).toBe(10.9);
    expect(result.strainTarget.readinessScore).toBeGreaterThan(50);
    expect(result.strainTarget.dailyLoad).toBe(50);
    expect(result.activities).toHaveLength(1);
    expect(result.weeklyVolume).toHaveLength(1);
    expect(result.verticalAscent[0]?.verticalAscentRate).toBe(1000);

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("returns empty workload ratio defaults when no strain rows exist", async () => {
    const repos = await mockTrainingRepos();

    const result = await loadMobileTrainingTab(makeCtx(makeQuery()), 30, "2026-03-28");

    expect(result.workloadRatio.timeSeries).toEqual([]);
    expect(result.workloadRatio.displayedStrain).toBe(0);
    expect(result.workloadRatio.displayedDate).toBeNull();
    expect(result.strainTarget.currentStrain).toBe(0);
    expect(result.strainTarget.progressPercent).toBe(0);

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("rounds workload ratio fields to expected precision", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("handles null workload_ratio in strain rows", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("uses default readiness score when no recovery summary exists", async () => {
    const repos = await mockTrainingRepos();
    const query = makeQuery([
      {
        date: "2026-03-28",
        daily_load: 50,
        acute_load: 350,
        chronic_load: 300,
        workload_ratio: 1.17,
      },
    ]);

    const result = await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    expect(result.strainTarget.readinessScore).toBe(50);

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("workloadRatio is null when chronicLoad is zero", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("passes limited access windows to strain and recovery queries", async () => {
    const query = makeQuery();
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("passes dashboard priority to training dashboard read-model queries", async () => {
    const query = makeQuery();
    const repos = await mockTrainingRepos();

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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("sets displayedDate from the most recent strain row", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("does not add access filters when access window is full", async () => {
    const query = makeQuery();
    const repos = await mockTrainingRepos();

    await loadMobileTrainingTab(makeCtx(query), 30, "2026-03-28");

    const strainQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_strain"),
    );
    const recoveryQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_recovery"),
    );

    expect(String(strainQuery?.[1])).not.toContain("accessStartDate");
    expect(String(recoveryQuery?.[1])).not.toContain("accessStartDate");

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("uses default readiness component scores when recovery fields are null", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("computes acute and chronic loads from rolling daily loads", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("uses the end-date row for daily load instead of the first strain row", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("computes progress percent from current and target strain", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("excludes loads exactly seven days ago from the acute window", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("includes loads six days ago in the acute window", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });

  it("rounds strain target load fields to one decimal place", async () => {
    const repos = await mockTrainingRepos();
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

    repos.trainingSpy.mockRestore();
    repos.cyclingSpy.mockRestore();
  });
});
