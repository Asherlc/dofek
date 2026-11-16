import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import * as hardwareRepository from "./activity-hardware-repository.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { ActivitySensorRepository, StreamPoint } from "./activity-sensor-repository.ts";
import type { ActivitySensorWindow } from "./activity-sensor-types.ts";

const window: ActivitySensorWindow = {
  activityId: "22222222-2222-2222-2222-222222222222",
  userId: "11111111-1111-1111-1111-111111111111",
  startedAt: "2026-10-20T12:00:00.000Z",
  endedAt: "2026-10-20T13:00:00.000Z",
  providerType: null,
  memberActivityIds: ["22222222-2222-2222-2222-222222222222"],
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
    getStream: vi.fn().mockResolvedValue([
      {
        recorded_at: "2026-10-20T12:30:00.000Z",
        heart_rate: 140,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
        skin_temperature: 32.2,
        skin_temperature_recorded_at: "2026-10-20T12:30:01.000Z",
      },
    ]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([{ zone: 1, seconds: 60 }]),
    getPowerZoneSeconds: vi
      .fn()
      .mockResolvedValue(
        Array.from({ length: 7 }, (_, index) => ({ zone: index + 1, seconds: 60 })),
      ),
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
  };
}

function makeSensorRepository(execute = vi.fn().mockResolvedValue([])) {
  return {
    execute,
    repository: new ActivitySensorRepository({ execute }, "user-1", "UTC", {
      kind: "full",
      paid: true,
      reason: "paid_grant",
    }),
  };
}

describe("ActivitySensorRepository", () => {
  it("maps selected-source stream rows into stream points", async () => {
    const { repository } = makeSensorRepository();
    const sensorStore = makeSensorStore();
    const points = await repository.getStream(sensorStore, window, 50, { heartRate: "whoop" });

    expect(points[0]?.toDetail()).toMatchObject({
      recordedAt: "2026-10-20T12:30:00.000Z",
      heartRate: 140,
      skinTemperature: 32.2,
      skinTemperatureRecordedAt: "2026-10-20T12:30:01.000Z",
    });
    expect(sensorStore.getStream).toHaveBeenCalledExactlyOnceWith(window, 50, {
      heartRate: "whoop",
    });
  });

  it("uses the two-argument stream call when the source selection is empty", async () => {
    const { repository } = makeSensorRepository();
    const sensorStore = makeSensorStore();
    await repository.getStream(sensorStore, window, 50, {});
    expect(sensorStore.getStream).toHaveBeenCalledExactlyOnceWith(window, 50);
  });

  it("preserves the nonuniform default heart-rate zones, including populated zone zero", async () => {
    const { repository } = makeSensorRepository();
    const sensorStore = makeSensorStore();
    sensorStore.getHeartRateZoneSeconds = vi.fn().mockResolvedValue([
      { zone: 0, seconds: 30 },
      { zone: 1, seconds: 120 },
      { zone: 2, seconds: 300 },
      { zone: 3, seconds: 600 },
      { zone: 4, seconds: 400 },
      { zone: 5, seconds: 80 },
    ]);
    const zones = await repository.getHrZones(sensorStore, window);
    expect(zones).toHaveLength(6);
    expect(zones.map(({ zone, seconds }) => ({ zone, seconds }))).toEqual([
      { zone: 0, seconds: 30 },
      { zone: 1, seconds: 120 },
      { zone: 2, seconds: 300 },
      { zone: 3, seconds: 600 },
      { zone: 4, seconds: 400 },
      { zone: 5, seconds: 80 },
    ]);
    expect(sensorStore.getHeartRateZoneSeconds).toHaveBeenCalledExactlyOnceWith(window);
  });

  it("preserves zone-two power seconds and the default two-argument store call", async () => {
    const { repository } = makeSensorRepository();
    const sensorStore = makeSensorStore();
    sensorStore.getPowerZoneSeconds = vi.fn().mockResolvedValue([
      { zone: 1, seconds: 60 },
      { zone: 2, seconds: 900 },
      { zone: 3, seconds: 600 },
      { zone: 4, seconds: 240 },
      { zone: 5, seconds: 120 },
      { zone: 6, seconds: 30 },
      { zone: 7, seconds: 10 },
    ]);
    const zones = await repository.getPowerZones(sensorStore, window, 250);
    expect(zones).toHaveLength(7);
    expect(zones[0]?.zone).toBe(1);
    expect(zones[1]?.zone).toBe(2);
    expect(zones[1]?.seconds).toBe(900);
    expect(zones[6]?.maxPct).toBeNull();
    expect(sensorStore.getPowerZoneSeconds).toHaveBeenCalledExactlyOnceWith(window, 250);
  });

  it("maps selected-source power zones with the resolved window and FTP", async () => {
    const { repository } = makeSensorRepository();
    const sensorStore = makeSensorStore();

    const zones = await repository.getPowerZones(sensorStore, window, 275, "garmin");

    expect(zones).toHaveLength(7);
    expect(zones[0]?.seconds).toBe(60);
    expect(sensorStore.getPowerZoneSeconds).toHaveBeenCalledExactlyOnceWith(window, 275, "garmin");
  });

  it("maps selected-source HR zones at the sensor owner", async () => {
    const { repository } = makeSensorRepository();
    const sensorStore = makeSensorStore();
    sensorStore.query = vi
      .fn()
      .mockResolvedValueOnce([{ zone0: 0, zone1: 3, zone2: 0, zone3: 0, zone4: 0, zone5: 0 }]);

    const zones = await repository.getHrZones(sensorStore, window, "whoop");

    expect(zones.find((zone) => zone.zone === 1)?.seconds).toBe(3);
    expect(sensorStore.getHeartRateZoneSeconds).not.toHaveBeenCalled();
    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        userId: window.userId,
        windowStartedAt: window.startedAt,
        windowEndedAt: window.endedAt,
        isPointOnly: false,
        memberActivityIds: window.memberActivityIds,
        heartRateSourceId: "whoop",
      }),
    );
  });

  it("gets hardware for the resolved window", async () => {
    const { repository } = makeSensorRepository();
    const hardware = { items: [], power: [] };
    const listHardware = vi
      .spyOn(hardwareRepository, "listActivityHardware")
      .mockResolvedValue(hardware);

    await expect(repository.getHardware(window)).resolves.toBe(hardware);

    expect(listHardware).toHaveBeenCalledExactlyOnceWith(expect.anything(), window);
    listHardware.mockRestore();
  });

  it("reads V1 metric sources directly for the resolved window", async () => {
    const { repository } = makeSensorRepository();
    const sensorStore = makeSensorStore();
    sensorStore.query = vi.fn().mockResolvedValueOnce([
      {
        channel: "heart_rate",
        provider_id: "garmin",
        device_id: null,
        source_id: "garmin",
        activity_ids: window.memberActivityIds,
      },
    ]);

    await expect(
      repository.getMetricSources(sensorStore, window, { items: [], power: [] }, 1),
    ).resolves.toMatchObject([
      { key: "heartRate", defaultSourceId: "garmin", sources: [{ id: "garmin" }] },
    ]);
    expect(sensorStore.query).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(String),
      {
        userId: window.userId,
        windowStartedAt: window.startedAt,
        windowEndedAt: window.endedAt,
        isPointOnly: false,
        memberActivityIds: window.memberActivityIds,
      },
    );
  });

  it("uses the canonical activity session when composing V2 source attribution", async () => {
    const dialect = new PgDialect();
    const canonicalActivityId = "44444444-4444-4444-8444-444444444444";
    const kilterMemberId = "11111111-1111-4111-8111-111111111111";
    const secondKilterMemberId = "11111111-1111-4111-8111-111111111112";
    const pelotonMemberId = "22222222-2222-4222-8222-222222222222";
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const ancestry = {
      primary_activity_id: kilterMemberId,
      primary_provider_id: "kilter",
      primary_source_name: "Kilter Board",
      origin_candidate_member_ids: [],
      origin_evidence: [
        {
          upstreamMemberActivityId: kilterMemberId,
          downstreamMemberActivityId: pelotonMemberId,
          field: "external_id",
          value: "shared-recording",
        },
        {
          upstreamMemberActivityId: secondKilterMemberId,
          downstreamMemberActivityId: pelotonMemberId,
          field: "external_id",
          value: "shared-recording",
        },
      ],
      source_external_ids: [
        { memberActivityId: kilterMemberId, providerId: "kilter", externalId: "log-1" },
        { memberActivityId: secondKilterMemberId, providerId: "kilter", externalId: "log-2" },
        { memberActivityId: pelotonMemberId, providerId: "peloton", externalId: "ride-1" },
      ],
      absent_source_external_ids: [],
    };
    const execute = vi.fn().mockImplementation((query) => {
      const sql = dialect.sqlToQuery(query).sql;
      if (sql.includes("fitness.v_climbing_log_activity"))
        return [
          {
            activityId: canonicalActivityId,
            id: sessionId,
            providerId: "kilter",
            memberActivityIds: [kilterMemberId, secondKilterMemberId],
            firstLoggedAt: "2026-11-09T18:00:00.000Z",
            lastLoggedAt: "2026-11-09T18:04:00.000Z",
          },
        ];
      return [ancestry];
    });
    const { repository } = makeSensorRepository(execute);
    const sensorStore = makeSensorStore();
    sensorStore.query = vi.fn().mockResolvedValueOnce([
      {
        channel: "heart_rate",
        provider_id: "peloton",
        device_id: null,
        source_id: "peloton",
        activity_ids: [pelotonMemberId],
        sample_count: 500,
      },
    ]);

    const result = await repository.getMetricSources(
      sensorStore,
      {
        ...window,
        activityId: canonicalActivityId,
        memberActivityIds: [kilterMemberId, secondKilterMemberId, pelotonMemberId],
      },
      { items: [], power: [] },
      2,
    );

    expect(result[0]?.sources[0]).toMatchObject({
      id: "peloton",
      presentation: {
        providerId: "kilter",
        attribution: { kind: "provider", providerId: "peloton" },
      },
    });
    const sessionQuery = execute.mock.calls
      .map(([query]) => dialect.sqlToQuery(query))
      .find((query) => query.sql.includes("fitness.v_climbing_log_activity"));
    expect(sessionQuery?.params).toEqual(expect.arrayContaining([canonicalActivityId, "user-1"]));
  });

  it.each(["resolved", "unresolved", "removed-original"] as const)(
    "uses canonical ancestry for %s V2 metric sources",
    async (state) => {
      const dialect = new PgDialect();
      const whoopId = "11111111-1111-4111-8111-111111111111";
      const pelotonId = "22222222-2222-4222-8222-222222222222";
      const sources = [
        { memberActivityId: whoopId, providerId: "whoop", externalId: "original", subsource: null },
        { memberActivityId: pelotonId, providerId: "peloton", externalId: "copy", subsource: null },
      ];
      const ancestry = {
        primary_activity_id: state === "unresolved" ? null : whoopId,
        primary_provider_id: state === "unresolved" ? null : "whoop",
        primary_source_name: null,
        origin_candidate_member_ids: state === "unresolved" ? [whoopId, pelotonId] : [],
        source_external_ids: sources.filter(
          (source) => state !== "removed-original" || source.providerId !== "whoop",
        ),
        absent_source_external_ids:
          state === "removed-original"
            ? [{ ...sources[0], providerAbsentAt: "2026-10-21T00:00:00Z" }]
            : [],
        origin_evidence: [
          {
            upstreamMemberActivityId: whoopId,
            downstreamMemberActivityId: pelotonId,
            field: "external_id",
            value: "original",
          },
        ],
      };
      const execute = vi.fn().mockImplementation((query) => {
        const sql = dialect.sqlToQuery(query).sql;
        return sql.includes("fitness.v_climbing_log_activity") ? [] : [ancestry];
      });
      const { repository } = makeSensorRepository(execute);
      const sensorStore = makeSensorStore();
      sensorStore.query = vi.fn().mockResolvedValueOnce([
        {
          channel: "heart_rate",
          provider_id: "peloton",
          device_id: null,
          source_id: "peloton",
          activity_ids: [pelotonId],
          sample_count: 500,
        },
      ]);

      const result = await repository.getMetricSources(
        sensorStore,
        { ...window, memberActivityIds: [whoopId, pelotonId] },
        { items: [], power: [] },
        2,
      );

      expect(result[0]?.sources[0]).toMatchObject({
        id: "peloton",
        label: "WHOOP via Peloton",
        presentation: {
          providerId: "whoop",
          attribution: { kind: "provider", providerId: "peloton" },
        },
      });
    },
  );

  it("rejects missing ancestry before querying metric sources", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const { repository } = makeSensorRepository(execute);
    const sensorStore = makeSensorStore();

    await expect(
      repository.getMetricSources(sensorStore, window, { items: [], power: [] }, 2),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Activity not found" });

    expect(sensorStore.query).not.toHaveBeenCalled();
  });
});

describe("StreamPoint", () => {
  it("maps all fields from row to detail", () => {
    const point = new StreamPoint({
      recorded_at: "2024-01-15T10:30:00.000Z",
      heart_rate: 145,
      power: 250,
      speed: 8.5,
      cadence: 90,
      altitude: 350,
      lat: 47.6,
      lng: -122.3,
      skin_temperature: 32.4,
      skin_temperature_recorded_at: "2024-01-15T10:31:00.000Z",
    });
    expect(point.toDetail()).toEqual({
      recordedAt: "2024-01-15T10:30:00.000Z",
      heartRate: 145,
      power: 250,
      speed: 8.5,
      cadence: 90,
      altitude: 350,
      lat: 47.6,
      lng: -122.3,
      skinTemperature: 32.4,
      skinTemperatureRecordedAt: "2024-01-15T10:31:00.000Z",
    });
  });

  it("preserves null fields", () => {
    const point = new StreamPoint({
      recorded_at: "2024-01-15T10:30:00.000Z",
      heart_rate: null,
      power: null,
      speed: null,
      cadence: null,
      altitude: null,
      lat: null,
      lng: null,
      skin_temperature: null,
      skin_temperature_recorded_at: null,
    });
    const detail = point.toDetail();
    expect(detail.heartRate).toBeNull();
    expect(detail.power).toBeNull();
    expect(detail.speed).toBeNull();
    expect(detail.cadence).toBeNull();
    expect(detail.altitude).toBeNull();
    expect(detail.lat).toBeNull();
    expect(detail.lng).toBeNull();
    expect(detail.skinTemperature).toBeNull();
    expect(detail.skinTemperatureRecordedAt).toBeNull();
  });

  it("handles mixed null and non-null fields", () => {
    const point = new StreamPoint({
      recorded_at: "2024-01-15T10:30:00.000Z",
      heart_rate: 130,
      power: null,
      speed: 5.0,
      cadence: null,
      altitude: 200,
      lat: null,
      lng: null,
    });
    const detail = point.toDetail();
    expect(detail.heartRate).toBe(130);
    expect(detail.power).toBeNull();
    expect(detail.speed).toBe(5.0);
    expect(detail.cadence).toBeNull();
    expect(detail.altitude).toBe(200);
  });
});
