import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  activityMetricParams,
  getActivityMetricSources,
  getActivitySourceHrZones,
} from "./activity-metric-sources-repository.ts";

const window = {
  activityId: "22222222-2222-2222-2222-222222222222",
  userId: "11111111-1111-1111-1111-111111111111",
  startedAt: "2026-10-20T12:00:00.000Z",
  endedAt: "2026-10-20T13:00:00.000Z",
  memberActivityIds: ["22222222-2222-2222-2222-222222222222"],
};
function storeWithRows(rows: unknown[]) {
  return {
    query: vi.fn(
      async <T extends z.ZodType>(
        schema: T,
        _sql: string,
        _params?: Record<string, unknown>,
      ): Promise<z.infer<T>[]> => rows.map((row) => schema.parse(row)),
    ),
  };
}

describe("activity heart-rate sources", () => {
  it("labels device sources and preselects the highest-priority available provider", async () => {
    const whoopBluetoothSourceId = '["whoop_ble","strap-a"]';
    const garminSourceId = '["garmin","Edge 530"]';
    const store = storeWithRows([
      { channel: "heart_rate", provider_id: "whoop", device_id: null, source_id: "whoop" },
      {
        channel: "heart_rate",
        provider_id: "whoop_ble",
        device_id: "strap-a",
        source_id: whoopBluetoothSourceId,
      },
      {
        channel: "heart_rate",
        provider_id: "garmin",
        device_id: "Edge 530",
        source_id: garminSourceId,
      },
    ]);
    expect(await getActivityMetricSources(store, window)).toEqual([
      {
        key: "heartRate",
        label: "Heart Rate",
        sources: [
          { id: "whoop", label: "WHOOP (Cloud)" },
          { id: whoopBluetoothSourceId, label: "WHOOP (Bluetooth)" },
          { id: garminSourceId, label: "Garmin · Edge 530" },
        ],
        defaultSourceId: "whoop",
      },
    ]);
  });
  it("returns no default when the activity has no HR samples", async () => {
    expect(await getActivityMetricSources(storeWithRows([]), window)).toEqual([]);
  });
  it("bounds open-ended activities to twelve hours", () => {
    expect(activityMetricParams({ ...window, endedAt: null }).windowEndedAt).toBe(
      "2026-10-21T00:00:00.000Z",
    );
  });
  it("maps source-specific zone counts into the same zone contract as default HR", async () => {
    const zones = await getActivitySourceHrZones(
      storeWithRows([{ zone0: 0, zone1: 10, zone2: 30, zone3: 0, zone4: 0, zone5: 0 }]),
      window,
      "garmin",
    );
    expect(zones.find((zone) => zone.zone === 2)).toMatchObject({ seconds: 30, percent: 75 });
  });
  it("uses the interpolated median for an even number of resting-HR baselines", async () => {
    const store = storeWithRows([]);
    await getActivitySourceHrZones(store, window, "garmin");
    expect(store.query.mock.calls[0]?.[1]).toContain("quantileExactInclusive(0.5)");
  });
});

it("lists each metric independently without discarding recorded zeros or negative elevation", async () => {
  const store = storeWithRows([
    { channel: "heart_rate", provider_id: "whoop", device_id: null, source_id: "whoop" },
    { channel: "power", provider_id: "garmin", device_id: null, source_id: "garmin" },
    { channel: "power", provider_id: "wahoo", device_id: null, source_id: "wahoo" },
    { channel: "altitude", provider_id: "garmin", device_id: null, source_id: "garmin" },
  ]);
  const metrics = await getActivityMetricSources(store, window);
  expect(metrics.map((metric) => [metric.key, metric.defaultSourceId])).toEqual([
    ["heartRate", "whoop"],
    ["power", "garmin"],
    ["altitude", "garmin"],
  ]);
  expect(
    metrics.find((metric) => metric.key === "power")?.sources.map((source) => source.id),
  ).toEqual(["garmin", "wahoo"]);
  const query = store.query.mock.calls[0]?.[1] ?? "";
  expect(query).toContain("channel != 'heart_rate' OR scalar > 0");
});

it("keeps different devices imported through the same provider as separate sources", async () => {
  const watchId = '["apple_health","Apple Watch"]';
  const zeppId = '["apple_health","Zepp"]';
  const metrics = await getActivityMetricSources(
    storeWithRows([
      { channel: "heart_rate", provider_id: "apple_health", device_id: "Zepp", source_id: zeppId },
      {
        channel: "heart_rate",
        provider_id: "apple_health",
        device_id: "Apple Watch",
        source_id: watchId,
      },
    ]),
    window,
  );
  expect(metrics[0]?.defaultSourceId).toBe(zeppId);
  expect(metrics[0]?.sources).toEqual([
    { id: zeppId, label: "Zepp (via Apple Health)" },
    { id: watchId, label: "Apple Watch (via Apple Health)" },
  ]);
});
