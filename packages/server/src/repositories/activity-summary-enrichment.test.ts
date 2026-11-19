import { describe, expect, it, vi } from "vitest";
import { routeMapPreview } from "../lib/map-preview.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { getActivityMapReadiness } from "./activity-route-preview.ts";
import { withActivitySummaries } from "./activity-summary-enrichment.ts";

vi.mock("./activity-route-preview.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./activity-route-preview.ts")>()),
  getActivityMapReadiness: vi.fn().mockResolvedValue(new Map()),
}));

const summaryFields = {
  avg_hr: null,
  max_hr: null,
  avg_power: null,
  max_power: null,
  avg_speed: null,
  max_speed: null,
  avg_cadence: null,
  total_distance: null,
  elevation_gain_m: null,
  elevation_loss_m: null,
  sample_count: null,
  centroid_lat: null,
  centroid_lng: null,
};

function makeSensorStore(): ActivitySensorStore {
  return {
    query: vi.fn().mockResolvedValue([]),
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRow(
  id: string,
  memberActivityIds: string[] = [id],
  extra: { provider_absent_at?: string | null } = {},
) {
  return { id, member_activity_ids: memberActivityIds, ...extra };
}

function makeSummary(activityId: string, overrides: Record<string, unknown> = {}) {
  return { activity_id: activityId, ...summaryFields, ...overrides };
}

describe("withActivitySummaries", () => {
  it("keeps location null when the optional sensor store is absent", async () => {
    await expect(
      withActivitySummaries([makeRow("activity-1")], undefined, "user-1"),
    ).resolves.toEqual([{ ...makeRow("activity-1"), location: null }]);
  });

  it("hydrates the canonical summary fields and deduplicates activity IDs", async () => {
    const store = makeSensorStore();
    store.getActivitySummaries = vi.fn().mockResolvedValue([
      makeSummary("stable-group-id", {
        avg_hr: 145,
        max_hr: 171,
        avg_power: 220,
        max_power: 450,
        avg_speed: 8,
        max_speed: 12,
        avg_cadence: 82,
        total_distance: 42_000,
        elevation_gain_m: 610,
        elevation_loss_m: 590,
        sample_count: 3600,
      }),
    ]);
    const rows = [
      makeRow("stable-group-id", ["representative-member-id", "sensor-member-id"]),
      makeRow("stable-group-id", ["representative-member-id", "sensor-member-id"]),
    ];

    const result = await withActivitySummaries(rows, store, "user-1");

    expect(store.getActivitySummaries).toHaveBeenCalledExactlyOnceWith(["stable-group-id"]);
    expect(result[0]).toMatchObject({
      avg_hr: 145,
      max_hr: 171,
      avg_power: 220,
      max_power: 450,
      avg_speed: 8,
      max_speed: 12,
      avg_cadence: 82,
      total_distance: 42_000,
      distance_meters: 42_000,
      elevation_gain_m: 610,
      elevation_loss_m: 590,
      sample_count: 3600,
      location: null,
    });
    expect(result).toHaveLength(2);
  });

  it.each([0, 12])("preserves recorded max speed %s", async (max_speed) => {
    const store = makeSensorStore();
    store.getActivitySummaries = vi
      .fn()
      .mockResolvedValue([makeSummary("activity-1", { max_speed })]);

    const [row] = await withActivitySummaries([makeRow("activity-1")], store, "user-1");

    expect(row?.max_speed).toBe(max_speed);
  });

  it("keeps populated fields invariant across representative metadata", async () => {
    const populatedFieldSets: string[][] = [];
    for (const representative of [
      { canonical_type: "cycling", provider_id: "peloton" },
      { canonical_type: "running", provider_id: "wahoo" },
      { canonical_type: "other", provider_id: "strava" },
    ]) {
      const store = makeSensorStore();
      store.getActivitySummaries = vi.fn().mockResolvedValue([
        makeSummary("stable-group-id", {
          avg_hr: 145,
          max_power: 450,
          avg_cadence: 82,
          total_distance: 42_000,
          elevation_loss_m: 590,
          sample_count: 3600,
        }),
      ]);
      const [row] = await withActivitySummaries(
        [{ ...makeRow("stable-group-id"), ...representative }],
        store,
        "user-1",
      );
      populatedFieldSets.push(
        [
          "avg_hr",
          "max_hr",
          "avg_power",
          "max_power",
          "avg_speed",
          "max_speed",
          "avg_cadence",
          "total_distance",
          "elevation_gain_m",
          "elevation_loss_m",
          "sample_count",
        ].filter((field) => row?.[field] != null),
      );
    }

    expect(populatedFieldSets).toEqual([
      ["avg_hr", "max_power", "avg_cadence", "total_distance", "elevation_loss_m", "sample_count"],
      ["avg_hr", "max_power", "avg_cadence", "total_distance", "elevation_loss_m", "sample_count"],
      ["avg_hr", "max_power", "avg_cadence", "total_distance", "elevation_loss_m", "sample_count"],
    ]);
  });

  it("uses centroid fallback previews and preserves recorded zero values without a centroid", async () => {
    const store = makeSensorStore();
    store.getActivitySummaries = vi.fn().mockResolvedValue([
      makeSummary("route", {
        avg_hr: 145,
        total_distance: 5000,
        elevation_gain_m: 0,
        sample_count: 0,
        centroid_lat: 37.7749,
        centroid_lng: -122.4194,
      }),
      makeSummary("route-less", { total_distance: 0, elevation_gain_m: 0, sample_count: 0 }),
    ]);

    const result = await withActivitySummaries(
      [makeRow("route"), makeRow("route-less", [])],
      store,
      "user-1",
    );

    expect(result[0]).toMatchObject({
      location: {
        kind: "recorded_gps",
        centroidLat: 37.7749,
        centroidLng: -122.4194,
        mapPreview: routeMapPreview([{ lat: 37.7749, lng: -122.4194 }]),
      },
      distance_meters: 5000,
      elevation_gain_m: 0,
      sample_count: 0,
    });
    expect(result[1]).toMatchObject({
      location: null,
      distance_meters: 0,
      elevation_gain_m: 0,
      sample_count: 0,
    });
  });

  it("uses sampled route previews when available", async () => {
    const store = makeSensorStore();
    store.getActivitySummaries = vi.fn().mockResolvedValue([
      makeSummary("stable-group-id", {
        centroid_lat: 37.7749,
        centroid_lng: -122.4194,
      }),
    ]);
    store.query = vi.fn().mockResolvedValue([
      { activity_id: "stable-group-id", lat: 37.7749, lng: -122.4194 },
      { activity_id: "stable-group-id", lat: 37.7752, lng: -122.4188 },
      { activity_id: "stable-group-id", lat: 37.7756, lng: -122.4182 },
    ]);

    const [row] = await withActivitySummaries([makeRow("stable-group-id")], store, "user-1");

    expect(row?.location).toEqual({
      kind: "recorded_gps",
      centroidLat: 37.7749,
      centroidLng: -122.4194,
      mapPreview: routeMapPreview([
        { lat: 37.7749, lng: -122.4194 },
        { lat: 37.7752, lng: -122.4188 },
        { lat: 37.7756, lng: -122.4182 },
      ]),
    });
    expect(store.query).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.any(String), {
      activityIds: ["stable-group-id"],
      maxPoints: expect.any(Number),
      userId: "user-1",
    });
  });

  it("checks every incomplete map using its canonical group and all source members", async () => {
    const store = makeSensorStore();
    store.getActivitySummaries = vi
      .fn()
      .mockResolvedValue([
        makeSummary("missing-latitude", { centroid_lng: -122.4 }),
        makeSummary("missing-longitude", { centroid_lat: 37.8 }),
        makeSummary("ready-map", { centroid_lat: 37.8, centroid_lng: -122.4 }),
      ]);
    vi.mocked(getActivityMapReadiness).mockResolvedValueOnce(
      new Map([
        ["missing-summary", "processing"],
        ["missing-latitude", "processing"],
        ["missing-longitude", "awaiting_summary"],
      ]),
    );

    const result = await withActivitySummaries(
      [
        makeRow("missing-summary", ["source-a", "source-b"]),
        makeRow("missing-latitude", ["source-c"]),
        makeRow("missing-longitude", ["source-d"]),
        makeRow("ready-map", ["source-e"]),
      ],
      store,
      "user-1",
    );

    expect(getActivityMapReadiness).toHaveBeenLastCalledWith(store, "user-1", [
      {
        id: "missing-summary",
        routeActivityId: "missing-summary",
        memberActivityIds: ["source-a", "source-b"],
      },
      {
        id: "missing-latitude",
        routeActivityId: "missing-latitude",
        memberActivityIds: ["source-c"],
      },
      {
        id: "missing-longitude",
        routeActivityId: "missing-longitude",
        memberActivityIds: ["source-d"],
      },
    ]);
    expect(result.map((row) => row.location?.kind ?? null)).toEqual([
      "processing",
      "processing",
      "processing",
      "recorded_gps",
    ]);
  });

  it.each([
    ["processing", "active", { kind: "processing" }],
    ["awaiting_summary", "active", { kind: "processing" }],
    ["unavailable", "active", null],
    ["awaiting_summary", "provider-absent", null],
    [undefined, "active", null],
  ] as const)("maps %s readiness for %s activity", async (status, activityState, location) => {
    const store = makeSensorStore();
    vi.mocked(getActivityMapReadiness).mockResolvedValueOnce(
      status == null ? new Map() : new Map([["canonical-map", status]]),
    );
    const row = makeRow(
      "canonical-map",
      ["source-map"],
      activityState === "provider-absent" ? { provider_absent_at: "2026-01-02T00:00:00Z" } : {},
    );

    const [result] = await withActivitySummaries([row], store, "user-1");

    expect(result?.location).toEqual(location);
    expect(getActivityMapReadiness).toHaveBeenLastCalledWith(store, "user-1", [
      { id: "canonical-map", routeActivityId: "canonical-map", memberActivityIds: ["source-map"] },
    ]);
  });

  const runningFormFields = {
    cadence_basis: "step_intervals",
    cadence_observed_seconds: 0,
    cadence_coverage_percent: 30,
    avg_stride_length: 1.24,
    avg_stance_time: 240,
    avg_vertical_osc: 8,
  } as const;

  it("maps all opted-in running-form fields including a recorded zero", async () => {
    const store = makeSensorStore();
    store.getActivitySummaries = vi
      .fn()
      .mockResolvedValue([makeSummary("run-1", runningFormFields)]);

    const [row] = await withActivitySummaries([makeRow("run-1")], store, "user-1", {
      includeRunningForm: true,
    });

    expect(store.getActivitySummaries).toHaveBeenCalledExactlyOnceWith(["run-1"], {
      includeRunningForm: true,
    });
    expect(row).toMatchObject(runningFormFields);
  });

  it.each([
    { name: "absent", values: {} },
    {
      name: "null",
      values: {
        cadence_basis: null,
        cadence_observed_seconds: null,
        cadence_coverage_percent: null,
        avg_stride_length: null,
        avg_stance_time: null,
        avg_vertical_osc: null,
      },
    },
  ])("defaults opted-in running-form fields to null when $name", async ({ values }) => {
    const store = makeSensorStore();
    store.getActivitySummaries = vi.fn().mockResolvedValue([makeSummary("run-2", values)]);

    const [row] = await withActivitySummaries([makeRow("run-2")], store, "user-1", {
      includeRunningForm: true,
    });

    expect(row).toMatchObject({
      cadence_basis: null,
      cadence_observed_seconds: null,
      cadence_coverage_percent: null,
      avg_stride_length: null,
      avg_stance_time: null,
      avg_vertical_osc: null,
    });
  });

  it("keeps the default summary list unchanged without running-form fields", async () => {
    const store = makeSensorStore();
    store.getActivitySummaries = vi
      .fn()
      .mockResolvedValue([makeSummary("run-3", runningFormFields)]);

    const [row] = await withActivitySummaries([makeRow("run-3")], store, "user-1");

    expect(store.getActivitySummaries).toHaveBeenCalledExactlyOnceWith(["run-3"]);
    for (const field of Object.keys(runningFormFields)) {
      expect(row).not.toHaveProperty(field);
    }
  });
});
