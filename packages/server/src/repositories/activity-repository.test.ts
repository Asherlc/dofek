import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ActivityRepository } from "./activity-repository.ts";
import { getActivityMapReadiness } from "./activity-route-preview.ts";
import { ActivitySensorRepository } from "./activity-sensor-repository.ts";

const loggerMocks = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock("../logger.ts", () => ({ logger: { info: loggerMocks.info } }));
vi.mock("./activity-route-preview.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./activity-route-preview.ts")>()),
  getActivityMapReadiness: vi.fn().mockResolvedValue(new Map()),
}));

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

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
    const repo = new ActivityRepository(database, "user-1", "UTC");
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
    const repo = new ActivityRepository(database, "user-1", "UTC", undefined, sensorStore);
    return { repo, execute, sensorStore };
  }

  it("requires the stream and zone store before resolving an activity window", async () => {
    const { repo } = makeRepository([]);
    const findWindow = vi.spyOn(repo, "findSensorWindow");
    await expect(repo.getStream("missing-id", 100)).rejects.toThrow(
      "ClickHouse activity analytics store is required for activity streams",
    );
    await expect(repo.getHrZones("missing-id")).rejects.toThrow(
      "ClickHouse activity analytics store is required for heart-rate zones",
    );
    await expect(repo.getPowerZones("missing-id", 250)).rejects.toThrow(
      "ClickHouse activity analytics store is required for power zones",
    );
    expect(findWindow).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND independently for an invisible activity stream", async () => {
    const { repo, sensorStore } = makeRepositoryWithSensorStore([]);
    await expect(repo.getStream("missing-id", 100)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Activity not found",
    });
    expect(sensorStore.getStream).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND independently for an invisible activity HR zone read", async () => {
    const { repo, sensorStore } = makeRepositoryWithSensorStore([]);
    await expect(repo.getHrZones("missing-id")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Activity not found",
    });
    expect(sensorStore.getHeartRateZoneSeconds).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND independently for an invisible activity power zone read", async () => {
    const { repo, sensorStore } = makeRepositoryWithSensorStore([]);
    await expect(repo.getPowerZones("missing-id", 250)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Activity not found",
    });
    expect(sensorStore.getPowerZoneSeconds).not.toHaveBeenCalled();
  });

  it("resolves hardware before failing for a missing metric-source store", async () => {
    const { repo } = makeRepository([]);
    const window = {
      activityId: "activity-id",
      userId: "user-1",
      startedAt: "2026-10-20T12:00:00.000Z",
      endedAt: "2026-10-20T13:00:00.000Z",
      providerType: null,
      memberActivityIds: ["activity-id"],
    };
    vi.spyOn(repo, "findSensorWindow").mockResolvedValue(window);
    const hardware = vi
      .spyOn(ActivitySensorRepository.prototype, "getHardware")
      .mockResolvedValue({ items: [], power: [] });
    await expect(repo.getMetricSources("activity-id")).rejects.toThrow(
      "ClickHouse activity analytics store is required for metric sources",
    );
    expect(hardware).toHaveBeenCalledExactlyOnceWith(window);
    hardware.mockRestore();
  });

  describe("findById", () => {
    it("returns null when not found", async () => {
      const { repo } = makeRepositoryWithSensorStore([]);
      const result = await repo.findById("nonexistent-id");
      expect(result).toBeNull();
    });

    it.each(["processing", "awaiting_summary", "unavailable"] as const)(
      "falls back to provider-absent activities with map readiness %s",
      async (status) => {
        const execute = vi
          .fn()
          .mockResolvedValueOnce([
            {
              requested_id: "tombstoned-id",
              resolved_group_id: "tombstoned-id",
              resolution_kind: "group",
            },
          ])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: "tombstoned-id",
              primary_activity_id: null,
              primary_canonical_type: null,
              primary_provider_id: null,
              primary_source_name: null,
              origin_candidate_member_ids: [],
              canonical_type: "running",
              raw_type: "running",
              started_at: "2024-01-15T10:00:00.000Z",
              displayed_date: "2024-01-15",
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
              origin_evidence: [],
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
              fit_recovery_error: false,
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
        vi.mocked(getActivityMapReadiness).mockResolvedValueOnce(
          new Map([["tombstoned-id", status]]),
        );

        const result = await repo.findById("tombstoned-id");

        expect(result).toMatchObject({
          id: "tombstoned-id",
          provider_id: "strava",
          provider_absent_at: "2024-01-16T08:00:00.000Z",
          location: status === "processing" ? { kind: "processing" } : null,
        });
        expect(sensorStore.getActivitySummaries).toHaveBeenCalledExactlyOnceWith(["tombstoned-id"]);
        const fallbackQuery = dialect.sqlToQuery(execute.mock.calls[2]?.[0]);
        expect(fallbackQuery.sql).toContain("provider_absent_at IS NOT NULL");
        expect(fallbackQuery.sql).toContain("a.deleted_at IS NULL");
        expect(fallbackQuery.sql).toContain("LEFT JOIN fitness.provider_priority");
        expect(fallbackQuery.sql).toContain("LEFT JOIN LATERAL");
        expect(fallbackQuery.sql).toContain("s.set_type = 'working'");
        expect(fallbackQuery.sql).toContain("s.weight_kg IS NOT NULL");
        expect(fallbackQuery.sql).toContain("COUNT(*) AS set_count");
        expect(fallbackQuery.sql).toContain("COUNT(DISTINCT s.exercise_id) AS exercise_count");
        expect(fallbackQuery.sql).toContain("a.canonical_type NOT IN");
        expect(fallbackQuery.sql).toContain("NULLIF(LOWER(TRIM(a.provider_type)), '')");
        expect(fallbackQuery.sql).toContain("COALESCE(dp.priority, pp.priority, 100)");
        expect(fallbackQuery.sql).toContain("a.id ASC");
        expect(fallbackQuery.sql).not.toContain("ORDER BY (a.id =");
        const fallbackOrder = fallbackQuery.sql.slice(fallbackQuery.sql.indexOf("ORDER BY"));
        expect(fallbackOrder.indexOf("payload.complete_working_set_count DESC")).toBeLessThan(
          fallbackOrder.indexOf("payload.set_count DESC"),
        );
        expect(fallbackOrder.indexOf("payload.set_count DESC")).toBeLessThan(
          fallbackOrder.indexOf("payload.exercise_count DESC"),
        );
        expect(fallbackOrder.indexOf("payload.exercise_count DESC")).toBeLessThan(
          fallbackOrder.indexOf("a.canonical_type NOT IN"),
        );
      },
    );

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
          origin_evidence: [],
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
      const { repo, sensorStore } = makeRepositoryWithSensorStore([
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
          origin_evidence: [],
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
      expect(sensorStore.getActivitySummaries).toHaveBeenCalledExactlyOnceWith(["abc-123"], {
        includeRunningForm: true,
      });
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
          origin_evidence: [],
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

    it("resolves identity once before loading a canonical view match", async () => {
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
          origin_evidence: [],
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
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("resolves direct groups, members, and merge aliases in one user-scoped query", async () => {
      const { repo, execute } = makeRepositoryWithSensorStore([]);
      await repo.findById("member-id");
      const sqlObject = execute.mock.calls[0]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("identity_candidates");
      expect(compiledQuery.sql).toContain("FROM fitness.activity_group");
      expect(compiledQuery.sql).toContain("FROM fitness.activity");
      expect(compiledQuery.sql).toContain("FROM fitness.activity_group_alias");
      expect(compiledQuery.sql).toContain("resolution_kind");
      expect(compiledQuery.sql).not.toContain("ANY(a.member_activity_ids)");
      expect(compiledQuery.params).toEqual(expect.arrayContaining(["member-id"]));
    });

    it("reuses one resolution when downstream hydration receives the stable group id", async () => {
      loggerMocks.info.mockClear();
      const { repo, execute } = makeRepositoryWithSensorStore([
        {
          id: "stable-group-id",
          canonical_type: "running",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          name: "Easy Run",
          notes: null,
          perceived_exertion: null,
          provider_id: "garmin",
          subsource: null,
          source_providers: ["garmin"],
          origin_evidence: [],
          source_external_ids: [],
          member_activity_ids: ["member-id"],
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
          user_id: "user-1",
        },
      ]);

      const activity = await repo.findById("member-id");
      const canonicalActivity = await repo.findById(activity?.id ?? "missing");

      const resolutionQueryCount = execute.mock.calls.filter(([query]) =>
        dialect.sqlToQuery(query).sql.includes("identity_candidates"),
      ).length;
      expect(resolutionQueryCount).toBe(1);
      expect(activity).toMatchObject({
        id: "stable-group-id",
        resolved_from: "member-id",
      });
      expect(canonicalActivity).not.toHaveProperty("resolved_from");
      const canonicalLookup = dialect.sqlToQuery(execute.mock.calls[2]?.[0]);
      expect(canonicalLookup.params).toContain("stable-group-id");
      expect(loggerMocks.info).toHaveBeenCalledWith("activity.id_resolved", {
        requestedActivityId: "member-id",
        resolvedGroupId: "stable-group-id",
        resolutionKind: "member",
      });
    });
  });

  describe("findSensorWindow", () => {
    it("returns the canonical window for a visible member id", async () => {
      const { repo, execute } = makeRepository([
        {
          id: "canonical-id",
          user_id: "user-1",
          started_at: "2024-01-15T10:00:00.000Z",
          ended_at: "2024-01-15T11:00:00.000Z",
          provider_type: null,
          member_activity_ids: ["canonical-id", "member-id"],
        },
      ]);

      await expect(repo.findSensorWindow("member-id")).resolves.toEqual({
        activityId: "canonical-id",
        userId: "user-1",
        startedAt: "2024-01-15T10:00:00.000Z",
        endedAt: "2024-01-15T11:00:00.000Z",
        providerType: null,
        memberActivityIds: ["canonical-id", "member-id"],
      });
      const resolutionQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(resolutionQuery.sql).toContain("identity_candidates");
      expect(resolutionQuery.params).toEqual(expect.arrayContaining(["member-id", "user-1"]));
      const windowQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
      expect(windowQuery.sql).toContain("WHERE a.id =");
      expect(windowQuery.params).toEqual(expect.arrayContaining(["canonical-id", "user-1"]));
    });
  });

  describe("sensor repository delegation", () => {
    const row = {
      id: "canonical-id",
      user_id: "user-1",
      started_at: "2024-01-15T10:00:00.000Z",
      ended_at: "2024-01-15T11:00:00.000Z",
      provider_type: null,
      member_activity_ids: ["member-id"],
      primary_activity_id: null,
      primary_provider_id: null,
      primary_source_name: null,
      origin_candidate_member_ids: [],
      origin_evidence: [],
      source_external_ids: [],
      absent_source_external_ids: [],
    };
    const window = {
      activityId: row.id,
      userId: row.user_id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      providerType: null,
      memberActivityIds: row.member_activity_ids,
    };

    it("forwards nonempty stream selection with the resolved activity window", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([row]);
      const sources = { heartRate: "whoop", power: "garmin" };

      await repo.getStream("member-id", 100, sources);

      expect(sensorStore.getStream).toHaveBeenCalledExactlyOnceWith(window, 100, sources);
    });

    it("preserves the two-argument stream call for an empty selection", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([row]);

      await repo.getStream("member-id", 100, {});

      expect(sensorStore.getStream).toHaveBeenCalledExactlyOnceWith(window, 100);
    });

    it("resolves hardware before forwarding metric-source version and window", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([row]);
      const hardwareResult = { items: [], power: [] };
      const hardware = vi
        .spyOn(ActivitySensorRepository.prototype, "getHardware")
        .mockResolvedValue(hardwareResult);
      const metricSources = vi
        .spyOn(ActivitySensorRepository.prototype, "getMetricSources")
        .mockResolvedValue([]);

      await repo.getMetricSources("member-id", 2);

      expect(hardware).toHaveBeenCalledExactlyOnceWith(window);
      expect(metricSources).toHaveBeenCalledExactlyOnceWith(sensorStore, window, hardwareResult, 2);
      metricSources.mockRestore();
      hardware.mockRestore();
    });

    it("rejects a missing metric-source window before sensor-source reads", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([]);

      await expect(repo.getMetricSources("missing-id")).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "Activity not found",
      });

      expect(sensorStore.query).not.toHaveBeenCalled();
    });

    it("forwards hardware reads with the resolved activity window", async () => {
      const { repo } = makeRepositoryWithSensorStore([row]);
      const hardware = vi
        .spyOn(ActivitySensorRepository.prototype, "getHardware")
        .mockResolvedValue({ items: [], power: [] });

      await repo.getHardware("member-id");

      expect(hardware).toHaveBeenCalledExactlyOnceWith(window);
      hardware.mockRestore();
    });

    it("forwards selected HR source IDs with the resolved window", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([row]);
      const getZones = vi
        .spyOn(ActivitySensorRepository.prototype, "getHrZones")
        .mockResolvedValue([]);

      await repo.getHrZones("member-id", "whoop");

      expect(getZones).toHaveBeenCalledExactlyOnceWith(sensorStore, window, "whoop");
      getZones.mockRestore();
    });

    it("forwards power FTP and source ID with the resolved window", async () => {
      const { repo, sensorStore } = makeRepositoryWithSensorStore([row]);
      const getZones = vi
        .spyOn(ActivitySensorRepository.prototype, "getPowerZones")
        .mockResolvedValue([]);

      await repo.getPowerZones("member-id", 275, "garmin");

      expect(getZones).toHaveBeenCalledExactlyOnceWith(sensorStore, window, 275, "garmin");
      getZones.mockRestore();
    });
  });
  describe("delete", () => {
    it("calls execute", async () => {
      const { repo, execute } = makeRepository([{ member_activity_id: "activity-id" }]);
      await repo.delete("activity-id");
      expect(execute).toHaveBeenCalledTimes(4);
    });

    it("deletes every raw member returned for a selected activity group", async () => {
      const { repo, execute } = makeRepository([{ member_activity_id: "activity-id" }]);

      await repo.delete("activity-id");

      const selectQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
      expect(selectQuery.sql).toContain("FROM fitness.v_activity a");
      expect(selectQuery.sql).toContain("CROSS JOIN LATERAL UNNEST(a.member_activity_ids)");
      expect(selectQuery.sql).toContain("a.id IN");
      expect(selectQuery.sql).toContain("a.member_activity_ids && ARRAY[");
      expect(selectQuery.sql).toContain("FROM fitness.activity_group_alias selected_alias");
      expect(selectQuery.params.filter((parameter) => parameter === "activity-id")).toHaveLength(3);

      const sqlObject = execute.mock.calls[2]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("UPDATE fitness.activity");
      expect(compiledQuery.sql).toContain("SET deleted_at = NOW()");
      expect(compiledQuery.sql).not.toContain("fitness.v_activity");
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

    it("skips the source update when selected activities resolve to no members", async () => {
      const { repo, execute } = makeRepository([]);

      await expect(repo.bulkDelete(["unresolved-id"])).resolves.toEqual({
        deletedCount: 1,
        memberActivityIds: [],
      });

      expect(execute).toHaveBeenCalledTimes(1);
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

      const sqlObject = execute.mock.calls[2]?.[0];
      const compiledQuery = dialect.sqlToQuery(sqlObject);
      expect(compiledQuery.sql).toContain("UPDATE fitness.activity");
      expect(compiledQuery.sql).toContain("SET deleted_at = NOW()");
      expect(compiledQuery.sql).not.toContain("fitness.v_activity");
      expect(
        dialect
          .sqlToQuery(execute.mock.calls[0]?.[0])
          .params.filter((parameter) => parameter === "activity-id"),
      ).toHaveLength(3);
      expect(
        dialect
          .sqlToQuery(execute.mock.calls[0]?.[0])
          .params.filter((parameter) => parameter === "other-id"),
      ).toHaveLength(3);
      expect(compiledQuery.params).toEqual(
        expect.arrayContaining(["activity-id", "other-id", "user-1"]),
      );
    });

    it("mergeActivities retains the earliest group and aliases every retired group", async () => {
      const laterId = "00000000-0000-4000-8000-000000000001";
      const earlierId = "00000000-0000-4000-8000-000000000002";
      const { repo, execute } = makeRepository([
        { id: laterId, canonical_type: "cycling", started_at: "2026-09-02T08:00:00Z" },
        { id: earlierId, canonical_type: "cycling", started_at: "2026-09-01T08:00:00Z" },
      ]);

      await expect(repo.mergeActivities([laterId, earlierId])).resolves.toEqual({
        groupId: earlierId,
        memberActivityIds: [laterId, earlierId],
        affectedGroupIds: [laterId, earlierId],
      });

      const calls = execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
      expect(
        calls.find((call) => call.sql.includes("SELECT id::text AS id, canonical_type"))?.params,
      ).toEqual(expect.arrayContaining([laterId, earlierId, "user-1"]));
      expect(
        calls.find((call) => call.sql.includes("FROM fitness.activity WHERE user_id"))?.params,
      ).toEqual(expect.arrayContaining([laterId, earlierId, "user-1"]));
      expect(
        calls.find((call) => call.sql.includes("UPDATE fitness.activity SET group_id"))?.params,
      ).toEqual(expect.arrayContaining([earlierId, laterId, "user-1"]));
      expect(
        calls.find((call) => call.sql.includes("UPDATE fitness.activity_group SET manual_merge"))
          ?.params,
      ).toEqual(expect.arrayContaining([earlierId, "user-1"]));
      expect(
        calls.filter((call) =>
          call.sql.includes("UPDATE fitness.activity_group_alias SET group_id"),
        ),
      ).toHaveLength(1);
      expect(
        calls.find((call) => call.sql.includes("UPDATE fitness.activity_group_alias SET group_id"))
          ?.params,
      ).toEqual([earlierId, "user-1", laterId]);
      const aliasInserts = calls.filter((call) =>
        call.sql.includes("INSERT INTO fitness.activity_group_alias (alias_id"),
      );
      expect(aliasInserts).toHaveLength(1);
      expect(aliasInserts[0]?.params).toEqual([laterId, earlierId, "user-1"]);
    });

    it("mergeActivities rejects selections containing hidden activities before writing", async () => {
      const onlyVisibleId = "00000000-0000-4000-8000-000000000001";
      const hiddenId = "00000000-0000-4000-8000-000000000002";
      const { repo, execute } = makeRepository([
        { id: onlyVisibleId, canonical_type: "cycling", started_at: "2026-09-01T08:00:00Z" },
      ]);

      await expect(repo.mergeActivities([onlyVisibleId, hiddenId])).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: expect.stringContaining("no longer visible"),
      });
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("mergeActivities rejects selections with different canonical types before writing", async () => {
      const firstId = "00000000-0000-4000-8000-000000000001";
      const secondId = "00000000-0000-4000-8000-000000000002";
      const { repo, execute } = makeRepository([
        { id: firstId, canonical_type: "cycling", started_at: "2026-09-01T08:00:00Z" },
        { id: secondId, canonical_type: "running", started_at: "2026-09-02T08:00:00Z" },
      ]);

      await expect(repo.mergeActivities([firstId, secondId])).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "Selected activities must have the same type.",
      });
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("restoreProviderAbsent skips SQL when no activity ids are provided", async () => {
      const { repo, execute } = makeRepository([]);

      await expect(repo.restoreProviderAbsent([])).resolves.toEqual({
        restoredCount: 0,
        memberActivityIds: [],
      });

      expect(execute).not.toHaveBeenCalled();
    });

    it("restoreProviderAbsent deduplicates activity ids and clears provider tombstones", async () => {
      const { repo, execute } = makeRepository([{ id: "activity-id" }, { id: "other-id" }]);

      await expect(
        repo.restoreProviderAbsent(["activity-id", "activity-id", "other-id"]),
      ).resolves.toEqual({ restoredCount: 2, memberActivityIds: ["activity-id", "other-id"] });

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
