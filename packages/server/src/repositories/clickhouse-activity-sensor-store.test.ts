import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";

describe("ClickHouseActivitySensorStore", () => {
  function makeStore(rows: Record<string, unknown>[] = []) {
    const json = vi.fn().mockResolvedValue(rows);
    const query = vi.fn().mockResolvedValue({ json });
    const command = vi.fn().mockResolvedValue(undefined);
    const client = { command, query };
    return { store: new ClickHouseActivitySensorStore(client), command, query, json };
  }

  const window = {
    activityId: "22222222-2222-2222-2222-222222222222",
    userId: "11111111-1111-1111-1111-111111111111",
    startedAt: "2024-01-15T10:00:00.000Z",
    endedAt: "2024-01-15T11:00:00.000Z",
    memberActivityIds: [
      "22222222-2222-2222-2222-222222222222",
      "33333333-3333-3333-3333-333333333333",
    ],
  };

  it("passes abort signals to raw ClickHouse queries", async () => {
    const { store, query } = makeStore([{ ok: 1 }]);
    const abortController = new AbortController();

    await store.query(z.object({ ok: z.number() }), "SELECT 1 AS ok", undefined, {
      abortSignal: abortController.signal,
    });

    expect(query).toHaveBeenCalledWith({
      query: "SELECT 1 AS ok",
      format: "JSONEachRow",
      query_params: {},
      abort_signal: abortController.signal,
    });
  });

  it("queries precomputed activity stream points from the ClickHouse read model", async () => {
    const { store, query } = makeStore([
      {
        recorded_at: "2024-01-15 10:00:00.000",
        heart_rate: 140,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
    ]);

    const rows = await store.getStream(window, 500);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.recorded_at).toBe("2024-01-15T10:00:00.000Z");
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "JSONEachRow",
        query: expect.stringContaining("analytics.activity_stream_points"),
        query_params: expect.objectContaining({
          activityIds: window.memberActivityIds,
          maxPoints: 500,
          userId: window.userId,
        }),
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("ARRAY JOIN points AS point");
    expect(queryText).toContain("AND is_deleted = 0");
    expect(queryText).toContain(
      "any(tuple(heart_rate, power, speed, cadence, altitude, lat, lng)) AS point_values",
    );
    expect(queryText).toContain("downsampled_points AS");
    expect(queryText).toContain("argMinIf(heart_rate, sample_recorded_at, heart_rate IS NOT NULL)");
    expect(queryText).toContain("sample_lat IS NOT NULL AND sample_lng IS NOT NULL");
    expect(queryText).toContain("toUInt64({maxPoints:UInt32})");
    expect(queryText).toContain("ORDER BY recorded_at");
    expect(queryText).not.toContain("any(heart_rate) AS heart_rate");
    expect(queryText).not.toContain("analytics.activity_sensor_sample");
    expect(queryText).not.toContain("analytics.activity_location_sample");
    expect(queryText).not.toContain("fitness.metric_stream");
    expect(queryText).not.toContain("fitness.deduped_sensor");
    expect(queryText).not.toContain("analytics.deduped_sensor");
    expect(queryText).not.toContain("analytics.deduped_location");
  });

  it("returns no stream points when the read model has no rows", async () => {
    const { store } = makeStore([]);

    await expect(store.getStream(window, 500)).resolves.toEqual([]);
  });

  it("queries activity summaries from the ClickHouse analytics schema", async () => {
    const { store, query } = makeStore([
      {
        activity_id: window.activityId,
        avg_hr: 145,
        max_hr: 170,
        avg_power: 210,
        max_power: 400,
        avg_speed: 8,
        max_speed: 12,
        avg_cadence: 85,
        total_distance: 30000,
        elevation_gain_m: 500,
        elevation_loss_m: 450,
        sample_count: 3600,
      },
    ]);

    const rows = await store.getActivitySummaries([window.activityId]);

    expect(rows[0]?.avg_hr).toBe(145);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("FROM analytics.activity_summary"),
        query_params: { activityIds: [window.activityId] },
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).not.toContain("analytics.v_activity");
    expect(queryText).toContain(
      "activity_id IN (\n          SELECT arrayJoin(CAST({activityIds:Array(String)}, 'Array(UUID)'))",
    );
  });

  it("returns no activity summaries when ClickHouse returns no rows", async () => {
    const { store } = makeStore([]);

    await expect(store.getActivitySummaries([window.activityId])).resolves.toEqual([]);
  });

  it("loads power curve samples from activity summary", async () => {
    const { store, query } = makeStore([]);

    await store.getPowerCurveSamples(90, window.userId, "UTC", ["cycling"]);

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("analytics.deduped_activities");
    expect(queryText).not.toContain("analytics.v_activity");
    expect(queryText).toContain("activity.activity_id AS activity_id");
    expect(queryText).toContain("analytics.deduped_sensor");
    expect(queryText).toContain("activity.started_at > now() - toIntervalDay({days:UInt32})");
    expect(query.mock.calls[0]?.[0]?.query_params).toMatchObject({
      days: 90,
      activityTypes: ["cycling"],
    });
  });

  it("omits the activity date lower bound for unbounded power curve samples", async () => {
    const { store, query } = makeStore([]);

    await store.getPowerCurveSamples(null, window.userId, "UTC", ["cycling"]);

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("analytics.deduped_activities");
    expect(queryText).not.toContain("activity.started_at > now() - toIntervalDay");
    expect(query.mock.calls[0]?.[0]?.query_params).not.toHaveProperty("days");
  });

  it("loads normalized power samples from activity summary", async () => {
    const { store, query } = makeStore([]);

    await store.getNormalizedPowerSamples(365, window.userId, "UTC", ["cycling"]);

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("analytics.deduped_activities");
    expect(queryText).not.toContain("analytics.v_activity");
    expect(queryText).toContain("activity.activity_id AS activity_id");
    expect(queryText).toContain("analytics.deduped_sensor");
    expect(queryText).toContain("has({activityTypes:Array(String)}, activity.canonical_type)");
    expect(queryText).toContain("activity.started_at > now() - toIntervalDay({days:UInt32})");
    expect(queryText).not.toContain("enduranceActivityTypes");
    expect(query.mock.calls[0]?.[0]?.query_params).toMatchObject({
      days: 365,
      activityTypes: ["cycling"],
    });
  });

  it("omits the activity date lower bound for unbounded normalized power samples", async () => {
    const { store, query } = makeStore([]);

    await store.getNormalizedPowerSamples(null, window.userId, "UTC", ["cycling"]);

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("analytics.deduped_activities");
    expect(queryText).not.toContain("activity.started_at > now() - toIntervalDay");
    expect(query.mock.calls[0]?.[0]?.query_params).not.toHaveProperty("days");
  });

  it("loads VO2 max estimates from the compact activity read model", async () => {
    const { store, query } = makeStore([
      {
        activity_id: window.activityId,
        activity_date: "2026-04-28",
        method: "cycling_power",
        vo2max: 50,
      },
    ]);

    const rows = await store.getVo2MaxEstimates("2026-04-28", 90, window.userId, "UTC");

    expect(rows).toEqual([
      {
        activity_id: window.activityId,
        activity_date: "2026-04-28",
        method: "cycling_power",
        vo2max: 50,
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "JSONEachRow",
        query_params: expect.objectContaining({
          endDate: "2026-04-28",
          days: 90,
          userId: window.userId,
          timezone: "UTC",
        }),
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("FROM analytics.activity_vo2max_estimate FINAL");
    expect(queryText).not.toContain("analytics.deduped_sensor");
    expect(queryText).not.toContain("analytics.v_activity");
    expect(queryText).not.toContain("analytics.v_body_measurement");
    expect(queryText).not.toContain("resting_heart_rate AS");
    expect(queryText).not.toContain("analytics.resting_heart_rate_sleep_window");
    expect(queryText).not.toContain("fitness.derived_vo2max_estimates");
    expect(queryText).not.toContain("fitness.metric_stream");
  });

  it("counts power zones from the same bounded source selection", async () => {
    const { store, query } = makeStore([{ zone: 1, seconds: 5 }]);

    const rows = await store.getPowerZoneSeconds(window, 275);

    expect(rows).toEqual([{ zone: 1, seconds: 5 }]);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "JSONEachRow",
        query_params: expect.objectContaining({
          activityIds: window.memberActivityIds,
          ftp: 275,
        }),
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("analytics.deduped_sensor");
    expect(queryText).toContain(
      "recorded_at >= parseDateTime64BestEffort({windowStartedAt:String})",
    );
    expect(queryText).toContain("recorded_at <= parseDateTime64BestEffort({windowEndedAt:String})");
    expect(queryText).toContain("is_deleted = 0");
    expect(queryText).toContain("channel = 'power'");
  });

  it("caps open-ended activity windows before reading precomputed stream points", async () => {
    const openEndedWindow = { ...window, endedAt: undefined };
    const { store, query } = makeStore([]);

    await store.getStream(openEndedWindow, 500);

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(query.mock.calls[0]?.[0]?.query_params).toEqual(
      expect.objectContaining({
        windowEndedAt: "2024-01-15T22:00:00.000Z",
      }),
    );
    expect(queryText).toContain("point.1 <= parseDateTime64BestEffort({windowEndedAt:String})");
  });

  it("loads heart-rate zones from the ClickHouse read model", async () => {
    const { store, query } = makeStore([{ zone: 0, seconds: 5 }]);

    const rows = await store.getHeartRateZoneSeconds(window);

    expect(rows).toEqual([{ zone: 0, seconds: 5 }]);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "JSONEachRow",
        query_params: expect.objectContaining({
          activityIds: window.memberActivityIds,
        }),
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("analytics.activity_heart_rate_zones");
    expect(queryText).toContain("ARRAY JOIN zones AS zone_tuple");
    expect(queryText).toContain("AND is_deleted = 0");
    expect(queryText).toContain("sum(zone_tuple.2) AS seconds");
    expect(queryText).toContain("GROUP BY zone_tuple.1");
    expect(queryText).not.toContain("analytics.deduped_sensor");
    expect(queryText).not.toContain("analytics.activity_sensor_sample");
    expect(queryText).not.toContain("FROM (SELECT number AS zone FROM numbers(6)) AS zones");
  });

  it("returns no heart-rate zones when the read model has no rows", async () => {
    const { store } = makeStore([]);

    await expect(store.getHeartRateZoneSeconds(window)).resolves.toEqual([]);
  });

  it("coerces numeric ClickHouse read-model rows at runtime", async () => {
    const { store } = makeStore([
      {
        recorded_at: "2024-01-15 10:00:00.000",
        heart_rate: "140",
        power: "225.5",
        speed: null,
        cadence: "90",
        altitude: null,
        lat: "37.1",
        lng: "-122.1",
      },
    ]);

    const rows = await store.getStream(window, 500);

    expect(rows).toEqual([
      {
        recorded_at: "2024-01-15T10:00:00.000Z",
        heart_rate: 140,
        power: 225.5,
        speed: null,
        cadence: 90,
        altitude: null,
        lat: 37.1,
        lng: -122.1,
      },
    ]);
  });

  it("rejects invalid numeric ClickHouse stream values", async () => {
    const { store } = makeStore([
      {
        recorded_at: "2024-01-15 10:00:00.000",
        heart_rate: "not-a-number",
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
    ]);

    await expect(store.getStream(window, 500)).rejects.toThrow();
  });

  it("coerces heart-rate zone rows at runtime", async () => {
    const { store } = makeStore([{ zone: "2", seconds: "15" }]);

    const rows = await store.getHeartRateZoneSeconds(window);

    expect(rows).toEqual([{ zone: 2, seconds: 15 }]);
  });

  it("rejects invalid numeric ClickHouse heart-rate zone values", async () => {
    const { store } = makeStore([{ zone: "not-a-number", seconds: "15" }]);

    await expect(store.getHeartRateZoneSeconds(window)).rejects.toThrow();
  });

  it("clamps heart-rate duration windows to at least one sample", async () => {
    const { store, query } = makeStore([]);

    await store.getHeartRateCurveRows(30, window.userId, "UTC");

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain(
      "greatest(1, toInt32(round(duration_values.duration_s / sample_rate.interval_s)))",
    );
    expect(queryText).toContain("analytics.deduped_activities");
    expect(queryText).toContain("activity.activity_id AS activity_id");
    expect(queryText).not.toContain("analytics.v_activity");
  });

  it("omits lower-bound filters from heart-rate duration rows when days is null", async () => {
    const { store, query } = makeStore([]);

    await store.getHeartRateCurveRows(null, window.userId, "UTC");

    const queryOptions = query.mock.calls[0]?.[0];
    expect(queryOptions?.query).not.toContain(
      "activity.started_at > now() - toIntervalDay({days:UInt32})",
    );
    expect(queryOptions?.query_params).not.toHaveProperty("days");
  });

  it("clamps pace duration windows to at least one sample", async () => {
    const { store, query } = makeStore([]);

    await store.getPaceCurveRows(30, window.userId, "UTC");

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain(
      "greatest(1, toInt32(round(duration_values.duration_s / sample_rate.interval_s)))",
    );
    expect(queryText).toContain("analytics.deduped_activities");
    expect(queryText).toContain("activity.activity_id AS activity_id");
    expect(queryText).not.toContain("analytics.v_activity");
  });

  it("applies finite lower-bound filters to pace duration rows", async () => {
    const { store, query } = makeStore([]);

    await store.getPaceCurveRows(30, window.userId, "UTC");

    const queryOptions = query.mock.calls[0]?.[0];
    expect(queryOptions?.query).toContain(
      "activity.started_at > now() - toIntervalDay({days:UInt32})",
    );
    expect(queryOptions?.query_params).toMatchObject({ days: 30, userId: window.userId });
  });

  it("omits lower-bound filters from pace duration rows when days is null", async () => {
    const { store, query } = makeStore([]);

    await store.getPaceCurveRows(null, window.userId, "UTC");

    const queryOptions = query.mock.calls[0]?.[0];
    expect(queryOptions?.query).not.toContain(
      "activity.started_at > now() - toIntervalDay({days:UInt32})",
    );
    expect(queryOptions?.query_params).not.toHaveProperty("days");
  });
});
