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
  syncDailyResilience,
  syncDailyResilienceWebhook,
  syncDailyStress,
  syncDailyStressWebhook,
  syncEnhancedTags,
  syncRestMode,
  syncSessions,
  syncSleep,
  syncSleepTime,
  syncTags,
  syncWorkouts,
} from "./sync-steps.ts";

function context(client: OuraClient) {
  const errors: SyncError[] = [];
  return {
    db: Object.create(null),
    providerId: "oura",
    client,
    sinceDate: "2026-06-01",
    todayDate: "2026-06-30",
    errors,
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
    const syncContext = context(client);

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
    const syncContext = context(client);

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
    const syncContext = context(client);

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
    const syncContext = context(client);

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
    ];

    expect(results).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
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
    ]);
    expect(syncLogMocks.outcomes).toEqual([]);
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
