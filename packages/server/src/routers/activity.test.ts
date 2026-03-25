import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";

import { mapActivityDetail, mapHrZones, mapStreamPoint } from "./activity.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

// Mock tRPC infrastructure
vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null; timezone: string }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
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
          calories: 450,
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
        calories: 450,
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
          calories: 380,
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
        calories: 380,
      });
    });

    it("returns empty items and zero totalCount when no activities", async () => {
      const caller = makeCaller([]);
      const result = await caller.list({ days: 30 });
      expect(result).toEqual({ items: [], totalCount: 0 });
    });

    it("uses default limit of 20 and offset of 0", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      await caller.list({ days: 30 });
      // Verify the query was called (default params applied)
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("byId", () => {
    it("returns mapped activity detail", async () => {
      const row = {
        id: "abc-123",
        activity_type: "cycling",
        started_at: "2024-01-01T10:00:00Z",
        ended_at: "2024-01-01T11:00:00Z",
        name: "Morning Ride",
        notes: null,
        provider_id: "wahoo",
        source_providers: ["wahoo"],
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

describe("mapActivityDetail", () => {
  const fullRow = {
    id: "abc-123",
    activity_type: "cycling",
    started_at: "2026-03-01T10:00:00+00:00",
    ended_at: "2026-03-01T11:30:00+00:00",
    name: "Morning Ride",
    notes: "Felt good",
    provider_id: "wahoo",
    source_providers: ["wahoo", "strava"],
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

  it("maps all fields correctly", () => {
    const r = mapActivityDetail(fullRow);
    expect(r.id).toBe("abc-123");
    expect(r.activityType).toBe("cycling");
    expect(r.startedAt).toBe("2026-03-01T10:00:00+00:00");
    expect(r.endedAt).toBe("2026-03-01T11:30:00+00:00");
    expect(r.name).toBe("Morning Ride");
    expect(r.notes).toBe("Felt good");
    expect(r.providerId).toBe("wahoo");
    expect(r.sourceProviders).toEqual(["wahoo", "strava"]);
    expect(r.avgHr).toBe(145);
    expect(r.maxHr).toBe(175);
    expect(r.avgPower).toBe(220);
    expect(r.maxPower).toBe(450);
    expect(r.avgSpeed).toBe(8.5);
    expect(r.maxSpeed).toBe(15.2);
    expect(r.avgCadence).toBe(85);
    expect(r.totalDistance).toBe(42000);
    expect(r.elevationGain).toBe(350);
    expect(r.elevationLoss).toBe(340);
    expect(r.sampleCount).toBe(5400);
  });

  it("returns null for all nullable fields when null", () => {
    const r = mapActivityDetail({
      ...fullRow,
      ended_at: null,
      name: null,
      notes: null,
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
    });
    expect(r.endedAt).toBeNull();
    expect(r.name).toBeNull();
    expect(r.notes).toBeNull();
    expect(r.avgHr).toBeNull();
    expect(r.maxHr).toBeNull();
    expect(r.avgPower).toBeNull();
    expect(r.maxPower).toBeNull();
    expect(r.avgSpeed).toBeNull();
    expect(r.maxSpeed).toBeNull();
    expect(r.avgCadence).toBeNull();
    expect(r.totalDistance).toBeNull();
    expect(r.elevationGain).toBeNull();
    expect(r.elevationLoss).toBeNull();
    expect(r.sampleCount).toBeNull();
  });
});

describe("mapStreamPoint", () => {
  it("maps all populated fields", () => {
    const r = mapStreamPoint({
      recorded_at: "2026-03-01T10:00:00Z",
      heart_rate: 145,
      power: 220,
      speed: 8.5,
      cadence: 85,
      altitude: 350.5,
      lat: 40.7128,
      lng: -74.006,
    });
    expect(r.recordedAt).toBe("2026-03-01T10:00:00Z");
    expect(r.heartRate).toBe(145);
    expect(r.power).toBe(220);
    expect(r.speed).toBe(8.5);
    expect(r.cadence).toBe(85);
    expect(r.altitude).toBe(350.5);
    expect(r.lat).toBe(40.7128);
    expect(r.lng).toBe(-74.006);
  });

  it("returns null for all nullable fields when null", () => {
    const r = mapStreamPoint({
      recorded_at: "2026-03-01T10:00:00Z",
      heart_rate: null,
      power: null,
      speed: null,
      cadence: null,
      altitude: null,
      lat: null,
      lng: null,
    });
    expect(r.heartRate).toBeNull();
    expect(r.power).toBeNull();
    expect(r.speed).toBeNull();
    expect(r.cadence).toBeNull();
    expect(r.altitude).toBeNull();
    expect(r.lat).toBeNull();
    expect(r.lng).toBeNull();
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
