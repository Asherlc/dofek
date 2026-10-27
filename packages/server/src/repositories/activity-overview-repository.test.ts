import { describe, expect, it, vi } from "vitest";
import { makeDatabase, makeSensorStore, normalizeSql } from "./activity-calendar-test-helpers.ts";
import { ActivityOverviewRepository } from "./activity-overview-repository.ts";

describe("ActivityOverviewRepository", () => {
  it("returns activity overview totals from authorized ClickHouse activity rows", async () => {
    const database = makeDatabase([
      [{ id: "running-activity" }, { id: "cycling-activity" }],
      [{ id: "running-activity" }, { id: "cycling-activity" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "1",
          current_total_minutes: "60.2",
          current_total_distance_meters: "10000.1",
          current_total_elevation_gain_m: "120.1",
          current_distance_measurement_count: "1",
          current_elevation_measurement_count: "1",
          previous_activity_count: "0",
          previous_total_minutes: "0",
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: "0",
          previous_elevation_measurement_count: "0",
        },
      ],
      [{ canonical_type: "cycling" }, { canonical_type: "running" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getActivityOverview({
      weeks: 4,
      endDate: "2026-03-20",
      activityType: "running",
    });
    expect(String(vi.mocked(sensorStore.query).mock.calls[0]?.[1])).toContain(
      "activity.provider_id = 'mountain-project'",
    );
    expect(String(vi.mocked(sensorStore.query).mock.calls[1]?.[1])).toContain(
      "activity.provider_id = 'mountain-project'",
    );

    expect(result).toMatchObject({
      activityCount: 1,
      totalMinutes: 60.2,
      totalDistanceMeters: 10000.1,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 120.1,
      totalElevationState: { status: "available" },
      activityTypes: ["cycling", "running"],
    });
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("activity.canonical_type = {activityType:String}"),
      expect.objectContaining({
        activityIds: ["running-activity", "cycling-activity"],
        activityType: "running",
      }),
    );
    expect(sensorStore.query).toHaveBeenCalledTimes(2);
    expect(database.execute).toHaveBeenCalledTimes(2);
  });

  it("returns server-computed changes from the immediately preceding comparable period", async () => {
    const database = makeDatabase([
      [{ id: "running-activity" }, { id: "prior-activity" }],
      [{ id: "running-activity" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "2",
          current_total_minutes: "150.4",
          current_total_distance_meters: "13000",
          current_total_elevation_gain_m: "240",
          current_distance_measurement_count: "2",
          current_elevation_measurement_count: "2",
          previous_activity_count: "1",
          previous_total_minutes: "60.2",
          previous_total_distance_meters: "5000",
          previous_total_elevation_gain_m: "100",
          previous_distance_measurement_count: "1",
          previous_elevation_measurement_count: "1",
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    const result = await repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" });

    expect(result.comparison).toEqual({
      periodLabel: "previous 4 weeks",
      activityCount: { magnitude: 1, trend: "higher" },
      totalMinutes: { magnitude: 90.2, trend: "higher" },
      totalDistanceMeters: {
        magnitude: 8000,
        trend: "higher",
        state: { status: "available" },
      },
      totalElevationGainM: {
        magnitude: 140,
        trend: "higher",
        state: { status: "available" },
      },
    });

    expect(sensorStore.query.mock.calls[0]?.[1]).toContain("previousWindowStart");
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        previousWindowStart: "2026-01-24",
        currentWindowStart: "2026-02-21",
        endDateExclusive: "2026-03-21",
      }),
    );
    expect(normalizeSql(vi.mocked(sensorStore.query).mock.calls[0]?.[1])).toContain(
      "activity_date < toDate({endDateExclusive:String})",
    );
    expect(normalizeSql(vi.mocked(sensorStore.query).mock.calls[0]?.[1])).toContain(
      "activity_date < toDate({currentWindowStart:String})",
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("activity_date >= toDate({currentWindowStart:String})"),
      expect.objectContaining({
        currentWindowStart: "2026-02-21",
        endDateExclusive: "2026-03-21",
        activityIds: ["running-activity"],
      }),
    );
  });

  it("uses only current-period visible IDs for the activity-types query", async () => {
    const database = makeDatabase([
      [{ id: "current-activity" }, { id: "previous-only-activity" }],
      [{ id: "current-activity" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 1,
          current_total_minutes: 60,
          current_total_distance_meters: null,
          current_total_elevation_gain_m: null,
          current_distance_measurement_count: 0,
          current_elevation_measurement_count: 0,
          previous_activity_count: 1,
          previous_total_minutes: 45,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" });

    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        activityIds: ["current-activity", "previous-only-activity"],
      }),
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("SELECT DISTINCT"),
      expect.objectContaining({ activityIds: ["current-activity"] }),
    );
  });

  it("preserves unavailable overview measurements as null", async () => {
    const database = makeDatabase([
      [{ id: "activity-without-measurements" }],
      [{ id: "activity-without-measurements" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "1",
          current_total_minutes: "60",
          current_total_distance_meters: null,
          current_total_elevation_gain_m: null,
          current_distance_measurement_count: "0",
          current_elevation_measurement_count: "0",
          previous_activity_count: "0",
          previous_total_minutes: "0",
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: "0",
          previous_elevation_measurement_count: "0",
        },
      ],
      [{ canonical_type: "walking" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 1,
      totalMinutes: 60,
      totalDistanceMeters: null,
      totalDistanceState: {
        status: "missing",
        reason: "Distance was not recorded for every activity.",
      },
      totalElevationGainM: null,
      totalElevationState: {
        status: "missing",
        reason: "Elevation gain was not recorded for every activity.",
      },
      activityTypes: ["walking"],
      comparison: {
        periodLabel: "previous 4 weeks",
        activityCount: { magnitude: 1, trend: "higher" },
        totalMinutes: { magnitude: 60, trend: "higher" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Distance was not recorded for every activity.",
          },
        },
        totalElevationGainM: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Elevation gain was not recorded for every activity.",
          },
        },
      },
    });
  });

  it("returns available zero measurements for an empty current period", async () => {
    const database = makeDatabase([[{ id: "previous-activity" }], [{ id: "current-activity" }]]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 0,
          current_total_minutes: 0,
          current_total_distance_meters: null,
          current_total_elevation_gain_m: null,
          current_distance_measurement_count: 0,
          current_elevation_measurement_count: 0,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 0,
      totalMinutes: 0,
      totalDistanceMeters: 0,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 0,
      totalElevationState: { status: "available" },
      comparison: {
        totalDistanceMeters: {
          magnitude: 0,
          trend: "unchanged",
          state: { status: "available" },
        },
        totalElevationGainM: {
          magnitude: 0,
          trend: "unchanged",
          state: { status: "available" },
        },
      },
    });
  });

  it("authors lower, unchanged, and previous-period unavailable comparisons", async () => {
    const database = makeDatabase([
      [{ id: "current" }, { id: "previous-1" }, { id: "previous-2" }],
      [{ id: "current" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 1,
          current_total_minutes: 60,
          current_total_distance_meters: 10000,
          current_total_elevation_gain_m: 120,
          current_distance_measurement_count: 1,
          current_elevation_measurement_count: 1,
          previous_activity_count: 2,
          previous_total_minutes: 60,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: 120,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 2,
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      comparison: {
        activityCount: { magnitude: 1, trend: "lower" },
        totalMinutes: { magnitude: 0, trend: "unchanged" },
        totalDistanceMeters: {
          magnitude: null,
          trend: "unavailable",
          state: {
            status: "missing",
            reason: "Previous period: Distance was not recorded for every activity.",
          },
        },
        totalElevationGainM: {
          magnitude: 0,
          trend: "unchanged",
          state: { status: "available" },
        },
      },
    });
  });

  it("reports partial overview totals as available", async () => {
    const database = makeDatabase([
      [{ id: "run" }, { id: "ride" }],
      [{ id: "run" }, { id: "ride" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 2,
          current_total_minutes: 120,
          current_total_distance_meters: 5000,
          current_total_elevation_gain_m: 100,
          current_distance_measurement_count: 1,
          current_elevation_measurement_count: 2,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "running" }, { canonical_type: "cycling" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 2,
      totalDistanceMeters: 5000,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 100,
      totalElevationState: { status: "available" },
    });
  });

  it("compares partial totals when both periods have measurements", async () => {
    const database = makeDatabase([
      [{ id: "current-1" }, { id: "current-2" }],
      [{ id: "previous-1" }, { id: "previous-2" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 2,
          current_total_minutes: 120,
          current_total_distance_meters: 7500,
          current_total_elevation_gain_m: 150,
          current_distance_measurement_count: 1,
          current_elevation_measurement_count: 1,
          previous_activity_count: 2,
          previous_total_minutes: 90,
          previous_total_distance_meters: 5000,
          previous_total_elevation_gain_m: 100,
          previous_distance_measurement_count: 1,
          previous_elevation_measurement_count: 1,
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      totalDistanceMeters: 7500,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 150,
      totalElevationState: { status: "available" },
      comparison: {
        totalDistanceMeters: {
          magnitude: 2500,
          trend: "higher",
          state: { status: "available" },
        },
        totalElevationGainM: {
          magnitude: 50,
          trend: "higher",
          state: { status: "available" },
        },
      },
    });
  });

  it("counts indoor and virtual zero distance as measured with outdoor totals", async () => {
    const database = makeDatabase([
      [{ id: "indoor" }, { id: "run" }],
      [{ id: "indoor" }, { id: "run" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 2,
          current_total_minutes: 120,
          current_total_distance_meters: 5000,
          current_total_elevation_gain_m: 100,
          current_distance_measurement_count: 2,
          current_elevation_measurement_count: 2,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "indoor_cycling" }, { canonical_type: "running" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 2,
      totalDistanceMeters: 5000,
      totalDistanceState: { status: "available" },
    });

    const overviewQuery = normalizeSql(vi.mocked(sensorStore.query).mock.calls[0]?.[1]);
    expect(overviewQuery).toContain("sumOrNullIf(");
    expect(overviewQuery).toContain("summary.total_distance IS NOT NULL");
  });

  it("returns an empty overview without querying ClickHouse when no activities are visible", async () => {
    const database = makeDatabase([[]]);
    const sensorStore = makeSensorStore([]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 0,
      totalMinutes: 0,
      totalDistanceMeters: 0,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 0,
      totalElevationState: { status: "available" },
      activityTypes: [],
      comparison: {
        periodLabel: "previous 4 weeks",
        activityCount: { magnitude: 0, trend: "unchanged" },
        totalMinutes: { magnitude: 0, trend: "unchanged" },
        totalDistanceMeters: {
          magnitude: 0,
          trend: "unchanged",
          state: { status: "available" },
        },
        totalElevationGainM: {
          magnitude: 0,
          trend: "unchanged",
          state: { status: "available" },
        },
      },
    });
    expect(sensorStore.query).not.toHaveBeenCalled();
    expect(database.execute).toHaveBeenCalledTimes(1);
  });

  it("uses empty aggregate rows to author available zero comparisons", async () => {
    const database = makeDatabase([[{ id: "activity" }], [{ id: "activity" }]]);
    const sensorStore = makeSensorStore([[], [{ canonical_type: "running" }]]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 0,
      activityTypes: ["running"],
      comparison: {
        activityCount: { magnitude: 0, trend: "unchanged" },
        totalDistanceMeters: {
          magnitude: 0,
          trend: "unchanged",
          state: { status: "available" },
        },
      },
    });
  });

  it("excludes unauthorized activities from overview totals, types, and type-filter paths", async () => {
    const database = makeDatabase([
      [{ id: "authorized-run" }],
      [{ id: "authorized-run" }],
      [{ id: "authorized-run" }],
      [{ id: "authorized-run" }],
    ]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: 1,
          current_total_minutes: 45,
          current_total_distance_meters: 5000,
          current_total_elevation_gain_m: 100,
          current_distance_measurement_count: 1,
          current_elevation_measurement_count: 1,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "running" }],
      [
        {
          current_activity_count: 0,
          current_total_minutes: 0,
          current_total_distance_meters: null,
          current_total_elevation_gain_m: null,
          current_distance_measurement_count: 0,
          current_elevation_measurement_count: 0,
          previous_activity_count: 0,
          previous_total_minutes: 0,
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: 0,
          previous_elevation_measurement_count: 0,
        },
      ],
      [{ canonical_type: "running" }],
    ]);
    const repository = new ActivityOverviewRepository(
      database,
      "00000000-0000-0000-0000-000000000001",
      "UTC",
      sensorStore,
    );

    await expect(
      repository.getActivityOverview({ weeks: 4, endDate: "2026-03-20" }),
    ).resolves.toMatchObject({
      activityCount: 1,
      totalMinutes: 45,
      totalDistanceMeters: 5000,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 100,
      totalElevationState: { status: "available" },
      activityTypes: ["running"],
    });
    await expect(
      repository.getActivityOverview({
        weeks: 4,
        endDate: "2026-03-20",
        activityType: "cycling",
      }),
    ).resolves.toMatchObject({
      activityCount: 0,
      totalMinutes: 0,
      totalDistanceMeters: 0,
      totalDistanceState: { status: "available" },
      totalElevationGainM: 0,
      totalElevationState: { status: "available" },
      activityTypes: ["running"],
    });
    for (const queryCall of vi.mocked(sensorStore.query).mock.calls) {
      expect(queryCall[2]).toMatchObject({ activityIds: ["authorized-run"] });
      expect(queryCall[2]).not.toEqual(
        expect.objectContaining({ activityIds: expect.arrayContaining(["unauthorized-ride"]) }),
      );
    }
  });

  it("computes overview totals from canonical one-row-per-activity summaries", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "1",
          current_total_minutes: "60",
          current_total_distance_meters: "0",
          current_total_elevation_gain_m: "0",
          current_distance_measurement_count: "1",
          current_elevation_measurement_count: "1",
          previous_activity_count: "0",
          previous_total_minutes: "0",
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: "0",
          previous_elevation_measurement_count: "0",
        },
      ],
      [{ canonical_type: "cycling" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await repository.getActivityOverview({ weeks: 1, endDate: "2026-03-20" });

    const overviewQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const normalizedOverviewQuery = normalizeSql(overviewQueryText);
    expect(normalizedOverviewQuery).toContain(
      "FROM analytics.deduped_activities AS activity FINAL",
    );
    expect(normalizedOverviewQuery).not.toContain("analytics.v_activity");
    expect(normalizedOverviewQuery).toContain("LEFT JOIN analytics.activity_summary AS summary");
    expect(normalizedOverviewQuery).toContain(
      "sumIf( dateDiff('second', activity.started_at, activity.ended_at) / 60.0",
    );
    expect(normalizedOverviewQuery).toContain("sumOrNullIf( summary.total_distance");
    expect(normalizedOverviewQuery).toContain("sumOrNullIf( summary.elevation_gain_m");
    expect(normalizedOverviewQuery).toContain("summary.total_distance IS NOT NULL");
    expect(normalizedOverviewQuery).toContain("summary.elevation_gain_m IS NOT NULL");
    expect(normalizedOverviewQuery).toContain("activity.activity_id IN {activityIds:Array(UUID)}");
  });

  it("uses deduped activities as the activity overview identity source", async () => {
    const database = makeDatabase([]);
    const sensorStore = makeSensorStore([
      [
        {
          current_activity_count: "1",
          current_total_minutes: "60",
          current_total_distance_meters: "0",
          current_total_elevation_gain_m: "0",
          current_distance_measurement_count: "1",
          current_elevation_measurement_count: "1",
          previous_activity_count: "0",
          previous_total_minutes: "0",
          previous_total_distance_meters: null,
          previous_total_elevation_gain_m: null,
          previous_distance_measurement_count: "0",
          previous_elevation_measurement_count: "0",
        },
      ],
      [{ canonical_type: "cycling" }],
    ]);
    const repository = new ActivityOverviewRepository(database, "user-1", "UTC", sensorStore);

    await repository.getActivityOverview({ weeks: 1, endDate: "2026-03-20" });

    const overviewQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const normalizedOverviewQuery = normalizeSql(overviewQueryText);
    expect(normalizedOverviewQuery).toContain(
      "FROM analytics.deduped_activities AS activity FINAL",
    );
    expect(normalizedOverviewQuery).not.toContain("analytics.v_activity");
    expect(normalizedOverviewQuery).toContain("activity.activity_id IN {activityIds:Array(UUID)}");
  });
});
