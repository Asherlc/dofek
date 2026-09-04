import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { osmTilePreview } from "../lib/osm-tile.ts";
import {
  ActivityRepository,
  StreamPoint,
  selectCompatibleActivitySummary,
} from "./activity-repository.ts";

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

describe("selectCompatibleActivitySummary", () => {
  it("uses the Wahoo cycling member when it is available", () => {
    const cyclingRow = { canonical_type: "cycling", provider_id: "wahoo" };
    const summaries = [
      { activity_id: "wahoo-member", canonical_type: "cycling", provider_id: "wahoo" },
      { activity_id: "peloton-member", canonical_type: "cycling", provider_id: "peloton" },
    ];

    expect(selectCompatibleActivitySummary).toBeTypeOf("function");
    expect(selectCompatibleActivitySummary(cyclingRow, summaries)?.activity_id).toBe(
      "wahoo-member",
    );
  });

  it("does not use a Peloton cycling summary for a running activity", () => {
    const runningRow = { canonical_type: "running", provider_id: "wahoo" };
    const pelotonOnlySummaries = [
      { activity_id: "peloton-member", canonical_type: "cycling", provider_id: "peloton" },
    ];

    expect(selectCompatibleActivitySummary).toBeTypeOf("function");
    expect(selectCompatibleActivitySummary(runningRow, pelotonOnlySummaries)).toBeNull();
  });

  it("allows a matching non-other type to hydrate across providers", () => {
    const cyclingRow = { canonical_type: "cycling", provider_id: "wahoo" };
    const pelotonCyclingSummary = {
      activity_id: "peloton-member",
      canonical_type: "cycling",
      provider_id: "peloton",
    };

    expect(selectCompatibleActivitySummary(cyclingRow, [pelotonCyclingSummary])).toBe(
      pelotonCyclingSummary,
    );
  });

  it("requires an other summary to come from the canonical provider", () => {
    const otherRow = { canonical_type: "other", provider_id: "wahoo" };
    const pelotonSummary = {
      activity_id: "peloton-member",
      canonical_type: "other",
      provider_id: "peloton",
    };
    const wahooSummary = {
      activity_id: "wahoo-member",
      canonical_type: "other",
      provider_id: "wahoo",
    };

    expect(selectCompatibleActivitySummary(otherRow, [pelotonSummary, wahooSummary])).toBe(
      wahooSummary,
    );
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("ActivityRepository", () => {
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
            start_utc_offset_minutes: null,
            end_utc_offset_minutes: null,
            local_time_source: "unknown",
            perceived_exertion: null,
            ...row,
          }
        : row,
    );
  }

  function makeRepository(rows: Record<string, unknown>[] = []) {
    const execute = vi.fn().mockResolvedValue(withUnknownLocalTimeContext(rows));
    const database = { execute };
    const repo = new ActivityRepository(database, "user-1", "UTC");
    return { repo, execute };
  }

  function makeRepositoryWithSensorStore(postgresRows: Record<string, unknown>[] = []) {
    const memberRows = postgresRows.flatMap((row) => {
      const id = typeof row.id === "string" ? row.id : null;
      const canonicalType = typeof row.canonical_type === "string" ? row.canonical_type : null;
      const providerId = typeof row.provider_id === "string" ? row.provider_id : null;
      if (!id || !canonicalType || !providerId) return [];
      return [id, ...(Array.isArray(row.member_activity_ids) ? row.member_activity_ids : [])].map(
        (activity_id) => ({ activity_id, canonical_type: canonicalType, provider_id: providerId }),
      );
    });
    const execute = vi.fn().mockImplementation((query) => {
      const compiledQuery = dialect.sqlToQuery(query);
      return Promise.resolve(
        compiledQuery.sql.includes("FROM fitness.activity")
          ? memberRows
          : withUnknownLocalTimeContext(postgresRows),
      );
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
    const repo = new ActivityRepository(database, "user-1", "UTC", undefined, sensorStore);
    return { repo, execute, sensorStore };
  }

  describe("activity visibility", () => {
    it("resolveVisibleActivityIds returns ids present in v_activity", async () => {
      const { repo, execute } = makeRepository([{ id: "activity-1" }]);

      const visibleIds = await repo.resolveVisibleActivityIds(["activity-1", "activity-2"]);

      expect(visibleIds).toEqual(new Set(["activity-1"]));
      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity");
      expect(compiledQuery.params).toContain("user-1");
    });

    it("resolveVisibleActivityIds applies the repository access window", async () => {
      const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
      const repo = new ActivityRepository({ execute }, "user-1", "UTC", {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-17",
      });

      await repo.resolveVisibleActivityIds(["activity-1", "activity-2"]);

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain(
        "started_at >= (CAST($4::date AS timestamp without time zone) AT TIME ZONE $5)",
      );
      expect(compiledQuery.sql).toContain(
        "started_at < (CAST($6::date AS timestamp without time zone) AT TIME ZONE $7)",
      );
      expect(compiledQuery.params).toEqual([
        "user-1",
        "activity-1",
        "activity-2",
        "2026-03-10",
        "UTC",
        "2026-03-17",
        "UTC",
      ]);
    });

    it("listVisibleActivityIdsSince applies the local-date and access windows", async () => {
      const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
      const repo = new ActivityRepository({ execute }, "user-1", "America/Los_Angeles", {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-17",
      });

      await expect(repo.listVisibleActivityIdsSince("2026-02-01")).resolves.toEqual(["activity-1"]);

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("started_at >= ($2::date AT TIME ZONE $3)");
      expect(compiledQuery.sql).toContain(
        "started_at >= (CAST($4::date AS timestamp without time zone) AT TIME ZONE $5)",
      );
      expect(compiledQuery.sql).toContain(
        "started_at < (CAST($6::date AS timestamp without time zone) AT TIME ZONE $7)",
      );
      expect(compiledQuery.params).toEqual([
        "user-1",
        "2026-02-01",
        "America/Los_Angeles",
        "2026-03-10",
        "America/Los_Angeles",
        "2026-03-17",
        "America/Los_Angeles",
      ]);
    });

    it("listVisibleActivityIdsInRange applies an exclusive local-date end", async () => {
      const execute = vi.fn().mockResolvedValue([{ id: "activity-1" }]);
      const repo = new ActivityRepository({ execute }, "user-1", "America/Los_Angeles");

      await expect(repo.listVisibleActivityIdsInRange("2026-02-01", "2026-03-01")).resolves.toEqual(
        ["activity-1"],
      );

      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("started_at >= ($2::date AT TIME ZONE $3)");
      expect(compiledQuery.sql).toContain("started_at < ($4::date AT TIME ZONE $5)");
      expect(compiledQuery.params).toEqual([
        "user-1",
        "2026-02-01",
        "America/Los_Angeles",
        "2026-03-01",
        "America/Los_Angeles",
      ]);
    });

    it("countVisibleInWindow counts rows in v_activity", async () => {
      const { repo, execute } = makeRepository([{ activity_count: 4 }]);

      const count = await repo.countVisibleInWindow({ days: 30 });

      expect(count).toBe(4);
      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity");
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

    it("resolveVisibleActivityIds skips the query when no ids are provided", async () => {
      const { repo, execute } = makeRepository([]);

      const visibleIds = await repo.resolveVisibleActivityIds([]);

      expect(visibleIds).toEqual(new Set());
      expect(execute).not.toHaveBeenCalled();
    });

    it("filterToVisibleActivities keeps only rows visible in v_activity", async () => {
      const { repo } = makeRepository([{ id: "activity-1" }]);

      const filtered = await repo.filterToVisibleActivities([
        { id: "activity-1", name: "Run" },
        { id: "activity-2", name: "Ride" },
      ]);

      expect(filtered).toEqual([{ id: "activity-1", name: "Run" }]);
    });

    it("filters already-canonical activity rows without expanding v_activity", async () => {
      const { repo, execute } = makeRepository([{ id: "activity-1" }]);

      const filtered = await repo.filterToVisibleCanonicalActivities([
        { id: "activity-1", name: "Run" },
        { id: "activity-2", name: "Ride" },
      ]);

      expect(filtered).toEqual([{ id: "activity-1", name: "Run" }]);
      const compiledQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(compiledQuery.sql).toContain("FROM fitness.activity");
      expect(compiledQuery.sql).not.toContain("FROM fitness.v_activity");
      expect(compiledQuery.sql).toContain("provider_absent_at IS NULL");
      expect(compiledQuery.sql).toContain("deleted_at IS NULL");
    });
  });

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

    it("hydrates summaries from any member activity id", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([
        {
          id: "provider-row-id",
          canonical_type: "cycling",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Morning Ride",
          provider_id: "strava",
          source_providers: ["apple_health", "strava"],
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
          activity_id: "clickhouse-row-id",
          avg_hr: 145,
          max_hr: 171,
          avg_power: 220,
          max_power: 450,
          avg_speed: 8,
          max_speed: 13,
          avg_cadence: 82,
          total_distance: 42000,
          elevation_gain_m: 610,
          elevation_loss_m: 590,
          sample_count: 3600,
        },
      ]);

      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });

      expect(sensorStore.getActivitySummaries).toHaveBeenCalledWith([
        "provider-row-id",
        "clickhouse-row-id",
      ]);
      expect(result.items[0]).toMatchObject({
        id: "provider-row-id",
        avg_hr: 145,
        max_hr: 171,
        avg_power: 220,
        distance_meters: 42000,
        elevation_gain_m: 610,
        elevation_state: { status: "available" },
      });
      expect(result.items[0]).not.toHaveProperty("member_activity_ids");
    });

    it("does not hydrate a running activity from an incompatible Peloton cycling member", async () => {
      const { repo, execute, sensorStore } = makeRepositoryWithSensorStore([]);
      execute
        .mockResolvedValueOnce(
          withUnknownLocalTimeContext([
            {
              id: "running-group",
              canonical_type: "running",
              started_at: "2024-01-15T10:00:00.000Z",
              ended_at: "2024-01-15T11:00:00.000Z",
              name: "Morning Run",
              provider_id: "wahoo",
              source_providers: ["peloton", "wahoo"],
              member_activity_ids: ["peloton-member"],
              avg_hr: null,
              max_hr: null,
              avg_power: null,
              distance_meters: null,
              total_count: 1,
            },
          ]),
        )
        .mockResolvedValueOnce([
          {
            activity_id: "peloton-member",
            canonical_type: "cycling",
            provider_id: "peloton",
          },
        ]);
      sensorStore.getActivitySummaries.mockResolvedValueOnce([
        {
          activity_id: "peloton-member",
          avg_hr: 145,
          max_hr: 171,
          avg_power: 220,
          max_power: 450,
          avg_speed: 8,
          max_speed: 13,
          avg_cadence: 82,
          total_distance: 42000,
          elevation_gain_m: 610,
          elevation_loss_m: 590,
          sample_count: 3600,
        },
      ]);

      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });

      expect(result.items[0]).toMatchObject({
        id: "running-group",
        distance_meters: null,
        distance_state: { status: "missing", reason: "Distance not recorded" },
      });
    });

    it("does not feed Peloton power into incompatible range activities before MCP gating", async () => {
      const { repo, execute, sensorStore } = makeRepositoryWithSensorStore([]);
      execute
        .mockResolvedValueOnce(
          withUnknownLocalTimeContext([
            {
              id: "running-group",
              canonical_type: "running",
              started_at: "2024-01-15T10:00:00.000Z",
              ended_at: "2024-01-15T11:00:00.000Z",
              name: "Morning Run",
              provider_id: "wahoo",
              source_providers: ["peloton", "wahoo"],
              member_activity_ids: ["peloton-member"],
              avg_hr: null,
              max_hr: null,
              avg_power: null,
              distance_meters: null,
              total_count: 1,
            },
            {
              id: "other-group",
              canonical_type: "other",
              started_at: "2024-01-15T12:00:00.000Z",
              ended_at: "2024-01-15T13:00:00.000Z",
              name: "Unclassified activity",
              provider_id: "wahoo",
              source_providers: ["peloton", "wahoo"],
              member_activity_ids: ["peloton-member"],
              avg_hr: null,
              max_hr: null,
              avg_power: null,
              distance_meters: null,
              total_count: 1,
            },
          ]),
        )
        .mockResolvedValueOnce([
          {
            activity_id: "peloton-member",
            canonical_type: "cycling",
            provider_id: "peloton",
          },
        ]);
      sensorStore.getActivitySummaries.mockResolvedValueOnce([
        {
          activity_id: "peloton-member",
          avg_hr: 145,
          max_hr: 171,
          avg_power: 220,
          max_power: 450,
          avg_speed: 8,
          max_speed: 13,
          avg_cadence: 82,
          total_distance: 42_000,
          elevation_gain_m: 610,
          elevation_loss_m: 590,
          sample_count: 3600,
        },
      ]);

      const result = await repo.listRange("2024-01-15", "2024-01-15");

      expect(result).toEqual([
        expect.objectContaining({ id: "running-group", avg_power: null }),
        expect.objectContaining({ id: "other-group", avg_power: null }),
      ]);
    });

    it("adds a location summary when hydrated summaries include a route centroid", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([
        {
          id: "provider-row-id",
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
          activity_id: "clickhouse-row-id",
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

      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });

      expect(result.items[0]).toMatchObject({
        location: {
          centroidLat: 37.7749,
          centroidLng: -122.4194,
          mapPreview: osmTilePreview([{ lat: 37.7749, lng: -122.4194 }]),
        },
        distance_meters: 5000,
        distance_state: { status: "available" },
        elevation_gain_m: 120,
        elevation_state: { status: "available" },
      });
    });

    it("keeps elevation value and state when a summary has no centroid", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([
        {
          id: "route-less-activity",
          canonical_type: "strength",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Strength Session",
          provider_id: "garmin",
          source_providers: ["garmin"],
          member_activity_ids: [],
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          distance_meters: null,
          total_count: 1,
        },
      ]);
      sensorStore.getActivitySummaries.mockResolvedValueOnce([
        {
          activity_id: "route-less-activity",
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          max_power: null,
          avg_speed: null,
          max_speed: null,
          avg_cadence: null,
          total_distance: 0,
          elevation_gain_m: 0,
          elevation_loss_m: null,
          sample_count: 0,
          centroid_lat: null,
          centroid_lng: null,
        },
      ]);

      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });

      expect(result.items[0]).toMatchObject({
        location: null,
        distance_meters: 0,
        distance_state: { status: "available" },
        elevation_gain_m: 0,
        elevation_state: { status: "available" },
      });
    });

    it("adds a route preview when hydrated summaries include location samples", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([
        {
          id: "provider-row-id",
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
          activity_id: "clickhouse-row-id",
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
      sensorStore.query.mockResolvedValueOnce([
        { activity_id: "clickhouse-row-id", lat: 37.7749, lng: -122.4194 },
        { activity_id: "clickhouse-row-id", lat: 37.7752, lng: -122.4188 },
        { activity_id: "clickhouse-row-id", lat: 37.7756, lng: -122.4182 },
      ]);

      const result = await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });

      expect(result.items[0]?.location).toMatchObject({
        mapPreview: osmTilePreview([
          { lat: 37.7749, lng: -122.4194 },
          { lat: 37.7752, lng: -122.4188 },
          { lat: 37.7756, lng: -122.4182 },
        ]),
      });
    });

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
      await repo.list({ days: 30, endDate: "2024-02-01", limit: 20, offset: 0 });
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
      const { repo } = makeRepository([
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
    });

    it("listRange preserves a recorded zero and emits an available distance state", async () => {
      const { repo } = makeRepository([
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
          total_count: 1,
        },
      ]);

      const result = await repo.listRange("2024-01-01", "2024-01-31", ["strength"]);

      expect(result).toEqual([
        expect.objectContaining({
          id: "zero-distance-activity",
          distance_meters: 0,
          distance_state: { status: "available" },
        }),
      ]);
      expect(result[0]).not.toHaveProperty("total_count");
    });
  });

  describe("findById", () => {
    it("returns null when not found", async () => {
      const { repo } = makeRepositoryWithSensorStore([]);
      const result = await repo.findById("nonexistent-id");
      expect(result).toBeNull();
    });

    it("falls back to provider-absent activities when the canonical view excludes them", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: "tombstoned-id",
            canonical_type: "running",
            raw_type: "running",
            started_at: "2024-01-15T10:00:00.000Z",
            ended_at: "2024-01-15T10:45:00.000Z",
            timezone: null,
            start_utc_offset_minutes: null,
            end_utc_offset_minutes: null,
            local_time_source: "unknown",
            name: "Deleted Run",
            notes: null,
            perceived_exertion: null,
            provider_id: "strava",
            subsource: null,
            source_providers: ["strava"],
            source_external_ids: [{ providerId: "strava", externalId: "123" }],
            member_activity_ids: ["tombstoned-id"],
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
            provider_absent_at: "2024-01-16T08:00:00.000Z",
          },
        ]);
      const database = { execute };
      const sensorStore = {
        query: vi.fn().mockResolvedValue([]),
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([]),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
      };
      const repo = new ActivityRepository(database, "user-1", "UTC", undefined, sensorStore);

      const result = await repo.findById("tombstoned-id");

      expect(result).toMatchObject({
        id: "tombstoned-id",
        provider_id: "strava",
        provider_absent_at: "2024-01-16T08:00:00.000Z",
      });
      const fallbackQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
      expect(fallbackQuery.sql).toContain("provider_absent_at IS NOT NULL");
    });

    it("returns a row without summaries when no sensor store is configured", async () => {
      const { repo } = makeRepository([
        {
          id: "abc-123",
          canonical_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T10:45:00.000Z",
          name: "Morning Run",
          notes: "",
          perceived_exertion: null,
          provider_id: "garmin",
          subsource: "Garmin Connect",
          source_providers: ["garmin"],
          source_external_ids: [{ providerId: "garmin", externalId: "activity-1" }],
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
          provider_absent_at: null,
        },
      ]);
      const result = await repo.findById("abc-123");
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("id", "abc-123");
    });

    it("returns activity row when found", async () => {
      const { repo } = makeRepositoryWithSensorStore([
        {
          id: "abc-123",
          canonical_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T10:45:00.000Z",
          name: "Easy Run",
          notes: "Felt good",
          perceived_exertion: 7,
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
      expect(result?.canonical_type).toBe("running");
      expect(result?.name).toBe("Easy Run");
      expect(result?.subsource).toBe("Strong");
      expect(result?.perceived_exertion).toBe(7);
    });

    it("keeps member activity aliases internal", async () => {
      const { repo } = makeRepositoryWithSensorStore([
        {
          id: "canonical-id",
          canonical_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T10:45:00.000Z",
          name: "Easy Run",
          notes: null,
          perceived_exertion: null,
          provider_id: "garmin",
          subsource: "Garmin Connect",
          source_providers: ["garmin", "strava"],
          source_external_ids: [{ providerId: "garmin", externalId: "ext-1" }],
          member_activity_ids: ["canonical-id", "provider-id"],
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
      ]);

      const result = await repo.findById("provider-id");

      expect(result).not.toHaveProperty("member_activity_ids");
    });

    it("calls execute once when the canonical view has a match", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([
        {
          id: "some-id",
          canonical_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T10:45:00.000Z",
          name: "Morning Run",
          notes: "",
          perceived_exertion: null,
          provider_id: "garmin",
          subsource: "Garmin Connect",
          source_providers: ["garmin"],
          source_external_ids: [{ providerId: "garmin", externalId: "activity-1" }],
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
          provider_absent_at: null,
        },
      ]);
      await repo.findById("some-id");
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("looks up activities through the deduped member ids without recomputing the alias view", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.findById("member-id");
      const sqlObject = execute.mock.calls[0]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity a");
      expect(compiledQuery.sql).toContain("= ANY(a.member_activity_ids)");
      expect(compiledQuery.sql).not.toContain("JOIN fitness.v_activity_members am");
      expect(compiledQuery.params).toEqual(expect.arrayContaining(["member-id"]));
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

    it("resolves stream windows through the deduped member ids without recomputing the alias view", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.getStream("member-id", 500);
      const sqlObject = execute.mock.calls[0]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity a");
      expect(compiledQuery.sql).toContain("= ANY(a.member_activity_ids)");
      expect(compiledQuery.sql).not.toContain("JOIN fitness.v_activity_members am");
      expect(compiledQuery.params).toEqual(expect.arrayContaining(["member-id"]));
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
      execute.mockResolvedValueOnce([
        {
          id: "activity-id",
          user_id: "user-1",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          member_activity_ids: ["activity-id"],
        },
      ]);
      sensorStore.getHeartRateZoneSeconds.mockResolvedValueOnce([
        { zone: 0, seconds: 30 },
        { zone: 1, seconds: 120 },
        { zone: 2, seconds: 300 },
        { zone: 3, seconds: 600 },
        { zone: 4, seconds: 400 },
        { zone: 5, seconds: 80 },
      ]);
      const result = await repo.getHrZones("activity-id");
      expect(result).toHaveLength(6);
      expect(result[0]?.zone).toBe(0);
      expect(result[0]?.seconds).toBe(30);
      expect(result[1]?.zone).toBe(1);
      expect(result[1]?.seconds).toBe(120);
    });

    it("fails when no sensor store is configured", async () => {
      const { repo } = makeRepository([]);
      await expect(repo.getHrZones("activity-id")).rejects.toThrow(
        "ClickHouse activity analytics store is required for heart-rate zones",
      );
    });

    it("delegates to the configured sensor store after resolving the activity window", async () => {
      const { repo, execute, sensorStore } = makeRepositoryWithSensorStore([]);
      execute.mockResolvedValueOnce([
        {
          id: "activity-id",
          user_id: "user-1",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          member_activity_ids: ["activity-id"],
        },
      ]);

      await repo.getHrZones("activity-id");

      expect(sensorStore.getHeartRateZoneSeconds).toHaveBeenCalledWith({
        activityId: "activity-id",
        userId: "user-1",
        startedAt: "2024-01-15T10:00:00.000Z",
        endedAt: "2024-01-15T11:00:00.000Z",
        memberActivityIds: ["activity-id"],
      });
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
      const { repo, execute } = makeRepository([{ member_activity_id: "activity-id" }]);
      await repo.delete("activity-id");
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("deletes every member activity in the selected deduped activity group", async () => {
      const { repo, execute } = makeRepository([{ member_activity_id: "activity-id" }]);

      await repo.delete("activity-id");

      const sqlObject = execute.mock.calls[1]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("UPDATE fitness.activity");
      expect(compiledQuery.sql).toContain("SET deleted_at = NOW()");
      expect(compiledQuery.sql).toContain("member_rows.member_activity_id");
      expect(compiledQuery.sql).toContain("FROM fitness.v_activity a");
      expect(compiledQuery.sql).toContain("JOIN fitness.v_activity_members selected_member");
      expect(compiledQuery.sql).toContain("JOIN fitness.v_activity_members member_rows");
      expect(compiledQuery.sql).toContain("selected_member.member_activity_id IN");
      expect(compiledQuery.sql).toContain("id IN");
      expect(compiledQuery.params).toEqual(expect.arrayContaining(["activity-id", "user-1"]));
    });

    it("bulkDelete skips SQL when no activity ids are provided", async () => {
      const { repo, execute } = makeRepository([]);

      await expect(repo.bulkDelete([])).resolves.toEqual({
        deletedCount: 0,
        memberActivityIds: [],
      });

      expect(execute).not.toHaveBeenCalled();
    });

    it("bulkDelete deduplicates selected activity ids and deletes every member activity in matching deduped groups", async () => {
      const { repo, execute } = makeRepository([
        { member_activity_id: "activity-id" },
        { member_activity_id: "other-id" },
      ]);

      await expect(repo.bulkDelete(["activity-id", "activity-id", "other-id"])).resolves.toEqual({
        deletedCount: 2,
        memberActivityIds: ["activity-id", "other-id"],
      });

      const sqlObject = execute.mock.calls[1]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("UPDATE fitness.activity");
      expect(compiledQuery.sql).toContain("SET deleted_at = NOW()");
      expect(compiledQuery.sql).toContain("selected_member.member_activity_id IN");
      expect(compiledQuery.sql).toContain("member_rows.member_activity_id");
      expect(compiledQuery.params).toEqual(
        expect.arrayContaining(["activity-id", "other-id", "user-1"]),
      );
    });

    it("restoreProviderAbsent skips SQL when no activity ids are provided", async () => {
      const { repo, execute } = makeRepository([]);

      await expect(repo.restoreProviderAbsent([])).resolves.toEqual({ restoredCount: 0 });

      expect(execute).not.toHaveBeenCalled();
    });

    it("restoreProviderAbsent deduplicates activity ids and clears provider tombstones", async () => {
      const { repo, execute } = makeRepository([{ id: "activity-id" }, { id: "other-id" }]);

      await expect(
        repo.restoreProviderAbsent(["activity-id", "activity-id", "other-id"]),
      ).resolves.toEqual({ restoredCount: 2 });

      const sqlObject = execute.mock.calls[0]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("UPDATE fitness.activity");
      expect(compiledQuery.sql).toContain("provider_absent_at = NULL");
      expect(compiledQuery.sql).toContain("id IN");
      expect(compiledQuery.params).toEqual(
        expect.arrayContaining(["activity-id", "other-id", "user-1"]),
      );
    });
  });
});
