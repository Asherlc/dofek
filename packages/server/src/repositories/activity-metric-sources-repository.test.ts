import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { normalizeActivityHardware } from "../models/activity-hardware.ts";
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
      ): Promise<z.infer<T>[]> =>
        rows.map((row) =>
          schema.parse({
            activity_ids: window.memberActivityIds,
            ...z.record(z.string(), z.unknown()).parse(row),
          }),
        ),
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

it("enriches recorder labels without changing identities, order, defaults, or attributing sensors", async () => {
  const hardware: ActivityHardware = {
    items: [
      {
        id: "recorder",
        activityId: window.activityId,
        providerId: "strava",
        sourceName: null,
        role: "recorder",
        label: "Edge 530",
        model: null,
        manufacturer: null,
        evidence: "Reported",
        details: [],
      },
      {
        id: "sensor",
        activityId: window.activityId,
        providerId: "strava",
        sourceName: null,
        role: "sensor",
        label: "HRM-Pro",
        model: null,
        manufacturer: null,
        evidence: "Observed",
        details: [],
      },
    ],
    power: [],
  };
  const rows = [
    { channel: "heart_rate", provider_id: "strava", device_id: null, source_id: "strava" },
    { channel: "heart_rate", provider_id: "garmin", device_id: null, source_id: "garmin" },
  ];
  const before = await getActivityMetricSources(storeWithRows(rows), window);
  const after = await getActivityMetricSources(storeWithRows(rows), window, hardware);
  expect(after[0]?.sources[0]).toEqual({ id: "strava", label: "Strava · recorded by Edge 530" });
  expect(
    after.map((metric) => ({ ...metric, sources: metric.sources.map(({ id }) => id) })),
  ).toEqual(before.map((metric) => ({ ...metric, sources: metric.sources.map(({ id }) => id) })));
});
it("qualifies creator-only FIT provenance and prefers separately reported recorder evidence without selection changes", async () => {
  for (const providerId of ["fit-file", "garmin"]) {
    const hardware = normalizeActivityHardware([
      {
        activityId: window.activityId,
        providerId,
        sourceName: null,
        raw: providerId === "garmin" ? { deviceName: "Edge 530" } : null,
        observations: [
          { sequence: 0, messageType: "file_id", raw: { product_name: "Export platform" } },
        ],
      },
    ]);
    const rows = [
      { channel: "power", provider_id: providerId, device_id: null, source_id: providerId },
    ];
    const before = await getActivityMetricSources(storeWithRows(rows), window);
    const after = await getActivityMetricSources(storeWithRows(rows), window, hardware);
    expect(after[0]?.sources[0]?.label).toBe(
      providerId === "garmin"
        ? "Garmin · recorded by Edge 530"
        : "FIT File · file created by Export platform",
    );
    expect(
      after.map((metric) => [
        metric.key,
        metric.defaultSourceId,
        metric.sources.map((source) => source.id),
      ]),
    ).toEqual(
      before.map((metric) => [
        metric.key,
        metric.defaultSourceId,
        metric.sources.map((source) => source.id),
      ]),
    );
  }
});
it("keeps coarse equipment, app, and import provenance out of recorder labels", async () => {
  for (const [providerId, raw] of [
    ["ride-with-gps", { source: "garmin_connect" }],
    ["amazfit-zepp", { source: "watch", app_name: "Zepp" }],
    ["peloton", { deviceType: "bike", platform: "home_bike" }],
  ] as const) {
    const hardware = normalizeActivityHardware([
      { activityId: window.activityId, providerId, sourceName: null, raw, observations: [] },
    ]);
    const rows = [
      { channel: "heart_rate", provider_id: providerId, device_id: null, source_id: providerId },
    ];
    const original = await getActivityMetricSources(storeWithRows(rows), window);
    expect(await getActivityMetricSources(storeWithRows(rows), window, hardware)).toEqual(original);
    expect(hardware.items).toHaveLength(1);
  }
});
it("qualifies a creator name even when it already appears in the original source label", async () => {
  const sourceId = '["fit-file","Export platform"]';
  const hardware = normalizeActivityHardware([
    {
      activityId: window.activityId,
      providerId: "fit-file",
      sourceName: "Export platform",
      raw: null,
      observations: [
        { sequence: 0, messageType: "file_id", raw: { product_name: "Export platform" } },
      ],
    },
  ]);
  const result = await getActivityMetricSources(
    storeWithRows([
      {
        channel: "power",
        provider_id: "fit-file",
        device_id: "Export platform",
        source_id: sourceId,
      },
    ]),
    window,
    hardware,
  );
  expect(result[0]?.sources[0]).toEqual({
    id: sourceId,
    label: "FIT File · file created by Export platform",
  });
  expect(result[0]?.defaultSourceId).toBe(sourceId);
});

it("does not apply an activity recorder to standalone recordings or ambiguous recorders", async () => {
  const hardware: ActivityHardware = {
    items: [
      {
        id: "recorder",
        activityId: window.activityId,
        providerId: "strava",
        sourceName: null,
        role: "recorder",
        label: "Edge",
        model: null,
        manufacturer: null,
        evidence: "Reported",
        details: [],
      },
    ],
    power: [],
  };
  const result = await getActivityMetricSources(
    storeWithRows([
      {
        activity_ids: [],
        channel: "power",
        provider_id: "strava",
        device_id: null,
        source_id: "strava",
      },
    ]),
    window,
    hardware,
  );
  expect(result[0]?.sources[0]?.label).toBe("Strava");
});

it("uses the reported BLE name while keeping the peripheral UUID source identity", async () => {
  const store = storeWithRows([
    {
      channel: "heart_rate",
      provider_id: "ble_heart_rate",
      device_id: "uuid",
      source_id: '["ble_heart_rate","uuid"]',
    },
  ]);
  store.query.mockImplementationOnce(async (schema) =>
    [
      {
        channel: "heart_rate",
        provider_id: "ble_heart_rate",
        device_id: "uuid",
        source_id: '["ble_heart_rate","uuid"]',
        activity_ids: [],
      },
    ].map((row) => schema.parse(row)),
  );
  store.query.mockImplementationOnce(async (schema) =>
    [{ provider_id: "ble_heart_rate", device_id: "uuid", device_name: "Polar H10" }].map((row) =>
      schema.parse(row),
    ),
  );
  const result = await getActivityMetricSources(store, window);
  expect(result[0]?.sources[0]).toEqual({
    id: '["ble_heart_rate","uuid"]',
    label: "Heart Rate Monitor (Bluetooth) · Polar H10",
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
