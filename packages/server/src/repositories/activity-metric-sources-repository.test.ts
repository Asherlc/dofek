import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { describe, expect, it } from "vitest";
import { normalizeActivityHardware } from "../models/activity-hardware.ts";
import { buildActivitySourceTree } from "../models/activity-source-tree.ts";
import {
  storeWithRows,
  activityMetricWindow as window,
} from "./activity-metric-source-test-helpers.ts";
import {
  activityMetricParams,
  getActivityMetricSources,
} from "./activity-metric-sources-repository.ts";

describe("canonical metric source inheritance", () => {
  it.each(["recorder", "creator"] as const)(
    "retains %s hardware qualifiers alongside inherited attribution",
    async (role) => {
      const tree = buildActivitySourceTree(
        { status: "resolved", memberActivityId: "original", providerId: "wahoo", sourceName: null },
        [
          {
            memberActivityId: "original",
            providerId: "wahoo",
            externalId: "original",
            subsource: null,
            label: "Wahoo",
            url: null,
          },
          {
            memberActivityId: "copy",
            providerId: "strava",
            externalId: "copy",
            subsource: null,
            label: "Strava",
            url: null,
          },
        ],
        [
          {
            upstreamMemberActivityId: "original",
            downstreamMemberActivityId: "copy",
            field: "external_id",
            value: "original",
          },
        ],
      );
      const hardware = normalizeActivityHardware([
        {
          activityId: "copy",
          providerId: "strava",
          sourceName: null,
          raw: role === "recorder" ? { device_name: "Edge 530" } : null,
          observations:
            role === "creator"
              ? [{ sequence: 0, messageType: "file_id", raw: { product_name: "Export platform" } }]
              : [],
        },
      ]);
      const result = await getActivityMetricSources(
        storeWithRows([
          {
            channel: "heart_rate",
            provider_id: "strava",
            device_id: null,
            source_id: "copy-recording",
            activity_ids: ["copy"],
          },
        ]),
        window,
        hardware,
        tree,
      );
      expect(result[0]?.sources[0]).toMatchObject({
        id: "copy-recording",
        label:
          role === "recorder"
            ? "Wahoo via Strava · recorded by Edge 530"
            : "Wahoo via Strava · file created by Export platform",
        presentation: {
          displayName: role === "recorder" ? "Edge 530" : "Wahoo",
          providerId: "wahoo",
          attribution: { kind: "provider", providerId: "strava" },
        },
      });
    },
  );
  it("preserves per-sample device attribution instead of replacing it with workout ancestry", async () => {
    const tree = buildActivitySourceTree(
      {
        status: "resolved",
        memberActivityId: "whoop-member",
        providerId: "whoop",
        sourceName: null,
      },
      ["whoop", "apple_health"].map((providerId) => ({
        memberActivityId: `${providerId}-member`,
        providerId,
        externalId: providerId,
        subsource: null,
        label: providerId,
        url: null,
      })),
      [
        {
          upstreamMemberActivityId: "whoop-member",
          downstreamMemberActivityId: "apple_health-member",
          field: "external_id",
          value: "reference",
        },
      ],
    );
    const result = await getActivityMetricSources(
      storeWithRows([
        {
          channel: "heart_rate",
          provider_id: "apple_health",
          device_id: "Apple Watch",
          source_id: "watch-recording",
          activity_ids: ["apple_health-member"],
        },
      ]),
      window,
      { items: [], power: [] },
      tree,
    );
    expect(result[0]?.sources[0]?.presentation).toMatchObject({
      displayName: "Apple Watch",
      providerId: "apple_health",
      sourceName: "Apple Watch",
      attribution: { kind: "apple_health" },
    });
  });
  it("keeps a sample provider distinct from its member activity's delivery provider", async () => {
    const tree = buildActivitySourceTree(
      { status: "resolved", memberActivityId: "original", providerId: "whoop", sourceName: null },
      [
        {
          memberActivityId: "original",
          providerId: "whoop",
          externalId: "original",
          subsource: null,
          label: "WHOOP",
          url: null,
        },
        {
          memberActivityId: "copy",
          providerId: "peloton",
          externalId: "copy",
          subsource: null,
          label: "Peloton",
          url: null,
        },
      ],
      [
        {
          upstreamMemberActivityId: "original",
          downstreamMemberActivityId: "copy",
          field: "external_id",
          value: "original",
        },
      ],
    );
    const result = await getActivityMetricSources(
      storeWithRows([
        {
          channel: "heart_rate",
          provider_id: "strava",
          device_id: null,
          source_id: "strava-recording",
          activity_ids: ["copy"],
        },
      ]),
      window,
      { items: [], power: [] },
      tree,
    );
    expect(result[0]?.sources[0]).toMatchObject({
      id: "strava-recording",
      label: "Strava",
      presentation: { providerId: "strava", attribution: null },
    });
  });
  it.each(["peloton", "strava"])(
    "projects WHOOP ancestry through %s without changing selection identity",
    async (providerId) => {
      const tree = buildActivitySourceTree(
        {
          status: "resolved",
          memberActivityId: "whoop-member",
          providerId: "whoop",
          sourceName: null,
        },
        ["whoop", providerId].map((provider) => ({
          memberActivityId: `${provider}-member`,
          providerId: provider,
          externalId: provider,
          subsource: null,
          label: provider,
          url: null,
        })),
        [
          {
            upstreamMemberActivityId: "whoop-member",
            downstreamMemberActivityId: `${providerId}-member`,
            field: "external_id",
            value: "reference",
          },
        ],
      );
      const result = await getActivityMetricSources(
        storeWithRows([
          {
            channel: "heart_rate",
            provider_id: providerId,
            device_id: null,
            source_id: "held-recording",
            activity_ids: [`${providerId}-member`],
          },
        ]),
        window,
        { items: [], power: [] },
        tree,
      );
      expect(result[0]?.sources[0]).toEqual({
        id: "held-recording",
        label: `WHOOP via ${providerId === "peloton" ? "Peloton" : "Strava"}`,
        presentation: {
          displayName: "WHOOP",
          providerId: "whoop",
          sourceName: null,
          attribution: {
            kind: "provider",
            providerId,
            label: providerId === "peloton" ? "Peloton" : "Strava",
          },
        },
      });
      expect(result[0]?.defaultSourceId).toBe("held-recording");
    },
  );
});

describe("heart-rate default ranking", () => {
  it.each([
    { name: "standalone samples", linked: false, role: null, expected: "whoop" },
    { name: "activity-linked samples", linked: true, role: null, expected: "watch" },
    { name: "reported recorder", linked: false, role: "recorder", expected: "watch" },
    {
      name: "recorder label without matching source identity",
      linked: false,
      role: "recorder",
      expected: "whoop",
    },
    { name: "file creator only", linked: false, role: "creator", expected: "whoop" },
    { name: "observed sensor only", linked: false, role: "sensor", expected: "whoop" },
  ] as const)(
    "prefers the appropriate source for $name",
    async ({ name, linked, role, expected }) => {
      const hardware: ActivityHardware = {
        items: role
          ? [
              {
                id: "watch-recorder",
                activityId: window.activityId,
                providerId: "apple_health",
                sourceName:
                  name === "recorder label without matching source identity" ? null : "Watch",
                role,
                label: "Watch",
                model: null,
                manufacturer: null,
                evidence: "Reported hardware",
                details: [],
              },
            ]
          : [],
        power: [],
      };
      const metrics = await getActivityMetricSources(
        storeWithRows([
          {
            channel: "heart_rate",
            provider_id: "whoop",
            device_id: null,
            source_id: "whoop",
            activity_ids: [],
            sample_count: 10,
          },
          {
            channel: "heart_rate",
            provider_id: "apple_health",
            device_id: "Watch",
            source_id: "watch",
            activity_ids: linked ? [window.activityId] : [],
            sample_count: 1,
          },
        ]),
        window,
        hardware,
      );
      expect(metrics[0]?.defaultSourceId).toBe(expected);
    },
  );

  it.each([false, true])(
    "uses sample count within the direct-recording tier (%s)",
    async (linked) => {
      const activityIds = linked ? [window.activityId] : [];
      const metrics = await getActivityMetricSources(
        storeWithRows([
          {
            channel: "heart_rate",
            provider_id: "apple_health",
            device_id: "Watch",
            source_id: "watch",
            activity_ids: activityIds,
            sample_count: 1,
          },
          {
            channel: "heart_rate",
            provider_id: "whoop",
            device_id: null,
            source_id: "whoop",
            activity_ids: activityIds,
            sample_count: 10,
          },
        ]),
        window,
      );
      expect(metrics[0]?.defaultSourceId).toBe("whoop");
    },
  );
});

describe("activity heart-rate sources", () => {
  it("keeps Peloton and Strava provenance while supplying only the reported device name", async () => {
    const hardware: ActivityHardware = {
      items: [
        {
          id: "strava-recorder",
          activityId: window.activityId,
          providerId: "strava",
          sourceName: null,
          role: "recorder",
          label: "Peloton Bike",
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
        { channel: "power", provider_id: "peloton", device_id: null, source_id: "peloton" },
        { channel: "power", provider_id: "strava", device_id: null, source_id: "strava" },
      ]),
      window,
      hardware,
    );
    expect(result[0]).toMatchObject({
      defaultSourceId: "peloton",
      sources: [
        { id: "peloton", label: "Peloton", presentation: { displayName: "Peloton" } },
        {
          id: "strava",
          label: "Strava · recorded by Peloton Bike",
          presentation: { displayName: "Peloton Bike", providerId: "strava" },
        },
      ],
    });
  });

  it("keeps distinct source identifiers separate when their display names are identical", async () => {
    const hardware = normalizeActivityHardware([
      {
        activityId: window.activityId,
        providerId: "garmin",
        sourceName: "fr955",
        raw: { deviceName: "Other watch" },
        observations: [],
      },
    ]);
    const result = await getActivityMetricSources(
      storeWithRows([
        {
          channel: "heart_rate",
          provider_id: "garmin",
          device_id: "forerunner955",
          source_id: "distinct-watch",
        },
      ]),
      window,
      hardware,
    );
    expect(result[0]?.sources).toEqual([
      {
        id: "distinct-watch",
        label: "Garmin · Forerunner 955",
        presentation: {
          displayName: "Forerunner 955",
          providerId: "garmin",
          sourceName: "forerunner955",
          attribution: null,
        },
      },
    ]);
    expect(result[0]?.defaultSourceId).toBe("distinct-watch");
  });
  it("keeps a raw Garmin source ID matched to its readable hardware label", async () => {
    const sourceId = '["garmin","fr955"]';
    const hardware = normalizeActivityHardware([
      {
        activityId: window.activityId,
        providerId: "garmin",
        sourceName: "fr955",
        raw: { deviceName: "fr955" },
        observations: [],
      },
    ]);
    const result = await getActivityMetricSources(
      storeWithRows([
        { channel: "heart_rate", provider_id: "garmin", device_id: "fr955", source_id: sourceId },
      ]),
      window,
      hardware,
    );
    expect(result[0]).toMatchObject({
      defaultSourceId: sourceId,
      sources: [{ id: sourceId, label: "Garmin · Forerunner 955" }],
    });
  });
  it("matches normalized source names when the reported recorder has a distinct name", async () => {
    const hardware = normalizeActivityHardware([
      {
        activityId: window.activityId,
        providerId: "garmin",
        sourceName: "fr955",
        raw: { deviceName: "My custom watch" },
        observations: [],
      },
    ]);
    const result = await getActivityMetricSources(
      storeWithRows([
        { channel: "heart_rate", provider_id: "garmin", device_id: "fr955", source_id: "raw-id" },
      ]),
      window,
      hardware,
    );
    expect(result[0]?.sources).toEqual([
      {
        id: "raw-id",
        label: "Garmin · Forerunner 955 · recorded by My custom watch",
        presentation: {
          displayName: "My custom watch",
          providerId: "garmin",
          sourceName: "fr955",
          attribution: null,
        },
      },
    ]);
  });
  it("adds structured presentation from raw source metadata without changing source labels", async () => {
    const result = await getActivityMetricSources(
      storeWithRows([
        {
          channel: "heart_rate",
          provider_id: "apple_health",
          device_id: "Zepp",
          source_id: "opaque-zepp",
        },
        { channel: "heart_rate", provider_id: "whoop", device_id: null, source_id: "opaque-cloud" },
        {
          channel: "heart_rate",
          provider_id: "whoop_ble",
          device_id: "strap-a",
          source_id: "opaque-ble",
        },
        {
          channel: "heart_rate",
          provider_id: "unknown",
          device_id: "Watch",
          source_id: "opaque-other",
        },
      ]),
      window,
    );
    expect(result[0]).toEqual({
      key: "heartRate",
      label: "Heart Rate",
      defaultSourceId: "opaque-zepp",
      sources: [
        {
          id: "opaque-zepp",
          label: "Zepp (via Apple Health)",
          presentation: {
            displayName: "Zepp",
            providerId: "apple_health",
            sourceName: "Zepp",
            attribution: { kind: "apple_health", label: "Apple Health" },
          },
        },
        {
          id: "opaque-cloud",
          label: "WHOOP (Cloud)",
          presentation: {
            displayName: "WHOOP",
            providerId: "whoop",
            sourceName: null,
            attribution: { kind: "cloud", label: "Cloud" },
          },
        },
        {
          id: "opaque-ble",
          label: "WHOOP (Bluetooth) · strap-a",
          presentation: {
            displayName: "strap-a",
            providerId: "whoop_ble",
            sourceName: "strap-a",
            attribution: { kind: "bluetooth", label: "Bluetooth" },
          },
        },
        {
          id: "opaque-other",
          label: "unknown · Watch",
          presentation: {
            displayName: "unknown · Watch",
            providerId: "unknown",
            sourceName: "Watch",
            attribution: null,
          },
        },
      ],
    });
  });
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
          expect.objectContaining({ id: "whoop", label: "WHOOP (Cloud)" }),
          expect.objectContaining({
            id: whoopBluetoothSourceId,
            label: "WHOOP (Bluetooth) · strap-a",
          }),
          expect.objectContaining({ id: garminSourceId, label: "Garmin · Edge 530" }),
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
    presentation: {
      displayName: "Export platform",
      providerId: "fit-file",
      sourceName: "Export platform",
      attribution: null,
    },
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
    ].map((row) => schema.parse({ sample_count: 1, ...row })),
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
    presentation: {
      displayName: "Polar H10",
      providerId: "ble_heart_rate",
      sourceName: "Polar H10",
      attribution: { kind: "bluetooth", label: "Bluetooth" },
    },
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

it("keeps discovery order, default, and source identities while adding hardware labels", async () => {
  const rows = [
    { channel: "power", provider_id: "strava", device_id: null, source_id: "strava" },
    { channel: "power", provider_id: "garmin", device_id: null, source_id: "garmin" },
  ];
  const before = await getActivityMetricSources(storeWithRows(rows), window);
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
    ],
    power: [],
  };
  const after = await getActivityMetricSources(storeWithRows(rows), window, hardware);
  expect(after[0]?.sources[0]?.label).toBe("Strava · recorded by Edge 530");
  expect(
    after.map((metric) => [metric.key, metric.defaultSourceId, metric.sources.map(({ id }) => id)]),
  ).toEqual(
    before.map((metric) => [
      metric.key,
      metric.defaultSourceId,
      metric.sources.map(({ id }) => id),
    ]),
  );
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
    expect.objectContaining({ id: zeppId, label: "Zepp (via Apple Health)" }),
    expect.objectContaining({ id: watchId, label: "Apple Watch (via Apple Health)" }),
  ]);
});

describe("BLE peripheral label lookup", () => {
  it("queries only known BLE IDs and preserves ownership and exact window parameters", async () => {
    const rows = [
      {
        channel: "heart_rate",
        provider_id: "ble_heart_rate",
        device_id: null,
        source_id: "ble_heart_rate",
        activity_ids: [],
      },
      {
        channel: "heart_rate",
        provider_id: "ble_heart_rate",
        device_id: "strap-a",
        source_id: '["ble_heart_rate","strap-a"]',
        activity_ids: [],
      },
      {
        channel: "heart_rate",
        provider_id: "ble_heart_rate",
        device_id: "strap-b",
        source_id: '["ble_heart_rate","strap-b"]',
        activity_ids: [],
      },
      {
        channel: "heart_rate",
        provider_id: "garmin",
        device_id: "strap-a",
        source_id: '["garmin","strap-a"]',
        activity_ids: [],
      },
    ];
    const store = storeWithRows([]);
    store.query.mockImplementationOnce(async (schema) =>
      rows.map((row) => schema.parse({ sample_count: 1, ...row })),
    );
    store.query.mockImplementationOnce(async (schema) =>
      [
        { provider_id: "ble_heart_rate", device_id: "strap-b", device_name: "Polar H10" },
        { provider_id: "ble_heart_rate", device_id: "strap-a", device_name: "Wahoo TICKR" },
      ].map((row) => schema.parse(row)),
    );
    const result = await getActivityMetricSources(store, window);
    expect(store.query.mock.calls[1]?.[2]).toEqual({
      isPointOnly: false,
      userId: window.userId,
      windowStartedAt: window.startedAt,
      windowEndedAt: window.endedAt,
      memberActivityIds: window.memberActivityIds,
      peripheralIds: ["strap-a", "strap-b"],
    });
    expect(result[0]).toEqual({
      key: "heartRate",
      label: "Heart Rate",
      defaultSourceId: "ble_heart_rate",
      sources: [
        expect.objectContaining({ id: "ble_heart_rate", label: "Heart Rate Monitor (Bluetooth)" }),
        expect.objectContaining({
          id: '["ble_heart_rate","strap-a"]',
          label: "Heart Rate Monitor (Bluetooth) · Wahoo TICKR",
        }),
        expect.objectContaining({
          id: '["ble_heart_rate","strap-b"]',
          label: "Heart Rate Monitor (Bluetooth) · Polar H10",
        }),
        expect.objectContaining({ id: '["garmin","strap-a"]', label: "Garmin · strap-a" }),
      ],
    });
  });
  it("retains the peripheral ID label when the eligible raw samples have no name", async () => {
    const store = storeWithRows([]);
    store.query.mockImplementationOnce(async (schema) =>
      [
        {
          channel: "heart_rate",
          provider_id: "ble_heart_rate",
          device_id: "strap-a",
          source_id: "source",
          activity_ids: [],
          sample_count: 1,
        },
      ].map((row) => schema.parse(row)),
    );
    store.query.mockResolvedValueOnce([]);
    const result = await getActivityMetricSources(store, window);
    expect(result[0]?.sources).toEqual([
      {
        id: "source",
        label: "Heart Rate Monitor (Bluetooth) · strap-a",
        presentation: {
          displayName: "strap-a",
          providerId: "ble_heart_rate",
          sourceName: "strap-a",
          attribution: { kind: "bluetooth", label: "Bluetooth" },
        },
      },
    ]);
  });
  it("does not perform a raw lookup when BLE rows have no device identity", async () => {
    const store = storeWithRows([
      {
        channel: "heart_rate",
        provider_id: "ble_heart_rate",
        device_id: null,
        source_id: "ble_heart_rate",
      },
    ]);
    expect((await getActivityMetricSources(store, window))[0]?.sources).toEqual([
      {
        id: "ble_heart_rate",
        label: "Heart Rate Monitor (Bluetooth)",
        presentation: {
          displayName: "Heart Rate Monitor",
          providerId: "ble_heart_rate",
          sourceName: null,
          attribution: { kind: "bluetooth", label: "Bluetooth" },
        },
      },
    ]);
    expect(store.query).toHaveBeenCalledTimes(1);
  });
});
