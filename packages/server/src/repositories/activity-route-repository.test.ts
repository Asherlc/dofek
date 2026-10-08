import { describe, expect, it, vi } from "vitest";
import type { ActivitySensorStore, ActivitySensorWindow } from "./activity-repository.ts";
import { getActivityRoute } from "./activity-route-repository.ts";

const window: ActivitySensorWindow = {
  userId: "11111111-1111-1111-1111-111111111111",
  activityId: "22222222-2222-2222-2222-222222222222",
  memberActivityIds: ["33333333-3333-3333-3333-333333333333"],
  startedAt: "2026-07-01T12:00:00.000Z",
  endedAt: "2026-07-01T13:00:00.000Z",
};

describe("getActivityRoute", () => {
  it("withholds coordinates while the source is newer than the route model", async () => {
    const query = vi.fn().mockResolvedValue([{ is_processing: 1, gps_count: 1 }]);
    const store: Pick<ActivitySensorStore, "query"> = { query };

    await expect(getActivityRoute(store, window, 500)).resolves.toEqual({ status: "processing" });
    expect(query).toHaveBeenCalledOnce();
  });

  it("reports no GPS when the current route model has no live points", async () => {
    const query = vi.fn().mockResolvedValue([{ is_processing: 0, gps_count: 0 }]);
    const store: Pick<ActivitySensorStore, "query"> = { query };

    await expect(getActivityRoute(store, window, 500)).resolves.toEqual({ status: "unavailable" });
    expect(query).toHaveBeenCalledOnce();
  });

  it("returns model coordinates after the source is fully represented", async () => {
    const points = [
      { lat: 37.1, lng: -122.1 },
      { lat: 37.9, lng: -122.9 },
    ];
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ is_processing: 0, gps_count: 2 }])
      .mockResolvedValueOnce(points);
    const store: Pick<ActivitySensorStore, "query"> = { query };

    await expect(getActivityRoute(store, window, 500)).resolves.toEqual({
      status: "ready",
      points,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("reports no route if there are no points inside the activity window", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ is_processing: 0, gps_count: 1 }])
      .mockResolvedValueOnce([]);
    const store: Pick<ActivitySensorStore, "query"> = { query };

    await expect(getActivityRoute(store, window, 500)).resolves.toEqual({ status: "unavailable" });
  });

  it("fails when the freshness query unexpectedly returns no row", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const store: Pick<ActivitySensorStore, "query"> = { query };

    await expect(getActivityRoute(store, window, 500)).rejects.toThrow(
      "Activity route freshness query returned no row",
    );
  });
});
