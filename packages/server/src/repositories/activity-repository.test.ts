import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ActivityRepository, StreamPoint } from "./activity-repository.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

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
    });
    const detail = point.toDetail();
    expect(detail.heartRate).toBeNull();
    expect(detail.power).toBeNull();
    expect(detail.speed).toBeNull();
    expect(detail.cadence).toBeNull();
    expect(detail.altitude).toBeNull();
    expect(detail.lat).toBeNull();
    expect(detail.lng).toBeNull();
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

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("ActivityRepository", () => {
  const dialect = new PgDialect();

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(rows);
    const database = { execute };
    const repo = new ActivityRepository(database, "user-1", "UTC");
    return { repo, execute };
  }

  describe("list", () => {
    it("returns empty items when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      expect(result.items).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it("returns items and totalCount", async () => {
      const { repo } = makeRepository([
        {
          id: "abc-123",
          activity_type: "cycling",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Morning Ride",
          provider_id: "garmin",
          source_providers: ["garmin"],
          avg_hr: 140,
          max_hr: 175,
          avg_power: 200,
          distance_meters: 30000,
          total_count: 5,
        },
      ]);
      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      expect(result.totalCount).toBe(5);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).not.toHaveProperty("total_count");
      expect(result.items[0]).toHaveProperty("id", "abc-123");
    });

    it("checks base table for staleness when first page is empty", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      // list query + base table count check (self-healing staleness detection)
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("skips staleness check on non-first pages", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 20 });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("builds activityTypes as a Postgres array filter when provided", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list({
        days: 30,
        endDate: "2024-02-01",
        limit: 20,
        offset: 20,
        activityTypes: ["cycling", "running"],
      });
      expect(execute).toHaveBeenCalledTimes(1);
      const sqlObject = execute.mock.calls[0]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("a.activity_type IN (");
      expect(compiledQuery.sql).not.toContain("ANY(($");
      expect(compiledQuery.params).toEqual(expect.arrayContaining(["cycling", "running"]));
    });

    it("uses IN syntax for multi-value activityTypes filters without row expressions", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list({
        days: 30,
        endDate: "2024-02-01",
        limit: 20,
        offset: 20,
        activityTypes: [
          "strength",
          "strength_training",
          "functional_strength",
          "functional_fitness",
        ],
      });
      const sqlObject = execute.mock.calls[0]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("a.activity_type IN (");
      expect(compiledQuery.sql).not.toContain("ANY(($");
      expect(compiledQuery.params).toEqual(
        expect.arrayContaining([
          "strength",
          "strength_training",
          "functional_strength",
          "functional_fitness",
        ]),
      );
    });

    it("does not include activityTypes filter when not provided", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      const sqlObject = execute.mock.calls[0]?.[0];
      const sqlString = JSON.stringify(sqlObject);
      expect(sqlString).not.toContain("ANY");
    });

    it("extracts totalCount from single result row", async () => {
      const { repo } = makeRepository([
        {
          id: "abc-1",
          activity_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Run",
          provider_id: "garmin",
          source_providers: ["garmin"],
          avg_hr: 140,
          max_hr: 175,
          avg_power: null,
          distance_meters: 10000,
          total_count: 1,
        },
      ]);
      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      expect(result.totalCount).toBe(1);
      expect(result.items).toHaveLength(1);
    });
  });

  describe("findById", () => {
    it("returns null when not found", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.findById("nonexistent-id");
      expect(result).toBeNull();
    });

    it("returns activity row when found", async () => {
      const { repo } = makeRepository([
        {
          id: "abc-123",
          activity_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T10:45:00.000Z",
          name: "Easy Run",
          notes: "Felt good",
          provider_id: "garmin",
          source_providers: ["garmin"],
          source_external_ids: [{ providerId: "garmin", externalId: "ext-1" }],
          avg_hr: 135,
          max_hr: 160,
          avg_power: null,
          max_power: null,
          avg_speed: 3.5,
          max_speed: 4.2,
          avg_cadence: 170,
          total_distance: 8000,
          elevation_gain_m: 50,
          elevation_loss_m: 45,
          sample_count: 2700,
        },
      ]);
      const result = await repo.findById("abc-123");
      expect(result).not.toBeNull();
      expect(result?.id).toBe("abc-123");
      expect(result?.activity_type).toBe("running");
      expect(result?.name).toBe("Easy Run");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.findById("some-id");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getStream", () => {
    it("returns empty array when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getStream("activity-id", 500);
      expect(result).toEqual([]);
    });

    it("returns StreamPoint instances", async () => {
      const { repo } = makeRepository([
        {
          recorded_at: "2024-01-15T10:00:00.000Z",
          heart_rate: 140,
          power: 200,
          speed: 8.0,
          cadence: 85,
          altitude: 300,
          lat: 47.6,
          lng: -122.3,
        },
        {
          recorded_at: "2024-01-15T10:00:05.000Z",
          heart_rate: 142,
          power: null,
          speed: 8.1,
          cadence: 86,
          altitude: 301,
          lat: null,
          lng: null,
        },
      ]);
      const result = await repo.getStream("activity-id", 500);
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(StreamPoint);
      expect(result[0]?.toDetail().heartRate).toBe(140);
      expect(result[1]?.toDetail().power).toBeNull();
    });
  });

  describe("getHrZones", () => {
    it("returns mapped HR zones", async () => {
      const { repo } = makeRepository([
        { zone: 1, seconds: 120 },
        { zone: 2, seconds: 300 },
        { zone: 3, seconds: 600 },
        { zone: 4, seconds: 400 },
        { zone: 5, seconds: 80 },
      ]);
      const result = await repo.getHrZones("activity-id");
      expect(result).toHaveLength(5);
      expect(result[0]?.zone).toBe(1);
      expect(result[0]?.seconds).toBe(120);
    });

    it("returns all 5 zones with zero seconds when no data", async () => {
      const { repo } = makeRepository([]);
      const result = await repo.getHrZones("activity-id");
      expect(result).toHaveLength(5);
      for (const zone of result) {
        expect(zone.seconds).toBe(0);
      }
    });
  });

  describe("delete", () => {
    it("calls execute", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.delete("activity-id");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });
});
