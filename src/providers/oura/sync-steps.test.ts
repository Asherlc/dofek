import { afterEach, describe, expect, it, vi } from "vitest";

const syncLogMocks = vi.hoisted<{
  outcomes: Array<{ result: number; degradations?: unknown[] }>;
  withSyncLog: ReturnType<typeof vi.fn>;
}>(() => ({
  outcomes: [],
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      callback: () => Promise<{ result: number; degradations?: unknown[] }>,
    ) => {
      const outcome = await callback();
      syncLogMocks.outcomes.push(outcome);
      return outcome.result;
    },
  ),
}));

vi.mock("../../db/sync-log.ts", () => ({
  withSyncLog: syncLogMocks.withSyncLog,
}));

import type { SyncError } from "../types.ts";
import { OuraClient } from "./client.ts";
import {
  syncDailyMetricsComposite,
  syncEnhancedTags,
  syncHeartRate,
  syncRestMode,
  syncSessions,
  syncSleep,
  syncTags,
  syncWorkouts,
} from "./sync-steps.ts";

function context(client: OuraClient, userId?: string) {
  const errors: SyncError[] = [];
  return {
    db: Object.create(null),
    providerId: "oura",
    client,
    sinceDate: "2026-06-01",
    todayDate: "2026-06-30",
    errors,
    options: userId ? { userId } : undefined,
  };
}

describe("Oura optional sync steps", () => {
  afterEach(() => {
    vi.clearAllMocks();
    syncLogMocks.outcomes.length = 0;
  });

  it("preserves non-Error transport failures from independent sync steps", async () => {
    const client = new OuraClient("token", vi.fn());
    const failure = "upstream transport unavailable";
    vi.spyOn(client, "getSleep").mockRejectedValue(failure);
    vi.spyOn(client, "getWorkouts").mockRejectedValue(failure);
    vi.spyOn(client, "getSessions").mockRejectedValue(failure);
    vi.spyOn(client, "getTags").mockRejectedValue(failure);
    vi.spyOn(client, "getEnhancedTags").mockRejectedValue(failure);
    vi.spyOn(client, "getRestModePeriods").mockRejectedValue(failure);
    vi.spyOn(client, "getHeartRate").mockRejectedValue(failure);
    const syncContext = context(client, "sync-run-user");

    const results = [
      await syncSleep(syncContext),
      await syncWorkouts(syncContext),
      await syncSessions(syncContext),
      await syncTags(syncContext),
      await syncEnhancedTags(syncContext),
      await syncRestMode(syncContext),
      await syncHeartRate(syncContext, new Date("2026-06-01T00:00:00Z")),
    ];

    expect(results).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(syncContext.errors.map((error) => error.message)).toEqual([
      "sleep: upstream transport unavailable",
      "workouts: upstream transport unavailable",
      "sessions: upstream transport unavailable",
      "tags: upstream transport unavailable",
      "enhanced_tags: upstream transport unavailable",
      "rest_mode: upstream transport unavailable",
      "heart_rate: upstream transport unavailable",
    ]);
    expect(syncLogMocks.outcomes).toEqual([]);
    expect(syncLogMocks.withSyncLog).toHaveBeenCalledWith(
      syncContext.db,
      "oura",
      "heart_rate",
      expect.any(Function),
      "sync-run-user",
    );
  });

  it("fetches an empty daily-metrics window", async () => {
    const client = new OuraClient("token", vi.fn());
    const emptyResponse = { data: [], next_token: null };
    vi.spyOn(client, "getDailyActivity").mockResolvedValue(emptyResponse);
    vi.spyOn(client, "getDailySpO2").mockResolvedValue(emptyResponse);
    vi.spyOn(client, "getSleep").mockResolvedValue(emptyResponse);
    const syncContext = context(client, "daily-metrics-user");

    expect(await syncDailyMetricsComposite(syncContext)).toBe(0);
    expect(syncContext.errors).toEqual([]);
    expect(syncLogMocks.withSyncLog).toHaveBeenCalledWith(
      syncContext.db,
      "oura",
      "daily_metrics",
      expect.any(Function),
      "daily-metrics-user",
    );
  });

  it("preserves pagination degradations from each daily-metrics source", async () => {
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getDailyActivity").mockResolvedValue({
      data: [],
      next_token: "stalled-cursor",
    });
    vi.spyOn(client, "getDailySpO2").mockResolvedValue({ data: [], next_token: null });
    vi.spyOn(client, "getSleep").mockResolvedValue({ data: [], next_token: null });
    const syncContext = context(client, "daily-metrics-degradation-user");

    expect(await syncDailyMetricsComposite(syncContext)).toBe(0);
    expect(syncLogMocks.outcomes[0]?.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_empty_page_with_cursor",
        stepName: "daily_activity",
      }),
    ]);
  });

  it("persists enhanced tags with custom-name, type-code, and unknown fallbacks", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserted.push(value);
          return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getEnhancedTags").mockResolvedValue({
      data: [
        {
          id: "custom-tag",
          custom_name: "Late coffee",
          tag_type_code: "coffee",
          start_time: "2026-06-01T10:00:00Z",
          end_time: "2026-06-01T10:30:00Z",
          start_day: "2026-06-01",
          end_day: "2026-06-01",
          comment: null,
        },
        {
          id: "typed-tag",
          custom_name: null,
          tag_type_code: "workout",
          start_time: "2026-06-02T10:00:00Z",
          end_time: null,
          start_day: "2026-06-02",
          end_day: null,
          comment: null,
        },
        {
          id: "unknown-tag",
          custom_name: null,
          tag_type_code: null,
          start_time: "2026-06-03T10:00:00Z",
          end_time: null,
          start_day: "2026-06-03",
          end_day: null,
          comment: null,
        },
      ],
      next_token: null,
    });
    const syncContext = context(client);
    syncContext.db = db;

    expect(await syncEnhancedTags(syncContext)).toBe(3);
    expect(inserted.map((value) => value.valueText)).toEqual(["Late coffee", "workout", "unknown"]);
    expect(inserted[0]?.endDate).toEqual(new Date("2026-06-01T10:30:00Z"));
    expect(inserted.slice(1).map((value) => value.endDate)).toEqual([undefined, undefined]);
  });

  it("persists Rest Mode periods using date fields when precise times are absent", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserted.push(value);
          return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getRestModePeriods").mockResolvedValue({
      data: [
        {
          id: "date-only",
          start_time: null,
          end_time: null,
          start_day: "2026-06-01",
          end_day: "2026-06-03",
        },
        {
          id: "timed",
          start_time: "2026-06-04T08:00:00Z",
          end_time: "2026-06-04T17:00:00Z",
          start_day: "2026-06-04",
          end_day: "2026-06-04",
        },
      ],
      next_token: null,
    });
    const syncContext = context(client);
    syncContext.db = db;

    expect(await syncRestMode(syncContext)).toBe(2);
    expect(inserted[0]).toMatchObject({
      externalId: "date-only",
      startDate: new Date("2026-06-01T00:00:00"),
      endDate: new Date("2026-06-03T23:59:59"),
    });
    expect(inserted[1]).toMatchObject({
      externalId: "timed",
      startDate: new Date("2026-06-04T08:00:00Z"),
      endDate: new Date("2026-06-04T17:00:00Z"),
    });
  });
});
