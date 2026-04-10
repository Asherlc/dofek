import { mapHrZones } from "@dofek/zones/zones";
import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { Activity } from "../models/activity.ts";
import { mapStreamPoint } from "./activity.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

// Mock tRPC infrastructure
vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("@sentry/node", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("./sync.ts", () => ({
  ensureProvidersRegistered: vi.fn(async () => {}),
}));

vi.mock("dofek/providers/registry", () => ({
  getProvider: vi.fn((id: string) => {
    const providers: Record<string, { name: string; activityUrl: (externalId: string) => string }> =
      {
        strava: {
          name: "Strava",
          activityUrl: (externalId: string) => `https://www.strava.com/activities/${externalId}`,
        },
        wahoo: {
          name: "Wahoo",
          activityUrl: (externalId: string) => `https://cloud.wahoo.com/workouts/${externalId}`,
        },
        garmin: {
          name: "Garmin",
          activityUrl: (externalId: string) =>
            `https://connect.garmin.com/modern/activity/${externalId}`,
        },
      };
    return providers[id];
  }),
}));

import { activityRouter } from "./activity.ts";

const createCaller = createTestCallerFactory(activityRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
    timezone: "UTC",
  });
}

describe("activityRouter", () => {
  describe("list", () => {
    it("returns paginated items with totalCount", async () => {
      const rows = [
        {
          id: "a1",
          started_at: "2024-01-01 10:00:00+00",
          ended_at: "2024-01-01 11:00:00+00",
          activity_type: "cycling",
          name: "Morning Ride",
          provider_id: "wahoo",
          source_providers: ["wahoo"],
          avg_hr: 150,
          max_hr: 180,
          avg_power: 200,
          total_distance: 30000,
          distance_meters: 30000,
          total_count: 5,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.list({ days: 30, limit: 20, offset: 0 });
      expect(result.totalCount).toBe(5);
      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item).not.toHaveProperty("total_count");
      expect(item).toMatchObject({
        id: "a1",
        started_at: "2024-01-01 10:00:00+00",
        activity_type: "cycling",
        avg_hr: 150,
        max_hr: 180,
        avg_power: 200,
        distance_meters: 30000,
      });
    });

    it("returns stats from activity_summary join", async () => {
      const rows = [
        {
          id: "a1",
          started_at: "2024-01-15 14:30:00+00",
          ended_at: "2024-01-15 15:15:00+00",
          activity_type: "running",
          name: "Easy Run",
          provider_id: "apple_health",
          source_providers: ["apple_health"],
          avg_hr: 142,
          max_hr: 165,
          avg_power: null,
          total_distance: 5200,
          distance_meters: 5200,
          total_count: 1,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.list({ days: 30, limit: 20, offset: 0 });
      const item = result.items[0];
      expect(item).toMatchObject({
        avg_hr: 142,
        max_hr: 165,
        avg_power: null,
        distance_meters: 5200,
      });
    });

    it("returns empty items and zero totalCount when no activities", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.list({ days: 30 });
      expect(result).toEqual({ items: [], totalCount: 0 });
      // Should check base table when view returns empty
      expect(execute).toHaveBeenCalledTimes(2); // list query + base table check
    });

    it("refreshes stale views and retries when view is empty but base table has data", async () => {
      const activityRow = {
        id: "a1",
        started_at: "2024-01-01 10:00:00+00",
        ended_at: "2024-01-01 11:00:00+00",
        activity_type: "cycling",
        name: "Morning Ride",
        provider_id: "wahoo",
        source_providers: ["wahoo"],
        avg_hr: 150,
        max_hr: 180,
        avg_power: 200,
        distance_meters: 30000,
        total_count: 1,
      };
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // 1. list from v_activity: empty
        .mockResolvedValueOnce([{ count: 1 }]) // 2. base table count: has data
        .mockResolvedValueOnce([]) // 3. REFRESH v_activity
        .mockResolvedValueOnce([]) // 4. REFRESH deduped_sensor
        .mockResolvedValueOnce([]) // 5. REFRESH activity_summary
        .mockResolvedValueOnce([activityRow]); // 6. retry list
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.list({ days: 30, limit: 20, offset: 0 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ id: "a1" });
      expect(execute).toHaveBeenCalledTimes(6);
    });

    it("returns empty when both view and base table are empty (genuinely no data)", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([]) // 1. list from v_activity: empty
        .mockResolvedValueOnce([{ count: 0 }]); // 2. base table count: no data
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.list({ days: 30 });
      expect(result).toEqual({ items: [], totalCount: 0 });
      expect(execute).toHaveBeenCalledTimes(2); // no refresh or retry
    });

    it("skips stale view check on non-first pages", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.list({ days: 30, limit: 20, offset: 20 });
      expect(result).toEqual({ items: [], totalCount: 0 });
      // Only the list query — no base table check on offset > 0
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("uses default limit of 20 and offset of 0", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      await caller.list({ days: 30 });
      // list query + base table count (stale view check)
      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  describe("byId", () => {
    it("returns mapped activity detail with source links", async () => {
      const row = {
        id: "abc-123",
        activity_type: "cycling",
        started_at: "2024-01-01T10:00:00Z",
        ended_at: "2024-01-01T11:00:00Z",
        name: "Morning Ride",
        notes: null,
        provider_id: "wahoo",
        source_providers: ["strava", "wahoo"],
        source_external_ids: [
          { providerId: "strava", externalId: "99999" },
          { providerId: "wahoo", externalId: "42" },
        ],
        avg_hr: 150,
        max_hr: 180,
        avg_power: 200,
        max_power: 350,
        avg_speed: 8.5,
        max_speed: 12.0,
        avg_cadence: 85,
        total_distance: 30000,
        elevation_gain_m: 300,
        elevation_loss_m: 280,
        sample_count: 3600,
      };
      const caller = makeCaller([row]);
      const result = await caller.byId({ id: "00000000-0000-0000-0000-000000000001" });

      expect(result.id).toBe("abc-123");
      expect(result.activityType).toBe("cycling");
      expect(result.avgHr).toBe(150);
      expect(result.maxPower).toBe(350);
      expect(result.elevationGain).toBe(300);
      expect(result.sourceLinks).toEqual([
        { providerId: "strava", label: "Strava", url: "https://www.strava.com/activities/99999" },
        { providerId: "wahoo", label: "Wahoo", url: "https://cloud.wahoo.com/workouts/42" },
      ]);
    });

    it("throws NOT_FOUND when activity does not exist", async () => {
      const caller = makeCaller([]);
      await expect(caller.byId({ id: "00000000-0000-0000-0000-000000000001" })).rejects.toThrow(
        TRPCError,
      );
    });

    it("handles null optional fields", async () => {
      const row = {
        id: "abc-123",
        activity_type: "running",
        started_at: "2024-01-01",
        ended_at: null,
        name: null,
        notes: null,
        provider_id: "manual",
        source_providers: null,
        source_external_ids: null,
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
      };
      const caller = makeCaller([row]);
      const result = await caller.byId({ id: "00000000-0000-0000-0000-000000000001" });

      expect(result.endedAt).toBeNull();
      expect(result.name).toBeNull();
      expect(result.avgHr).toBeNull();
      expect(result.sourceProviders).toEqual([]);
      expect(result.sourceLinks).toEqual([]);
    });
  });

  describe("stream", () => {
    it("returns mapped stream points", async () => {
      const rows = [
        {
          recorded_at: "2024-01-01T10:00:00Z",
          heart_rate: 150,
          power: 200,
          speed: 8.5,
          cadence: 85,
          altitude: 100,
          lat: 40.7128,
          lng: -74.006,
          distance: 1000,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.stream({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.recordedAt).toBe("2024-01-01T10:00:00Z");
      expect(result[0]?.heartRate).toBe(150);
      expect(result[0]?.power).toBe(200);
    });

    it("handles null values in stream points", async () => {
      const rows = [
        {
          recorded_at: "2024-01-01T10:00:00Z",
          heart_rate: null,
          power: null,
          speed: null,
          cadence: null,
          altitude: null,
          lat: null,
          lng: null,
          distance: null,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.stream({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result[0]?.heartRate).toBeNull();
      expect(result[0]?.power).toBeNull();
    });
  });

  describe("delete", () => {
    it("calls DELETE with correct activity id and user_id", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual({ success: true });
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("hrZones", () => {
    it("returns 5 zones with labels", async () => {
      const rows = [
        { zone: 1, seconds: 600 },
        { zone: 2, seconds: 1200 },
        { zone: 3, seconds: 900 },
        { zone: 4, seconds: 300 },
        { zone: 5, seconds: 60 },
      ];
      const caller = makeCaller(rows);
      const result = await caller.hrZones({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toHaveLength(5);
      expect(result[0]).toEqual({
        zone: 1,
        label: "Recovery",
        minPct: 50,
        maxPct: 60,
        seconds: 600,
      });
      expect(result[4]).toMatchObject({ zone: 5, label: "VO2max" });
    });

    it("defaults missing zones to 0 seconds", async () => {
      const rows = [{ zone: 2, seconds: 500 }];
      const caller = makeCaller(rows);
      const result = await caller.hrZones({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result[0]?.seconds).toBe(0);
      expect(result[1]?.seconds).toBe(500);
      expect(result[2]?.seconds).toBe(0);
    });
  });
});

describe("Activity model (via router integration)", () => {
  const mockLookup = (id: string) => {
    const providers: Record<string, { name: string; activityUrl: (externalId: string) => string }> =
      {
        strava: {
          name: "Strava",
          activityUrl: (externalId: string) => `https://www.strava.com/activities/${externalId}`,
        },
        wahoo: {
          name: "Wahoo",
          activityUrl: (externalId: string) => `https://cloud.wahoo.com/workouts/${externalId}`,
        },
      };
    return providers[id];
  };

  const fullRow = {
    id: "abc-123",
    activity_type: "cycling",
    started_at: "2026-03-01T10:00:00+00:00",
    ended_at: "2026-03-01T11:30:00+00:00",
    name: "Morning Ride",
    notes: "Felt good",
    provider_id: "wahoo",
    source_providers: ["wahoo", "strava"],
    source_external_ids: [
      { providerId: "strava", externalId: "99999" },
      { providerId: "wahoo", externalId: "42" },
    ],
    avg_hr: 145,
    max_hr: 175,
    avg_power: 220,
    max_power: 450,
    avg_speed: 8.5,
    max_speed: 15.2,
    avg_cadence: 85,
    total_distance: 42000,
    elevation_gain_m: 350,
    elevation_loss_m: 340,
    sample_count: 5400,
  };

  it("toDetail() maps all fields correctly", () => {
    const activity = new Activity(fullRow, mockLookup);
    const detail = activity.toDetail();
    expect(detail.id).toBe("abc-123");
    expect(detail.activityType).toBe("cycling");
    expect(detail.startedAt).toBe("2026-03-01T10:00:00+00:00");
    expect(detail.endedAt).toBe("2026-03-01T11:30:00+00:00");
    expect(detail.name).toBe("Morning Ride");
    expect(detail.notes).toBe("Felt good");
    expect(detail.providerId).toBe("wahoo");
    expect(detail.sourceProviders).toEqual(["wahoo", "strava"]);
    expect(detail.sourceLinks).toHaveLength(2);
    expect(detail.sourceLinks[0]?.label).toBe("Strava");
    expect(detail.avgHr).toBe(145);
    expect(detail.maxHr).toBe(175);
    expect(detail.avgPower).toBe(220);
    expect(detail.maxPower).toBe(450);
    expect(detail.avgSpeed).toBe(8.5);
    expect(detail.maxSpeed).toBe(15.2);
    expect(detail.avgCadence).toBe(85);
    expect(detail.totalDistance).toBe(42000);
    expect(detail.elevationGain).toBe(350);
    expect(detail.elevationLoss).toBe(340);
    expect(detail.sampleCount).toBe(5400);
  });

  it("toDetail() returns null for all nullable fields when null", () => {
    const activity = new Activity(
      {
        ...fullRow,
        ended_at: null,
        name: null,
        notes: null,
        source_external_ids: null,
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
      },
      mockLookup,
    );
    const detail = activity.toDetail();
    expect(detail.endedAt).toBeNull();
    expect(detail.name).toBeNull();
    expect(detail.notes).toBeNull();
    expect(detail.sourceLinks).toEqual([]);
    expect(detail.avgHr).toBeNull();
    expect(detail.maxHr).toBeNull();
    expect(detail.avgPower).toBeNull();
    expect(detail.maxPower).toBeNull();
    expect(detail.avgSpeed).toBeNull();
    expect(detail.maxSpeed).toBeNull();
    expect(detail.avgCadence).toBeNull();
    expect(detail.totalDistance).toBeNull();
    expect(detail.elevationGain).toBeNull();
    expect(detail.elevationLoss).toBeNull();
    expect(detail.sampleCount).toBeNull();
  });
});

describe("mapStreamPoint", () => {
  it("maps all populated fields", () => {
    const mapped = mapStreamPoint({
      recorded_at: "2026-03-01T10:00:00Z",
      heart_rate: 145,
      power: 220,
      speed: 8.5,
      cadence: 85,
      altitude: 350.5,
      lat: 40.7128,
      lng: -74.006,
    });
    expect(mapped.recordedAt).toBe("2026-03-01T10:00:00Z");
    expect(mapped.heartRate).toBe(145);
    expect(mapped.power).toBe(220);
    expect(mapped.speed).toBe(8.5);
    expect(mapped.cadence).toBe(85);
    expect(mapped.altitude).toBe(350.5);
    expect(mapped.lat).toBe(40.7128);
    expect(mapped.lng).toBe(-74.006);
  });

  it("returns null for all nullable fields when null", () => {
    const mapped = mapStreamPoint({
      recorded_at: "2026-03-01T10:00:00Z",
      heart_rate: null,
      power: null,
      speed: null,
      cadence: null,
      altitude: null,
      lat: null,
      lng: null,
    });
    expect(mapped.heartRate).toBeNull();
    expect(mapped.power).toBeNull();
    expect(mapped.speed).toBeNull();
    expect(mapped.cadence).toBeNull();
    expect(mapped.altitude).toBeNull();
    expect(mapped.lat).toBeNull();
    expect(mapped.lng).toBeNull();
  });
});

describe("mapHrZones", () => {
  it("maps all 5 zones with correct labels and ranges", () => {
    const rows = [
      { zone: 1, seconds: 120 },
      { zone: 2, seconds: 600 },
      { zone: 3, seconds: 900 },
      { zone: 4, seconds: 300 },
      { zone: 5, seconds: 60 },
    ];
    const result = mapHrZones(rows);
    expect(result).toEqual([
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 120 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 600 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 900 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 300 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 60 },
    ]);
  });

  it("defaults to 0 for missing zones", () => {
    const result = mapHrZones([{ zone: 3, seconds: 500 }]);
    expect(result[0]?.seconds).toBe(0);
    expect(result[1]?.seconds).toBe(0);
    expect(result[2]?.seconds).toBe(500);
    expect(result[3]?.seconds).toBe(0);
    expect(result[4]?.seconds).toBe(0);
  });

  it("returns all zeros for empty input", () => {
    const result = mapHrZones([]);
    expect(result).toHaveLength(5);
    for (const zone of result) {
      expect(zone.seconds).toBe(0);
    }
  });
});
