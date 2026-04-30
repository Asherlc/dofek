import { describe, expect, it, vi } from "vitest";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";

describe("ClickHouseActivitySensorStore", () => {
  function makeStore(rows: Record<string, unknown>[] = []) {
    const json = vi.fn().mockResolvedValue(rows);
    const query = vi.fn().mockResolvedValue({ json });
    const client = { query };
    return { store: new ClickHouseActivitySensorStore(client), query, json };
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

  it("queries linked and ambient samples inside the activity window", async () => {
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
        query: expect.stringContaining("analytics.deduped_sensor"),
        query_params: expect.objectContaining({
          activityId: window.activityId,
          userId: window.userId,
          maxPoints: 500,
        }),
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).not.toContain("fitness.metric_stream");
    expect(queryText).not.toContain("fitness.deduped_sensor");
    expect(queryText).toContain("activity_id = {activityId:UUID}");
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
  });

  it("counts power zones from the same bounded source selection", async () => {
    const { store, query } = makeStore([{ zone: 1, seconds: 5 }]);

    const rows = await store.getPowerZoneSeconds(window, 275);

    expect(rows).toEqual([{ zone: 1, seconds: 5 }]);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "JSONEachRow",
        query_params: expect.objectContaining({
          activityId: window.activityId,
          ftp: 275,
        }),
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("analytics.deduped_sensor");
    expect(queryText).toContain("channel = 'power'");
  });

  it("clamps heart-rate duration windows to at least one sample", async () => {
    const { store, query } = makeStore([]);

    await store.getHeartRateCurveRows(30, window.userId, "UTC");

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain(
      "greatest(1, toInt32(round(duration_values.duration_s / sample_rate.interval_s)))",
    );
    expect(queryText).not.toContain(
      "/ toFloat64(toInt32(round(duration_values.duration_s / sample_rate.interval_s)))",
    );
  });

  it("clamps pace duration windows to at least one sample", async () => {
    const { store, query } = makeStore([]);

    await store.getPaceCurveRows(30, window.userId, "UTC");

    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain(
      "greatest(1, toInt32(round(duration_values.duration_s / sample_rate.interval_s)))",
    );
    expect(queryText).not.toContain(
      "/ toFloat64(toInt32(round(duration_values.duration_s / sample_rate.interval_s)))",
    );
  });
});
