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
        query: expect.stringContaining("fitness.metric_stream"),
        query_params: expect.objectContaining({
          userId: window.userId,
          memberActivityIds: window.memberActivityIds,
          startedAt: window.startedAt,
          endedAt: window.endedAt,
          maxPoints: 500,
        }),
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("linked_best_source");
    expect(queryText).toContain("ambient_best_source");
    expect(queryText).toContain("fitness.metric_stream AS metric_stream FINAL");
    expect(queryText).toContain("activity_id IN {memberActivityIds:Array(UUID)}");
  });

  it("counts power zones from the same bounded source selection", async () => {
    const { store, query } = makeStore([{ zone: 1, seconds: 5 }]);

    const rows = await store.getPowerZoneSeconds(window, 275);

    expect(rows).toEqual([{ zone: 1, seconds: 5 }]);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "JSONEachRow",
        query_params: expect.objectContaining({
          ftp: 275,
          memberActivityIds: window.memberActivityIds,
        }),
      }),
    );
    const queryText = query.mock.calls[0]?.[0]?.query;
    expect(queryText).toContain("linked_best_source");
    expect(queryText).toContain("channel = 'power'");
  });
});
