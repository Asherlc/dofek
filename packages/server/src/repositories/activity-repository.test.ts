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

  function makeRepositoryWithSensorStore(postgresRows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(postgresRows);
    const database = { execute };
    const sensorStore = {
      getActivitySummaries: vi.fn().mockResolvedValue([]),
      getStream: vi.fn().mockResolvedValue([
        {
          recorded_at: "2024-01-15T10:00:00.000Z",
          heart_rate: 140,
          power: null,
          speed: null,
          cadence: null,
          altitude: null,
          lat: null,
          lng: null,
        },
      ]),
      getHeartRateZoneSeconds: vi.fn().mockResolvedValue([{ zone: 1, seconds: 4 }]),
      getPowerZoneSeconds: vi.fn().mockResolvedValue([{ zone: 1, seconds: 3 }]),
    };
    const repo = new ActivityRepository(database, "user-1", "UTC", undefined, sensorStore);
    return { repo, execute, sensorStore };
  }

  describe("list", () => {
    it("returns empty items when no data", async () => {
      const { repo } = makeRepositoryWithSensorStore([]);
      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      expect(result.items).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it("fails when no sensor store is configured", async () => {
      const { repo } = makeRepository([]);
      await expect(
        repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 }),
      ).rejects.toThrow("ClickHouse activity analytics store is required for activity summaries");
    });

    it("returns items and totalCount", async () => {
      const { repo } = makeRepositoryWithSensorStore([
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
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      // list query + base table count check (self-healing staleness detection)
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("skips staleness check on non-first pages", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 20 });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("builds activityTypes as a Postgres array filter when provided", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
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
      const { repo, execute } = makeRepositoryWithSensorStore([]);
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
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      const sqlObject = execute.mock.calls[0]?.[0];
      const sqlString = JSON.stringify(sqlObject);
      expect(sqlString).not.toContain("ANY");
    });

    it("extracts totalCount from single result row", async () => {
      const { repo } = makeRepositoryWithSensorStore([
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
      const { repo } = makeRepositoryWithSensorStore([]);
      const result = await repo.findById("nonexistent-id");
      expect(result).toBeNull();
    });

    it("fails when no sensor store is configured", async () => {
      const { repo } = makeRepository([]);
      await expect(repo.findById("some-id")).rejects.toThrow(
        "ClickHouse activity analytics store is required for activity summaries",
      );
    });

    it("returns activity row when found", async () => {
      const { repo } = makeRepositoryWithSensorStore([
        {
          id: "abc-123",
          activity_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T10:45:00.000Z",
          name: "Easy Run",
          notes: "Felt good",
          provider_id: "garmin",
          subsource: "Strong",
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
      expect(result?.subsource).toBe("Strong");
    });

    it("calls execute once", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.findById("some-id");
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("getStream", () => {
    it("fails when no sensor store is configured", async () => {
      const { repo } = makeRepository([]);
      await expect(repo.getStream("activity-id", 500)).rejects.toThrow(
        "ClickHouse activity analytics store is required for activity streams",
      );
    });

    it("returns StreamPoint instances from the configured sensor store", async () => {
      const { repo } = makeRepositoryWithSensorStore([
        {
          id: "activity-id",
          user_id: "user-1",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          member_activity_ids: ["activity-id"],
        },
      ]);
      const result = await repo.getStream("activity-id", 500);
      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(StreamPoint);
      expect(result[0]?.toDetail().heartRate).toBe(140);
      expect(result[0]?.toDetail().power).toBeNull();
    });

    it("delegates to the configured sensor store after resolving the activity window", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([
        {
          id: "activity-id",
          user_id: "user-1",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          member_activity_ids: ["activity-id", "source-activity-id"],
        },
      ]);

      const result = await repo.getStream("activity-id", 500);

      expect(result).toHaveLength(1);
      expect(sensorStore.getStream).toHaveBeenCalledWith(
        {
          activityId: "activity-id",
          userId: "user-1",
          startedAt: "2024-01-15T10:00:00.000Z",
          endedAt: "2024-01-15T11:00:00.000Z",
          memberActivityIds: ["activity-id", "source-activity-id"],
        },
        500,
      );
    });

    it("does not query the sensor store when the activity is not visible", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([]);

      const result = await repo.getStream("activity-id", 500);

      expect(result).toEqual([]);
      expect(sensorStore.getStream).not.toHaveBeenCalled();
    });
  });

  describe("getHrZones", () => {
    it("returns mapped HR zones from the configured sensor store", async () => {
      const { repo, execute, sensorStore } = makeRepositoryWithSensorStore([]);
      execute
        .mockResolvedValueOnce([
          {
            id: "activity-id",
            user_id: "user-1",
            started_at: "2024-01-15T10:00:00.000Z",
            ended_at: "2024-01-15T11:00:00.000Z",
            member_activity_ids: ["activity-id"],
          },
        ])
        .mockResolvedValueOnce([{ max_hr: 190, resting_hr: 55 }]);
      sensorStore.getHeartRateZoneSeconds.mockResolvedValueOnce([
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

    it("fails when no sensor store is configured", async () => {
      const { repo } = makeRepository([]);
      await expect(repo.getHrZones("activity-id")).rejects.toThrow(
        "ClickHouse activity analytics store is required for heart-rate zones",
      );
    });

    it("delegates to the configured sensor store after resolving the activity window and HR params", async () => {
      const { repo, execute, sensorStore } = makeRepositoryWithSensorStore([]);
      execute
        .mockResolvedValueOnce([
          {
            id: "activity-id",
            user_id: "user-1",
            started_at: "2024-01-15T10:00:00.000Z",
            ended_at: "2024-01-15T11:00:00.000Z",
            member_activity_ids: ["activity-id"],
          },
        ])
        .mockResolvedValueOnce([{ max_hr: 190, resting_hr: 55 }]);

      await repo.getHrZones("activity-id");

      expect(sensorStore.getHeartRateZoneSeconds).toHaveBeenCalledWith(
        {
          activityId: "activity-id",
          userId: "user-1",
          startedAt: "2024-01-15T10:00:00.000Z",
          endedAt: "2024-01-15T11:00:00.000Z",
          memberActivityIds: ["activity-id"],
        },
        190,
        55,
      );
    });
  });

  describe("getPowerZones", () => {
    it("returns mapped power zones from the configured sensor store", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([
        {
          id: "activity-id",
          user_id: "user-1",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          member_activity_ids: ["activity-id"],
        },
      ]);
      sensorStore.getPowerZoneSeconds.mockResolvedValueOnce([
        { zone: 1, seconds: 60 },
        { zone: 2, seconds: 900 },
        { zone: 3, seconds: 600 },
        { zone: 4, seconds: 240 },
        { zone: 5, seconds: 120 },
        { zone: 6, seconds: 30 },
        { zone: 7, seconds: 10 },
      ]);
      const result = await repo.getPowerZones("activity-id", 250);
      expect(result).toHaveLength(7);
      expect(result[0]?.zone).toBe(1);
      expect(result[1]?.seconds).toBe(900);
      expect(result[6]?.maxPct).toBeNull();
    });

    it("fails when no sensor store is configured", async () => {
      const { repo } = makeRepository([]);
      await expect(repo.getPowerZones("activity-id", 250)).rejects.toThrow(
        "ClickHouse activity analytics store is required for power zones",
      );
    });

    it("delegates to the configured sensor store after resolving the activity window", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([
        {
          id: "activity-id",
          user_id: "user-1",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          member_activity_ids: ["activity-id"],
        },
      ]);

      await repo.getPowerZones("activity-id", 275);

      expect(sensorStore.getPowerZoneSeconds).toHaveBeenCalledWith(
        {
          activityId: "activity-id",
          userId: "user-1",
          startedAt: "2024-01-15T10:00:00.000Z",
          endedAt: "2024-01-15T11:00:00.000Z",
          memberActivityIds: ["activity-id"],
        },
        275,
      );
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
