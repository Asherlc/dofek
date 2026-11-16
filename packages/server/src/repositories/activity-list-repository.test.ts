import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { routeMapPreview } from "../lib/map-preview.ts";
import { ActivityListRepository } from "./activity-list-repository.ts";

const loggerMocks = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../logger.ts", () => ({ logger: { info: loggerMocks.info } }));
vi.mock("./activity-route-preview.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./activity-route-preview.ts")>()),
  getActivityMapReadiness: vi.fn().mockResolvedValue(new Map()),
}));

describe("ActivityListRepository", () => {
  const dialect = new PgDialect();

  function withUnknownLocalTimeContext(rows: Record<string, unknown>[]) {
    return rows.map((row) =>
      "canonical_type" in row || "activity_type" in row
        ? {
            provider_type:
              typeof row.provider_type === "string"
                ? row.provider_type
                : typeof row.canonical_type === "string"
                  ? row.canonical_type
                  : row.activity_type,
            raw_type:
              typeof row.raw_type === "string"
                ? row.raw_type
                : typeof row.provider_type === "string"
                  ? row.provider_type
                  : typeof row.canonical_type === "string"
                    ? row.canonical_type
                    : row.activity_type,
            timezone: null,
            primary_activity_id: null,
            primary_canonical_type: null,
            primary_provider_id: null,
            primary_source_name: null,
            origin_candidate_member_ids: [],
            fit_recovery_error: false,
            start_utc_offset_minutes: null,
            end_utc_offset_minutes: null,
            local_time_source: "unknown",
            perceived_exertion: null,
            displayed_date:
              typeof row.displayed_date === "string" ? row.displayed_date : "2026-01-01",
            ...row,
          }
        : row,
    );
  }

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockImplementation((query) => {
      const compiledQuery = dialect.sqlToQuery(query);
      if (compiledQuery.sql.includes("fitness.v_climbing_log_activity")) return Promise.resolve([]);
      if (compiledQuery.sql.includes("identity_candidates")) {
        const requestedId = compiledQuery.params[0];
        const resolvedGroupId = typeof rows[0]?.id === "string" ? rows[0].id : null;
        return Promise.resolve(
          resolvedGroupId && typeof requestedId === "string"
            ? [
                {
                  requested_id: requestedId,
                  resolved_group_id: resolvedGroupId,
                  resolution_kind: requestedId === resolvedGroupId ? "group" : "member",
                },
              ]
            : [],
        );
      }
      return Promise.resolve(withUnknownLocalTimeContext(rows));
    });
    const database = { execute };
    const repo = new ActivityListRepository(database, "user-1", "UTC");
    return { repo, execute };
  }

  function makeRepositoryWithSensorStore(
    postgresRows: Record<string, unknown>[] = [],
    climbingLogSessions: Record<string, unknown>[] = [],
  ) {
    const execute = vi.fn().mockImplementation((query) => {
      const compiledQuery = dialect.sqlToQuery(query);
      if (compiledQuery.sql.includes("fitness.v_climbing_log_activity"))
        return Promise.resolve(climbingLogSessions);
      if (compiledQuery.sql.includes("activity_device_observation")) return Promise.resolve([]);
      if (compiledQuery.sql.includes("identity_candidates")) {
        const requestedId = compiledQuery.params.find(
          (parameter) => typeof parameter === "string" && parameter !== "user-1",
        );
        const row = postgresRows[0];
        const resolvedGroupId = typeof row?.id === "string" ? row.id : null;
        return Promise.resolve(
          resolvedGroupId && requestedId
            ? [
                {
                  requested_id: requestedId,
                  resolved_group_id: resolvedGroupId,
                  resolution_kind: requestedId === resolvedGroupId ? "group" : "member",
                },
              ]
            : [],
        );
      }
      return Promise.resolve(withUnknownLocalTimeContext(postgresRows));
    });
    const database = { execute };
    const sensorStore = {
      query: vi.fn().mockResolvedValue([]),
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
    const repo = new ActivityListRepository(database, "user-1", "UTC", undefined, sensorStore);
    return { repo, execute, sensorStore };
  }

  describe("list", () => {
    it("returns empty items when no data", async () => {
      const { repo } = makeRepositoryWithSensorStore([]);
      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      expect(result.items).toEqual([]);
      expect(result.totalCount).toBe(0);
    });

    it("returns rows without summaries when no sensor store is configured", async () => {
      const { repo } = makeRepository([
        {
          id: "abc-123",
          canonical_type: "cycling",
          provider_type: "road_cycling",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Morning Ride",
          provider_id: "garmin",
          source_providers: ["garmin"],
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          distance_meters: null,
          total_count: 1,
        },
      ]);
      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      expect(result.totalCount).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toHaveProperty("id", "abc-123");
      expect(result.items[0]).toHaveProperty("distance_state", {
        status: "missing",
        reason: "Distance not recorded",
      });
    });

    it("returns items and totalCount", async () => {
      const { repo } = makeRepositoryWithSensorStore([
        {
          id: "abc-123",
          canonical_type: "cycling",
          provider_type: "road_cycling",
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
      expect(result.items[0]).toHaveProperty("raw_type", "road_cycling");
    });

    it("serializes every unavailable sensor field as null while hydration is pending", async () => {
      const { repo } = makeRepositoryWithSensorStore([
        {
          id: "pending-hydration",
          canonical_type: "cycling",
          provider_type: "indoor_cycling",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Power Zone Ride",
          provider_id: "peloton",
          source_providers: ["peloton"],
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          distance_meters: null,
          elevation_gain_m: null,
          total_count: 1,
        },
      ]);

      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });

      expect(result.items[0]).toMatchObject({
        avg_hr: null,
        max_hr: null,
        avg_power: null,
        max_power: null,
        avg_speed: null,
        max_speed: null,
        avg_cadence: null,
        total_distance: null,
        distance_meters: null,
        elevation_gain_m: null,
        elevation_loss_m: null,
        sample_count: null,
        location: null,
      });
    });

    it.each(["list", "search", "listRange"] as const)(
      "passes %s rows through summary enrichment",
      async (reader) => {
        const { repo, sensorStore } = makeRepositoryWithSensorStore([
          {
            id: "stable-group-id",
            canonical_type: "running",
            started_at: "2024-01-15T10:00:00.000Z",
            ended_at: "2024-01-15T11:00:00.000Z",
            name: "Morning Run",
            provider_id: "strava",
            source_providers: ["strava"],
            member_activity_ids: ["clickhouse-row-id", "provider-row-id"],
            avg_hr: null,
            max_hr: null,
            avg_power: null,
            distance_meters: null,
            total_count: 1,
          },
        ]);
        sensorStore.getActivitySummaries.mockResolvedValueOnce([
          {
            activity_id: "stable-group-id",
            avg_hr: 145,
            max_hr: 171,
            avg_power: 220,
            max_power: 450,
            avg_speed: 8,
            max_speed: 13,
            avg_cadence: 82,
            total_distance: 5000,
            elevation_gain_m: 120,
            elevation_loss_m: 90,
            sample_count: 3600,
            centroid_lat: 37.7749,
            centroid_lng: -122.4194,
          },
        ]);

        const item =
          reader === "list"
            ? (await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 })).items[0]
            : reader === "search"
              ? (await repo.search({ startDate: "2024-01-01", endDate: "2024-02-01" })).items[0]
              : (await repo.listRange("2024-01-01", "2024-02-01"))[0];

        expect(sensorStore.getActivitySummaries).toHaveBeenCalledExactlyOnceWith([
          "stable-group-id",
        ]);
        expect(item).toMatchObject({ max_speed: 13 });
        expect(item).toMatchObject({
          id: "stable-group-id",
          avg_hr: 145,
          distance_meters: 5000,
          elevation_gain_m: 120,
          elevation_state: { status: "available" },
          location: {
            kind: "recorded_gps",
            centroidLat: 37.7749,
            centroidLng: -122.4194,
            mapPreview: routeMapPreview([{ lat: 37.7749, lng: -122.4194 }]),
          },
        });
        expect(item).not.toHaveProperty("member_activity_ids");
      },
    );
    it("selects member activity aliases for summary hydration", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      const sqlObject = execute.mock.calls[0]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("a.id");
      expect(compiledQuery.sql).toContain("a.member_activity_ids");
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity a");
    });

    it("applies finite selected-range lower-bound filters", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);

      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("a.started_at > ($2::date - $3::int)::timestamp");
      expect(compiledQuery.params).toEqual(expect.arrayContaining(["2024-02-01", 30]));
    });

    it("omits selected-range lower-bound filters when days is null", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);

      await repo.list({ days: null, endDate: "2024-02-01", limit: 20, offset: 0 });

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity a");
      expect(compiledQuery.sql).not.toContain("a.started_at >");
      expect(compiledQuery.params).not.toContain(null);
    });

    it("returns empty first pages without stale-view self-healing", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
      expect(result.totalCount).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1);
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
      expect(compiledQuery.sql).toContain("a.canonical_type IN (");
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
      expect(compiledQuery.sql).toContain("a.canonical_type IN (");
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

    it("does not filter when activityTypes is an empty list", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.list({
        days: 30,
        endDate: "2024-02-01",
        limit: 20,
        offset: 0,
        activityTypes: [],
      });
      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).not.toContain("a.canonical_type IN");
    });

    it("extracts totalCount from single result row", async () => {
      const { repo } = makeRepositoryWithSensorStore([
        {
          id: "abc-1",
          canonical_type: "running",
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

  describe("search and listRange", () => {
    it("search returns the public distance state for a missing measurement", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "search-activity",
          canonical_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Morning Run",
          provider_id: "garmin",
          source_providers: ["garmin"],
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          distance_meters: null,
          total_count: 1,
        },
      ]);

      const result = await repo.search({
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        query: "Morning",
        limit: 20,
      });

      expect(result).toEqual({
        totalCount: 1,
        items: [
          expect.objectContaining({
            id: "search-activity",
            distance_meters: null,
            distance_state: {
              status: "missing",
              reason: "Distance not recorded",
            },
          }),
        ],
      });
      expect(result.items[0]).not.toHaveProperty("total_count");
      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.params).toContain("%Morning%");
      expect(compiledQuery.params).toContain(20);
    });

    it("escapes wildcard characters in search text", async () => {
      const { repo, execute } = makeRepository([]);
      await repo.search({
        startDate: "2024-01-01",
        endDate: "2024-01-31",
        query: "%_\\",
        limit: 20,
      });
      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.params).toContain("%\\%\\_\\\\%");
    });

    it("listRange preserves a recorded zero and emits an available distance state", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "zero-distance-activity",
          canonical_type: "strength",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Strength Session",
          provider_id: "garmin",
          source_providers: ["garmin"],
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          distance_meters: 0,
          elevation_gain_m: 0,
          total_count: 1,
        },
      ]);

      const result = await repo.listRange("2024-01-01", "2024-01-31", ["strength"]);

      expect(result).toEqual([
        expect.objectContaining({
          id: "zero-distance-activity",
          distance_meters: 0,
          distance_state: { status: "available" },
          elevation_gain_m: 0,
          elevation_state: { status: "available" },
        }),
      ]);
      expect(result[0]).not.toHaveProperty("total_count");
      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("a.canonical_type IN (");
      expect(compiledQuery.params).toContain("strength");
    });

    it("does not add a type filter to listRange for an empty list", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.listRange("2024-01-01", "2024-01-31", []);

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).not.toContain("a.canonical_type IN");
    });
  });

  describe("countVisibleInWindow", () => {
    it("countVisibleInWindow counts rows in v_activity", async () => {
      const { repo, execute } = makeRepository([{ activity_count: 4 }]);

      const count = await repo.countVisibleInWindow({ days: 30 });

      expect(count).toBe(4);
      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity");
    });

    it("does not add a canonical type filter for an empty list", async () => {
      const { repo, execute } = makeRepository([{ activity_count: 4 }]);

      await repo.countVisibleInWindow({ days: 30, activityTypes: [] });

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).not.toContain("canonical_type IN");
    });

    it("countVisibleInWindow applies finite lower-bound filters", async () => {
      const { repo, execute } = makeRepository([{ activity_count: 4 }]);

      await repo.countVisibleInWindow({ days: 30 });

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain(
        "started_at > CURRENT_TIMESTAMP - $2::int * INTERVAL '1 day'",
      );
      expect(compiledQuery.params).toEqual(expect.arrayContaining(["user-1", 30]));
    });

    it("countVisibleInWindow omits lower-bound filters for unbounded ranges", async () => {
      const { repo, execute } = makeRepository([{ activity_count: 4 }]);

      await repo.countVisibleInWindow({
        days: null,
        activityTypes: ["cycling"],
        requireEndedAt: true,
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "trial",
          startDate: "2024-01-01",
          endDateExclusive: "2024-02-01",
        },
      });

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity");
      expect(compiledQuery.sql).not.toContain("CURRENT_TIMESTAMP -");
      expect(compiledQuery.sql).toContain("AND ended_at IS NOT NULL");
      expect(compiledQuery.sql).toContain("AND canonical_type IN");
      expect(compiledQuery.sql).toContain(
        "AND started_at >= (CAST($3::date AS timestamp without time zone) AT TIME ZONE $4)",
      );
      expect(compiledQuery.sql).toContain(
        "AND started_at < (CAST($5::date AS timestamp without time zone) AT TIME ZONE $6)",
      );
      expect(compiledQuery.params).toEqual([
        "user-1",
        "cycling",
        "2024-01-01",
        "UTC",
        "2024-02-01",
        "UTC",
      ]);
    });
  });
});
