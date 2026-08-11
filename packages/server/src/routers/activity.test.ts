import { mapHrZones } from "@dofek/zones/zones";
import { TRPCError } from "@trpc/server";
import { queryCache } from "dofek/lib/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityRow } from "../models/activity.ts";
import { Activity } from "../models/activity.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { PowerRepository } from "../repositories/power-repository.ts";
import { StrengthRepository } from "../repositories/strength-repository.ts";
import { mapStreamPoint } from "./activity.ts";
import { createTestCallerFactory, makeTestCaller } from "./test-helpers.ts";

const { mockInvalidateUserQueryDomains } = vi.hoisted(() => ({
  mockInvalidateUserQueryDomains: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("dofek/lib/cache", () => ({
  invalidateUserQueryDomains: mockInvalidateUserQueryDomains,
  queryCache: {
    invalidateByPrefix: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockEnqueueActivityDeleteAnalyticsRefresh = vi.fn().mockResolvedValue(undefined);
const mockEnqueueActivityRestoreAnalyticsRefresh = vi.fn().mockResolvedValue(undefined);
const mockEnqueueActivityRecomputeAnalyticsRefresh = vi.fn().mockResolvedValue(undefined);
const mockWithUserWriteFence = vi.fn();

vi.mock("dofek/db/account-erasure", () => ({
  withAccountErasureUserWriteFence: (...args: unknown[]) => mockWithUserWriteFence(...args),
}));

vi.mock("dofek/jobs/queues", () => ({
  enqueueActivityDeleteAnalyticsRefresh: (...args: unknown[]) =>
    mockEnqueueActivityDeleteAnalyticsRefresh(...args),
  enqueueActivityRestoreAnalyticsRefresh: (...args: unknown[]) =>
    mockEnqueueActivityRestoreAnalyticsRefresh(...args),
  enqueueActivityRecomputeAnalyticsRefresh: (...args: unknown[]) =>
    mockEnqueueActivityRecomputeAnalyticsRefresh(...args),
}));

// Mock tRPC infrastructure
vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      sensorStore?: unknown;
      userId: string | null;
      timezone: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
    }>()
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

vi.mock("./sync-helpers.ts", () => ({
  ensureProvidersRegistered: vi.fn(async () => {}),
}));

vi.mock("dofek/db/dedup", async (importOriginal) => {
  const original = await importOriginal<typeof import("dofek/db/dedup")>();
  return { ...original };
});

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
          activityUrl: (externalId: string) =>
            `https://systm.wahoofitness.com/history/activity-details/${externalId}`,
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

beforeEach(() => {
  mockWithUserWriteFence.mockImplementation(
    async (
      database: unknown,
      _userId: string,
      operation: (transaction: unknown) => Promise<unknown>,
    ) => operation(database),
  );
});

import { activityRouter } from "./activity.ts";

const createCaller = createTestCallerFactory(activityRouter);

function makeCaller(
  rows: Record<string, unknown>[] = [],
  sensorStore: unknown = makeSensorStoreStub(),
) {
  return makeTestCaller(createCaller, [rows], (db) => ({
    db,
    sensorStore,
    userId: "user-1",
    timezone: "UTC",
  })).caller;
}

function makeCallerWithoutSensorStore(rows: Record<string, unknown>[] = []) {
  return makeTestCaller(createCaller, [rows], (db) => ({ db, userId: "user-1", timezone: "UTC" }))
    .caller;
}

function makeSensorStoreStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    query: vi.fn().mockResolvedValue([{ date: "2026-04-01", resting_hr: 55 }]),
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeActivityRow(overrides: Partial<ActivityRow>): ActivityRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    canonical_type: "cycling",
    started_at: "2026-04-01T10:00:00Z",
    ended_at: "2026-04-01T11:00:00Z",
    name: "Ride",
    notes: null,
    perceived_exertion: null,
    provider_id: "wahoo",
    source_providers: ["wahoo"],
    source_external_ids: null,
    avg_hr: null,
    max_hr: null,
    avg_power: 220,
    max_power: 340,
    avg_speed: null,
    max_speed: null,
    avg_cadence: null,
    total_distance: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
    sample_count: null,
    ...overrides,
  };
}

describe("activityRouter", () => {
  describe("hangboardDetails", () => {
    it("returns the Hangboarding detail contract", async () => {
      const caller = makeCaller([
        {
          activity_id: "activity-1",
          canonical_type: "hangboard",
          plan_name: "7/3 Repeaters",
          session_id: "session-1",
          board_id: "board-1",
          board_name: "Tension Board",
          segments_error: null,
          interval_id: "interval-1",
          interval_index: 0,
          label: "Step 1: 19 mm edge",
          interval_type: "work",
          interval_started_at: "2026-08-07T14:00:00.000Z",
          interval_ended_at: "2026-08-07T14:00:07.000Z",
          duration_seconds: 7,
        },
      ]);

      await expect(
        caller.hangboardDetails({ id: "734b5d3e-df2b-4ee0-888e-55ea539d913a" }),
      ).resolves.toEqual({
        planName: "7/3 Repeaters",
        sessionId: "session-1",
        boardId: "board-1",
        boardName: "Tension Board",
        segmentsError: null,
        intervals: [
          {
            id: "interval-1",
            intervalIndex: 0,
            label: "Step 1: 19 mm edge",
            intervalType: "work",
            startedAt: "2026-08-07T14:00:00.000Z",
            endedAt: "2026-08-07T14:00:07.000Z",
            durationSeconds: 7,
          },
        ],
      });
    });

    it("returns an actionable not-found error for a non-Hangboarding activity", async () => {
      const caller = makeCaller([]);

      await expect(
        caller.hangboardDetails({ id: "734b5d3e-df2b-4ee0-888e-55ea539d913a" }),
      ).rejects.toMatchObject<Partial<TRPCError>>({
        code: "NOT_FOUND",
        message: "Hangboarding details not found",
      });
    });
  });

  describe("list", () => {
    it("returns paginated items with totalCount", async () => {
      const rows = [
        {
          id: "a1",
          started_at: "2024-01-01 10:00:00+00",
          ended_at: "2024-01-01 11:00:00+00",
          canonical_type: "cycling",
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
        canonical_type: "cycling",
        avg_hr: 150,
        max_hr: 180,
        avg_power: 200,
        distance_meters: 30000,
      });
    });

    it("returns stats from the activity summary read model", async () => {
      const rows = [
        {
          id: "a1",
          started_at: "2024-01-15 14:30:00+00",
          ended_at: "2024-01-15 15:15:00+00",
          canonical_type: "running",
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
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.list({ days: 30 });
      expect(result).toEqual({ items: [], totalCount: 0 });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("returns empty when the activity read model has no data", async () => {
      const execute = vi.fn().mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.list({ days: 30 });
      expect(result).toEqual({ items: [], totalCount: 0 });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("skips stale view check on non-first pages", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.list({ days: 30, limit: 20, offset: 20 });
      expect(result).toEqual({ items: [], totalCount: 0 });
      // Only the list query — no base table check on offset > 0
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("throws PRECONDITION_FAILED when activity view is missing", async () => {
      const missingViewError = Object.assign(
        new Error('relation "fitness.v_activity" does not exist'),
        { code: "42P01" },
      );
      const execute = vi.fn().mockRejectedValue(missingViewError);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
      });
      await expect(caller.list({ days: 30 })).rejects.toThrow(TRPCError);
      await expect(caller.list({ days: 30 })).rejects.toThrow(
        "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
      );
    });

    it("re-throws non-relation errors from list", async () => {
      const execute = vi.fn().mockRejectedValue(new Error("connection refused"));
      const caller = createCaller({
        db: { execute },
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
      });
      await expect(caller.list({ days: 30 })).rejects.toThrow("connection refused");
    });

    it("uses default limit of 20 and offset of 0", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
      });
      await caller.list({ days: 30 });
      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("byId", () => {
    it("returns mapped activity detail with source links", async () => {
      const row = {
        id: "abc-123",
        canonical_type: "cycling",
        started_at: "2024-01-01T10:00:00Z",
        ended_at: "2024-01-01T11:00:00Z",
        name: "Morning Ride",
        notes: null,
        provider_id: "wahoo",
        subsource: null,
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
      expect(result.subsource).toBeNull();
      expect(result.sourceLinks).toEqual([
        {
          providerId: "strava",
          externalId: "99999",
          subsource: null,
          label: "Strava",
          url: "https://www.strava.com/activities/99999",
          providerAbsentAt: null,
        },
        {
          providerId: "wahoo",
          externalId: "42",
          subsource: null,
          label: "Wahoo",
          url: "https://systm.wahoofitness.com/history/activity-details/42",
          providerAbsentAt: null,
        },
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
        canonical_type: "running",
        started_at: "2024-01-01",
        ended_at: null,
        name: null,
        notes: null,
        provider_id: "manual",
        subsource: null,
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
    it("throws PRECONDITION_FAILED when analytics store is not configured", async () => {
      const caller = makeCallerWithoutSensorStore();

      await expect(caller.stream({ id: "00000000-0000-0000-0000-000000000001" })).rejects.toThrow(
        "ClickHouse activity analytics store is required for activity streams",
      );
    });

    it("uses the configured sensor store for stream points", async () => {
      const postgresExecute = vi.fn().mockResolvedValue([]);
      const sensorStore = {
        query: vi.fn().mockResolvedValue([{ date: "2024-01-01", resting_hr: 55 }]),
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([
          {
            recorded_at: "2024-01-01T10:00:00Z",
            heart_rate: 150,
            power: null,
            speed: null,
            cadence: null,
            altitude: null,
            lat: null,
            lng: null,
          },
        ]),
        getHeartRateZoneSeconds: vi.fn(),
        getPowerZoneSeconds: vi.fn(),
      };
      const caller = createCaller({
        db: {
          execute: postgresExecute.mockResolvedValueOnce([
            {
              id: "00000000-0000-0000-0000-000000000001",
              user_id: "user-1",
              started_at: "2024-01-01T10:00:00Z",
              ended_at: "2024-01-01T11:00:00Z",
              member_activity_ids: ["00000000-0000-0000-0000-000000000001"],
            },
          ]),
        },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.stream({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toHaveLength(1);
      expect(postgresExecute).toHaveBeenCalledTimes(1);
      expect(sensorStore.getStream).toHaveBeenCalledTimes(1);
    });

    it("returns mapped stream points", async () => {
      const sensorStore = {
        query: vi.fn().mockResolvedValue([{ date: "2024-01-01", resting_hr: 55 }]),
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([
          {
            recorded_at: "2024-01-01T10:00:00Z",
            heart_rate: 150,
            power: 200,
            speed: 8.5,
            cadence: 85,
            altitude: 100,
            lat: 40.7128,
            lng: -74.006,
          },
        ]),
        getHeartRateZoneSeconds: vi.fn(),
        getPowerZoneSeconds: vi.fn(),
      };
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              id: "00000000-0000-0000-0000-000000000001",
              user_id: "user-1",
              started_at: "2024-01-01T10:00:00Z",
              ended_at: "2024-01-01T11:00:00Z",
              member_activity_ids: ["00000000-0000-0000-0000-000000000001"],
            },
          ]),
        },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.stream({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toHaveLength(1);
      expect(result[0]?.recordedAt).toBe("2024-01-01T10:00:00.000Z");
      expect(result[0]?.heartRate).toBe(150);
      expect(result[0]?.power).toBe(200);
    });

    it("handles null values in stream points", async () => {
      const sensorStore = {
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([
          {
            recorded_at: "2024-01-01T10:00:00Z",
            heart_rate: null,
            power: null,
            speed: null,
            cadence: null,
            altitude: null,
            lat: null,
            lng: null,
          },
        ]),
        getHeartRateZoneSeconds: vi.fn(),
        getPowerZoneSeconds: vi.fn(),
      };
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              id: "00000000-0000-0000-0000-000000000001",
              user_id: "user-1",
              started_at: "2024-01-01T10:00:00Z",
              ended_at: "2024-01-01T11:00:00Z",
              member_activity_ids: ["00000000-0000-0000-0000-000000000001"],
            },
          ]),
        },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.stream({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result[0]?.heartRate).toBeNull();
      expect(result[0]?.power).toBeNull();
    });
  });

  describe("delete", () => {
    beforeEach(() => {
      mockEnqueueActivityDeleteAnalyticsRefresh.mockClear();
    });

    it("calls DELETE with correct activity id and user_id", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ member_activity_id: "00000000-0000-0000-0000-000000000001" }])
        .mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual({ success: true });
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("invalidates activity and calendar caches after delete", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ member_activity_id: "00000000-0000-0000-0000-000000000001" }])
        .mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:activity.");
      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:calendar.");
    });

    it("enqueues an activity analytics refresh after delete", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          { member_activity_id: "00000000-0000-0000-0000-000000000001" },
          { member_activity_id: "00000000-0000-0000-0000-000000000002" },
        ])
        .mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.delete({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(mockEnqueueActivityDeleteAnalyticsRefresh).toHaveBeenCalledWith("user-1", [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
      ]);
    });

    it("reports analytics enqueue failures to Sentry without failing delete", async () => {
      const Sentry = await import("@sentry/node");
      vi.mocked(Sentry.captureException).mockClear();
      const enqueueError = new Error("redis unavailable");
      mockEnqueueActivityDeleteAnalyticsRefresh.mockRejectedValueOnce(enqueueError);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([{ member_activity_id: "00000000-0000-0000-0000-000000000001" }])
        .mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.delete({
          id: "00000000-0000-0000-0000-000000000001",
        }),
      ).resolves.toEqual({ success: true });

      expect(Sentry.captureException).toHaveBeenCalledWith(enqueueError, {
        tags: { phase: "activity-delete-analytics-enqueue" },
        extra: { userId: "user-1", activityCount: 1 },
      });
    });

    it("throws PRECONDITION_FAILED when activity views are missing", async () => {
      const execute = vi.fn().mockRejectedValue(
        Object.assign(new Error('relation "fitness.v_activity" does not exist'), {
          code: "42P01",
        }),
      );
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.delete({
          id: "00000000-0000-0000-0000-000000000001",
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
      });
    });

    it("bulkDelete returns the deduplicated selected count", async () => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          { member_activity_id: "00000000-0000-0000-0000-000000000001" },
          { member_activity_id: "00000000-0000-0000-0000-000000000002" },
        ])
        .mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.bulkDelete({
        ids: [
          "00000000-0000-0000-0000-000000000001",
          "00000000-0000-0000-0000-000000000001",
          "00000000-0000-0000-0000-000000000002",
        ],
      });

      expect(result).toEqual({ success: true, deletedCount: 2 });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(mockEnqueueActivityDeleteAnalyticsRefresh).toHaveBeenCalledWith("user-1", [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
      ]);
    });

    it("invalidates activity and calendar caches after bulkDelete", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.bulkDelete({
        ids: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
      });

      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:activity.");
      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:calendar.");
    });

    it("reports analytics enqueue failures to Sentry without failing bulkDelete", async () => {
      const Sentry = await import("@sentry/node");
      vi.mocked(Sentry.captureException).mockClear();
      const enqueueError = new Error("queue unavailable");
      mockEnqueueActivityDeleteAnalyticsRefresh.mockRejectedValueOnce(enqueueError);
      const execute = vi
        .fn()
        .mockResolvedValueOnce([
          { member_activity_id: "00000000-0000-0000-0000-000000000001" },
          { member_activity_id: "00000000-0000-0000-0000-000000000002" },
        ])
        .mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.bulkDelete({
          ids: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
        }),
      ).resolves.toEqual({ success: true, deletedCount: 2 });

      expect(Sentry.captureException).toHaveBeenCalledWith(enqueueError, {
        tags: { phase: "activity-delete-analytics-enqueue" },
        extra: { userId: "user-1", activityCount: 2 },
      });
    });

    it("bulkDelete rejects oversized selections before querying the database", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.bulkDelete({
          ids: Array.from(
            { length: 501 },
            (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
          ),
        }),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    });

    it("bulkDelete throws PRECONDITION_FAILED when activity views are missing", async () => {
      const execute = vi.fn().mockRejectedValue(
        Object.assign(new Error('relation "fitness.v_activity" does not exist'), {
          code: "42P01",
        }),
      );
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.bulkDelete({
          ids: ["00000000-0000-0000-0000-000000000001"],
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
      });
    });
  });

  describe("recompute", () => {
    beforeEach(() => {
      mockEnqueueActivityRecomputeAnalyticsRefresh.mockClear();
    });

    it("enqueues recompute for all grouped member activities and invalidates caches", async () => {
      const execute = vi.fn().mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000001",
          user_id: "user-1",
          started_at: "2026-04-01T10:00:00Z",
          ended_at: "2026-04-01T11:00:00Z",
          member_activity_ids: [
            "00000000-0000-0000-0000-000000000001",
            "00000000-0000-0000-0000-000000000002",
          ],
        },
      ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.recompute({ id: "00000000-0000-0000-0000-000000000001" }),
      ).resolves.toEqual({ success: true });

      expect(mockEnqueueActivityRecomputeAnalyticsRefresh).toHaveBeenCalledWith("user-1", [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
      ]);
      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:activity.");
      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:calendar.");
    });

    it("throws NOT_FOUND when recomputing a missing activity", async () => {
      const caller = makeCaller([]);

      await expect(
        caller.recompute({ id: "00000000-0000-0000-0000-000000000001" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Activity not found" });
    });

    it("throws PRECONDITION_FAILED when activity views are missing", async () => {
      const execute = vi.fn().mockRejectedValue(
        Object.assign(new Error('relation "fitness.v_activity" does not exist'), {
          code: "42P01",
        }),
      );
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.recompute({ id: "00000000-0000-0000-0000-000000000001" }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
      });
    });
  });

  describe("setPerceivedExertion", () => {
    it("writes session RPE through the repository and invalidates activity caches", async () => {
      const setPerceivedExertion = vi
        .spyOn(ActivityRepository.prototype, "setPerceivedExertion")
        .mockResolvedValue({ found: true, perceivedExertion: 7 });
      const caller = makeCaller();

      await expect(
        caller.setPerceivedExertion({
          id: "00000000-0000-0000-0000-000000000001",
          value: 7,
        }),
      ).resolves.toEqual({ perceivedExertion: 7 });

      expect(setPerceivedExertion).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000001", 7);
      expect(mockInvalidateUserQueryDomains).toHaveBeenCalledWith("user-1", ["activity"]);
      setPerceivedExertion.mockRestore();
    });

    it("rejects an RPE outside the 0-10 range", async () => {
      const caller = makeCaller();
      await expect(
        caller.setPerceivedExertion({
          id: "00000000-0000-0000-0000-000000000001",
          value: 11,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("clears a previously logged session RPE", async () => {
      const setPerceivedExertion = vi
        .spyOn(ActivityRepository.prototype, "setPerceivedExertion")
        .mockResolvedValue({ found: true, perceivedExertion: null });
      const caller = makeCaller();

      await expect(
        caller.setPerceivedExertion({
          id: "00000000-0000-0000-0000-000000000001",
          value: null,
        }),
      ).resolves.toEqual({ perceivedExertion: null });

      expect(setPerceivedExertion).toHaveBeenCalledWith(
        "00000000-0000-0000-0000-000000000001",
        null,
      );
      setPerceivedExertion.mockRestore();
    });

    it("throws NOT_FOUND when the activity is missing", async () => {
      mockInvalidateUserQueryDomains.mockClear();
      const setPerceivedExertion = vi
        .spyOn(ActivityRepository.prototype, "setPerceivedExertion")
        .mockResolvedValue({ found: false, perceivedExertion: null });
      const caller = makeCaller();

      await expect(
        caller.setPerceivedExertion({
          id: "00000000-0000-0000-0000-000000000001",
          value: 7,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Activity not found" });
      expect(mockInvalidateUserQueryDomains).not.toHaveBeenCalled();
      setPerceivedExertion.mockRestore();
    });
  });

  describe("restoreProviderAbsent", () => {
    it("restores hidden activities and returns the restored count", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue([
          { id: "00000000-0000-0000-0000-000000000001" },
          { id: "00000000-0000-0000-0000-000000000002" },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.restoreProviderAbsent({
          ids: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
        }),
      ).resolves.toEqual({ success: true, restoredCount: 2 });
    });

    it("invalidates activity and calendar caches after restore", async () => {
      const execute = vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.restoreProviderAbsent({
        ids: ["00000000-0000-0000-0000-000000000001"],
      });

      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:activity.");
      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:calendar.");
    });

    it("enqueues an activity restore analytics refresh after restore", async () => {
      const execute = vi
        .fn()
        .mockResolvedValue([
          { id: "00000000-0000-0000-0000-000000000001" },
          { id: "00000000-0000-0000-0000-000000000002" },
        ]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.restoreProviderAbsent({
        ids: ["00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"],
      });

      expect(mockEnqueueActivityRestoreAnalyticsRefresh).toHaveBeenCalledWith("user-1", [
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
      ]);
    });

    it("reports restore analytics enqueue failures to Sentry without failing restore", async () => {
      const Sentry = await import("@sentry/node");
      vi.mocked(Sentry.captureException).mockClear();
      const enqueueError = new Error("redis unavailable");
      mockEnqueueActivityRestoreAnalyticsRefresh.mockRejectedValueOnce(enqueueError);
      const execute = vi.fn().mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000001" }]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.restoreProviderAbsent({
          ids: ["00000000-0000-0000-0000-000000000001"],
        }),
      ).resolves.toEqual({ success: true, restoredCount: 1 });

      expect(Sentry.captureException).toHaveBeenCalledWith(enqueueError, {
        tags: { phase: "activity-restore-analytics-enqueue" },
        extra: { userId: "user-1", activityCount: 1 },
      });
    });

    it("throws PRECONDITION_FAILED when activity views are missing", async () => {
      const execute = vi.fn().mockRejectedValue(
        Object.assign(new Error('relation "fitness.v_activity" does not exist'), {
          code: "42P01",
        }),
      );
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.restoreProviderAbsent({
          ids: ["00000000-0000-0000-0000-000000000001"],
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
      });
    });

    it("re-throws non-relation errors from restore", async () => {
      const execute = vi.fn().mockRejectedValue(new Error("connection refused"));
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.restoreProviderAbsent({
          ids: ["00000000-0000-0000-0000-000000000001"],
        }),
      ).rejects.toThrow("connection refused");
    });
  });

  describe("strengthExercises", () => {
    it("uses the configured sensor store when resolving the activity", async () => {
      const getExercisesForActivitySpy = vi
        .spyOn(StrengthRepository.prototype, "getExercisesForActivity")
        .mockResolvedValue([]);
      const activityId = "00000000-0000-0000-0000-000000000001";

      const caller = makeCaller([
        makeActivityRow({
          id: activityId,
        }),
      ]);
      const result = await caller.strengthExercises({ id: activityId });

      expect(result).toEqual([]);
      expect(getExercisesForActivitySpy).toHaveBeenCalledWith(activityId);
      getExercisesForActivitySpy.mockRestore();
    });
  });

  describe("access window gating", () => {
    it("list passes accessWindow to repository (limited window returns empty)", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "free_signup_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      const result = await caller.list({ days: 30 });
      expect(result).toEqual({ items: [], totalCount: 0 });
    });

    it("byId returns NOT_FOUND when activity is outside limited access window", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "free_signup_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      await expect(caller.byId({ id: "00000000-0000-0000-0000-000000000001" })).rejects.toThrow(
        TRPCError,
      );
    });

    it("stream returns empty when activity is outside limited access window", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: makeSensorStoreStub(),
        userId: "user-1",
        timezone: "UTC",
        accessWindow: {
          kind: "limited",
          paid: false,
          reason: "free_signup_week",
          startDate: "2026-04-10",
          endDateExclusive: "2026-04-17",
        },
      });
      const result = await caller.stream({ id: "00000000-0000-0000-0000-000000000001" });
      expect(result).toEqual([]);
    });
  });

  describe("hrZones", () => {
    it("throws PRECONDITION_FAILED when analytics store is not configured", async () => {
      const caller = makeCallerWithoutSensorStore();

      await expect(caller.hrZones({ id: "00000000-0000-0000-0000-000000000001" })).rejects.toThrow(
        "ClickHouse activity analytics store is required for heart-rate zones",
      );
    });

    it("returns zone 0 plus 5 training zones with labels", async () => {
      const sensorStore = {
        query: vi.fn().mockResolvedValue([{ date: "2024-01-01", resting_hr: 55 }]),
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn(),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([
          { zone: 0, seconds: 300 },
          { zone: 1, seconds: 600 },
          { zone: 2, seconds: 1200 },
          { zone: 3, seconds: 900 },
          { zone: 4, seconds: 300 },
          { zone: 5, seconds: 60 },
        ]),
        getPowerZoneSeconds: vi.fn(),
      };
      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            .mockResolvedValueOnce([
              {
                id: "00000000-0000-0000-0000-000000000001",
                user_id: "user-1",
                started_at: "2024-01-01T10:00:00Z",
                ended_at: "2024-01-01T11:00:00Z",
                member_activity_ids: ["00000000-0000-0000-0000-000000000001"],
              },
            ])
            .mockResolvedValueOnce([{ max_hr: 190, resting_hr: 60 }]),
        },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.hrZones({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result).toHaveLength(6);
      expect(result[0]).toEqual({
        zone: 0,
        label: "Below Zone 1",
        minPct: 0,
        maxPct: 50,
        seconds: 300,
        percent: 8.9,
      });
      expect(result[1]).toEqual({
        zone: 1,
        label: "Recovery",
        minPct: 50,
        maxPct: 60,
        seconds: 600,
        percent: 17.9,
      });
      expect(result[5]).toMatchObject({ zone: 5, label: "VO2max" });
    });

    it("defaults missing zones to 0 seconds", async () => {
      const sensorStore = {
        query: vi.fn().mockResolvedValue([{ date: "2024-01-01", resting_hr: 55 }]),
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn(),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([{ zone: 2, seconds: 500 }]),
        getPowerZoneSeconds: vi.fn(),
      };
      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            .mockResolvedValueOnce([
              {
                id: "00000000-0000-0000-0000-000000000001",
                user_id: "user-1",
                started_at: "2024-01-01T10:00:00Z",
                ended_at: "2024-01-01T11:00:00Z",
                member_activity_ids: ["00000000-0000-0000-0000-000000000001"],
              },
            ])
            .mockResolvedValueOnce([{ max_hr: 190, resting_hr: 60 }]),
        },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.hrZones({
        id: "00000000-0000-0000-0000-000000000001",
      });

      expect(result[0]?.seconds).toBe(0);
      expect(result[1]?.seconds).toBe(0);
      expect(result[2]?.seconds).toBe(500);
      expect(result[3]?.seconds).toBe(0);
    });
  });

  describe("powerZones", () => {
    it("returns null for non-cycling activities even when analytics store is missing", async () => {
      const findByIdSpy = vi
        .spyOn(ActivityRepository.prototype, "findById")
        .mockResolvedValue(
          makeActivityRow({ canonical_type: "running", avg_power: null, max_power: null }),
        );
      const getEftpTrendSpy = vi.spyOn(PowerRepository.prototype, "getEftpTrend");
      const getPowerZonesSpy = vi.spyOn(ActivityRepository.prototype, "getPowerZones");

      const caller = makeCallerWithoutSensorStore();
      const result = await caller.powerZones({ id: "00000000-0000-0000-0000-000000000001" });

      expect(result).toBeNull();
      expect(getEftpTrendSpy).not.toHaveBeenCalled();
      expect(getPowerZonesSpy).not.toHaveBeenCalled();

      findByIdSpy.mockRestore();
      getEftpTrendSpy.mockRestore();
      getPowerZonesSpy.mockRestore();
    });

    it("returns null for cycling activities without power data even when analytics store is missing", async () => {
      const findByIdSpy = vi
        .spyOn(ActivityRepository.prototype, "findById")
        .mockResolvedValue(makeActivityRow({ avg_power: null, max_power: null }));
      const getEftpTrendSpy = vi.spyOn(PowerRepository.prototype, "getEftpTrend");
      const getPowerZonesSpy = vi.spyOn(ActivityRepository.prototype, "getPowerZones");

      const caller = makeCallerWithoutSensorStore();
      const result = await caller.powerZones({ id: "00000000-0000-0000-0000-000000000001" });

      expect(result).toBeNull();
      expect(getEftpTrendSpy).not.toHaveBeenCalled();
      expect(getPowerZonesSpy).not.toHaveBeenCalled();

      findByIdSpy.mockRestore();
      getEftpTrendSpy.mockRestore();
      getPowerZonesSpy.mockRestore();
    });

    it("throws PRECONDITION_FAILED for cycling activities when analytics store is missing", async () => {
      const findByIdSpy = vi
        .spyOn(ActivityRepository.prototype, "findById")
        .mockResolvedValue(
          makeActivityRow({ canonical_type: "cycling", avg_power: 210, max_power: 340 }),
        );
      const caller = makeCallerWithoutSensorStore();

      await expect(
        caller.powerZones({ id: "00000000-0000-0000-0000-000000000001" }),
      ).rejects.toThrow("ClickHouse activity analytics store is required for power analysis");

      findByIdSpy.mockRestore();
    });

    it("returns zones and ftp for cycling activities with power data", async () => {
      const zones = [
        { zone: 1, label: "Active Recovery", minPct: 0, maxPct: 55, seconds: 60, percent: 33.3 },
        { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 120, percent: 66.7 },
      ];
      const findByIdSpy = vi
        .spyOn(ActivityRepository.prototype, "findById")
        .mockResolvedValue(
          makeActivityRow({ canonical_type: "cycling", avg_power: 210, max_power: 360 }),
        );
      const getEftpTrendSpy = vi
        .spyOn(PowerRepository.prototype, "getEftpTrend")
        .mockResolvedValue({
          trend: [],
          currentEftp: 265,
          model: null,
        });
      const getPowerZonesSpy = vi
        .spyOn(ActivityRepository.prototype, "getPowerZones")
        .mockResolvedValue(zones);

      const caller = makeCaller([], {
        getPowerCurveSamples: vi.fn(),
        getNormalizedPowerSamples: vi.fn(),
      });
      const result = await caller.powerZones({ id: "00000000-0000-0000-0000-000000000001" });

      const [range] = getEftpTrendSpy.mock.calls[0] ?? [];
      expect(range?.days).toBe(90);
      expect(getPowerZonesSpy).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000001", 265);
      expect(result).toEqual({ zones, ftp: 265 });

      findByIdSpy.mockRestore();
      getEftpTrendSpy.mockRestore();
      getPowerZonesSpy.mockRestore();
    });

    it("throws NOT_FOUND when activity does not exist", async () => {
      const findByIdSpy = vi
        .spyOn(ActivityRepository.prototype, "findById")
        .mockResolvedValue(null);
      const caller = makeCallerWithoutSensorStore();

      await expect(
        caller.powerZones({ id: "00000000-0000-0000-0000-000000000001" }),
      ).rejects.toThrow("Activity not found");

      findByIdSpy.mockRestore();
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
          activityUrl: (externalId: string) =>
            `https://systm.wahoofitness.com/history/activity-details/${externalId}`,
        },
      };
    return providers[id];
  };

  const fullRow = {
    id: "abc-123",
    canonical_type: "cycling",
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
    expect(detail.sourceProviders).toEqual(["strava", "wahoo"]);
    expect(detail.sourceLinks).toHaveLength(2);
    expect(detail.sourceLinks[0]?.label).toBe("Strava");
    expect(detail.sourceDecision).toEqual({
      sourceCount: 2,
      primarySourceLabel: "Wahoo",
      explanation:
        "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
    });
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
  it("maps zone 0 plus all 5 training zones with correct labels and ranges", () => {
    const rows = [
      { zone: 0, seconds: 120 },
      { zone: 1, seconds: 120 },
      { zone: 2, seconds: 600 },
      { zone: 3, seconds: 900 },
      { zone: 4, seconds: 300 },
      { zone: 5, seconds: 60 },
    ];
    const result = mapHrZones(rows);
    expect(result).toEqual([
      { zone: 0, label: "Below Zone 1", minPct: 0, maxPct: 50, seconds: 120, percent: 5.7 },
      { zone: 1, label: "Recovery", minPct: 50, maxPct: 60, seconds: 120, percent: 5.7 },
      { zone: 2, label: "Aerobic", minPct: 60, maxPct: 70, seconds: 600, percent: 28.6 },
      { zone: 3, label: "Tempo", minPct: 70, maxPct: 80, seconds: 900, percent: 42.9 },
      { zone: 4, label: "Threshold", minPct: 80, maxPct: 90, seconds: 300, percent: 14.3 },
      { zone: 5, label: "VO2max", minPct: 90, maxPct: 100, seconds: 60, percent: 2.9 },
    ]);
  });

  it("defaults to 0 for missing zones", () => {
    const result = mapHrZones([{ zone: 3, seconds: 500 }]);
    expect(result[0]?.seconds).toBe(0);
    expect(result[1]?.seconds).toBe(0);
    expect(result[2]?.seconds).toBe(0);
    expect(result[3]?.seconds).toBe(500);
    expect(result[4]?.seconds).toBe(0);
    expect(result[5]?.seconds).toBe(0);
    expect(result.find((zone) => zone.zone === 3)?.seconds).toBe(500);
  });

  it("returns all zeros for empty input", () => {
    const result = mapHrZones([]);
    expect(result).toHaveLength(6);
    for (const zone of result) {
      expect(zone.seconds).toBe(0);
    }
  });
});
