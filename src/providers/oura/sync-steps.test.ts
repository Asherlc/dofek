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
import { OuraApiError, OuraClient } from "./client.ts";
import {
  syncCardiovascularAge,
  syncDailyMetricsComposite,
  syncDailyResilience,
  syncDailyResilienceWebhook,
  syncDailyStress,
  syncDailyStressWebhook,
  syncEnhancedTags,
  syncHeartRate,
  syncRestMode,
  syncSessions,
  syncSleep,
  syncSleepTime,
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

  it("records missing daily-stress scope as a degradation without failing the sync", async () => {
    const client = new OuraClient("token", vi.fn());
    const getDailyStress = vi
      .spyOn(client, "getDailyStress")
      .mockRejectedValue(new OuraApiError(401, "/daily_stress", "missing scope"));
    const syncContext = context(client, "daily-stress-user");

    const result = await syncDailyStress(syncContext);

    expect(result).toBe(0);
    expect(syncContext.errors).toEqual([]);
    expect(getDailyStress).toHaveBeenCalledWith("2026-06-01", "2026-06-30", undefined);
    expect(syncLogMocks.outcomes).toEqual([
      expect.objectContaining({
        degradations: [
          expect.objectContaining({
            kind: "optional_endpoint_unavailable",
            providerId: "oura",
            stepName: "daily_stress",
          }),
        ],
      }),
    ]);
  });

  it("records missing daily-resilience scope as a degradation without failing the sync", async () => {
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getDailyResilience").mockRejectedValue(
      new OuraApiError(401, "/daily_resilience", "missing scope"),
    );
    const syncContext = context(client, "daily-resilience-user");

    const result = await syncDailyResilience(syncContext);

    expect(result).toBe(0);
    expect(syncContext.errors).toEqual([]);
    expect(syncLogMocks.outcomes[0]).toMatchObject({
      degradations: [expect.objectContaining({ stepName: "daily_resilience" })],
    });
  });

  it("records missing cardiovascular-age scope as a degradation without failing the sync", async () => {
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getDailyCardiovascularAge").mockRejectedValue(
      new OuraApiError(401, "/daily_cardiovascular_age", "missing scope"),
    );
    const syncContext = context(client, "cardiovascular-age-user");

    const result = await syncCardiovascularAge(syncContext);

    expect(result).toBe(0);
    expect(syncContext.errors).toEqual([]);
    expect(syncLogMocks.outcomes[0]).toMatchObject({
      degradations: [expect.objectContaining({ stepName: "cardiovascular_age" })],
    });
  });

  it("surfaces non-permission daily-stress failures", async () => {
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getDailyStress").mockRejectedValue(
      new OuraApiError(500, "/daily_stress", "unavailable"),
    );
    const syncContext = context(client);

    const result = await syncDailyStress(syncContext);

    expect(result).toBe(0);
    expect(syncContext.errors).toEqual([
      expect.objectContaining({
        message: "daily_stress: API error 500 on /daily_stress: unavailable",
      }),
    ]);
    expect(syncLogMocks.outcomes).toEqual([]);
  });

  it("preserves non-Error transport failures from independent sync steps", async () => {
    const client = new OuraClient("token", vi.fn());
    const failure = "upstream transport unavailable";
    vi.spyOn(client, "getSleep").mockRejectedValue(failure);
    vi.spyOn(client, "getWorkouts").mockRejectedValue(failure);
    vi.spyOn(client, "getSessions").mockRejectedValue(failure);
    vi.spyOn(client, "getDailyStress").mockRejectedValue(failure);
    vi.spyOn(client, "getDailyResilience").mockRejectedValue(failure);
    vi.spyOn(client, "getTags").mockRejectedValue(failure);
    vi.spyOn(client, "getEnhancedTags").mockRejectedValue(failure);
    vi.spyOn(client, "getRestModePeriods").mockRejectedValue(failure);
    vi.spyOn(client, "getSleepTime").mockRejectedValue(failure);
    vi.spyOn(client, "getHeartRate").mockRejectedValue(failure);
    const syncContext = context(client, "sync-run-user");

    const results = [
      await syncSleep(syncContext),
      await syncWorkouts(syncContext),
      await syncSessions(syncContext),
      await syncDailyStressWebhook(syncContext),
      await syncDailyResilienceWebhook(syncContext),
      await syncTags(syncContext),
      await syncEnhancedTags(syncContext),
      await syncRestMode(syncContext),
      await syncSleepTime(syncContext),
      await syncHeartRate(syncContext, new Date("2026-06-01T00:00:00Z")),
    ];

    expect(results).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(syncContext.errors.map((error) => error.message)).toEqual([
      "sleep: upstream transport unavailable",
      "workouts: upstream transport unavailable",
      "sessions: upstream transport unavailable",
      "daily_stress: upstream transport unavailable",
      "daily_resilience: upstream transport unavailable",
      "tags: upstream transport unavailable",
      "enhanced_tags: upstream transport unavailable",
      "rest_mode: upstream transport unavailable",
      "sleep_time: upstream transport unavailable",
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

  it.each([false, true])(
    "fetches an empty daily-metrics window with optional endpoints %s",
    async (useOptionalFetch) => {
      const client = new OuraClient("token", vi.fn());
      const emptyResponse = { data: [], next_token: null };
      vi.spyOn(client, "getDailyReadiness").mockResolvedValue(emptyResponse);
      vi.spyOn(client, "getDailyActivity").mockResolvedValue(emptyResponse);
      vi.spyOn(client, "getDailySpO2").mockResolvedValue(emptyResponse);
      vi.spyOn(client, "getVO2Max").mockResolvedValue(emptyResponse);
      vi.spyOn(client, "getDailyStress").mockResolvedValue(emptyResponse);
      vi.spyOn(client, "getDailyResilience").mockResolvedValue(emptyResponse);
      vi.spyOn(client, "getSleep").mockResolvedValue(emptyResponse);
      const syncContext = context(client, "daily-metrics-user");

      expect(await syncDailyMetricsComposite(syncContext, useOptionalFetch)).toBe(0);
      expect(syncContext.errors).toEqual([]);
      expect(syncLogMocks.withSyncLog).toHaveBeenCalledWith(
        syncContext.db,
        "oura",
        "daily_metrics",
        expect.any(Function),
        "daily-metrics-user",
      );
    },
  );

  it("persists Oura tags, sleep-time recommendations, stress, and resilience", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown> | Array<Record<string, unknown>>) => {
          inserted.push(...(Array.isArray(value) ? value : [value]));
          return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
        }),
      })),
    };
    const client = new OuraClient("token", vi.fn());
    vi.spyOn(client, "getTags").mockResolvedValue({
      data: [
        {
          id: "tag-1",
          day: "2026-06-01",
          text: null,
          timestamp: "2026-06-01T08:30:00Z",
          tags: ["coffee", "late"],
        },
      ],
      next_token: null,
    });
    vi.spyOn(client, "getSleepTime").mockResolvedValue({
      data: [
        {
          id: "sleep-time-1",
          day: "2026-06-02",
          optimal_bedtime: null,
          recommendation: "earlier_bedtime",
          status: "optimal_found",
        },
      ],
      next_token: null,
    });
    vi.spyOn(client, "getDailyStress").mockResolvedValue({
      data: [
        {
          id: "stress-1",
          day: "2026-06-03",
          stress_high: 120,
          recovery_high: 30,
          day_summary: "stressful",
        },
      ],
      next_token: null,
    });
    vi.spyOn(client, "getDailyResilience").mockResolvedValue({
      data: [
        {
          id: "resilience-1",
          day: "2026-06-04",
          contributors: { sleep_recovery: 70, daytime_recovery: 50, stress: 30 },
          level: "solid",
        },
      ],
      next_token: null,
    });
    const syncContext = context(client);
    syncContext.db = db;

    await expect(syncTags(syncContext)).resolves.toBe(1);
    await expect(syncSleepTime(syncContext)).resolves.toBe(1);
    await expect(syncDailyStress(syncContext)).resolves.toBe(1);
    await expect(syncDailyResilience(syncContext)).resolves.toBe(1);
    expect(inserted).toEqual([
      expect.objectContaining({
        externalId: "tag-1",
        type: "oura_tag",
        valueText: "coffee, late",
        startDate: new Date("2026-06-01T08:30:00Z"),
      }),
      expect.objectContaining({
        externalId: "sleep-time-1",
        type: "oura_sleep_time",
        valueText: "earlier_bedtime",
        startDate: new Date("2026-06-02T00:00:00"),
      }),
      expect.objectContaining({
        externalId: "stress-1",
        type: "oura_daily_stress",
        value: 120,
        valueText: "stressful",
      }),
      expect.objectContaining({
        externalId: "resilience-1",
        type: "oura_daily_resilience",
        valueText: "solid",
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

  it("persists available cardiovascular ages and skips unavailable values", async () => {
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
    vi.spyOn(client, "getDailyCardiovascularAge").mockResolvedValue({
      data: [
        { day: "2026-06-01", vascular_age: null },
        { day: "2026-06-02", vascular_age: 31.5 },
      ],
      next_token: null,
    });
    const syncContext = context(client);
    syncContext.db = db;

    expect(await syncCardiovascularAge(syncContext)).toBe(1);
    expect(inserted).toEqual([
      expect.objectContaining({
        externalId: "oura_cv_age:2026-06-02",
        value: 31.5,
        startDate: new Date("2026-06-02T00:00:00"),
      }),
    ]);
  });
});
