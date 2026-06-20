import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvalidateByPrefix = vi.fn().mockResolvedValue(undefined);
const mockExecute = vi.fn().mockResolvedValue([]);

vi.mock("../lib/cache.ts", () => ({
  queryCache: {
    invalidateByPrefix: (...args: unknown[]) => mockInvalidateByPrefix(...args),
  },
}));

import {
  hasProviderActivityListSyncErrors,
  markProviderActivityAbsent,
  reconcileProviderActivityAbsence,
} from "./provider-activity-absence.ts";

const userId = "00000000-0000-0000-0000-000000000001";

describe("hasProviderActivityListSyncErrors", () => {
  it("returns true when an activity list fetch failed", () => {
    expect(
      hasProviderActivityListSyncErrors(
        [{ message: "workouts: rate limited" }],
        ["workouts:", "sessions:"],
      ),
    ).toBe(true);
  });

  it("returns false when only per-record insert errors exist", () => {
    expect(
      hasProviderActivityListSyncErrors(
        [{ message: "workout abc123: insert failed" }],
        ["workouts:", "sessions:"],
      ),
    ).toBe(false);
  });
});

describe("provider activity absence cache invalidation", () => {
  beforeEach(() => {
    mockInvalidateByPrefix.mockClear();
    mockExecute.mockClear();
  });

  it("invalidates activity, calendar, and training caches after reconciliation", async () => {
    await reconcileProviderActivityAbsence(
      { execute: mockExecute },
      {
        providerId: "test-provider",
        windowStart: new Date("2026-03-01T00:00:00Z"),
        windowEnd: new Date("2026-03-03T00:00:00Z"),
        presentExternalIds: new Set(["present-activity"]),
        userId,
      },
    );

    expect(mockInvalidateByPrefix).toHaveBeenCalledWith(`${userId}:activity.`);
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith(`${userId}:calendar.`);
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith(`${userId}:training.`);
    expect(mockInvalidateByPrefix).toHaveBeenCalledTimes(3);
  });

  it("invalidates activity, calendar, and training caches after marking absent", async () => {
    await markProviderActivityAbsent(
      { execute: mockExecute },
      {
        providerId: "test-provider",
        externalId: "missing-activity",
        userId,
      },
    );

    expect(mockInvalidateByPrefix).toHaveBeenCalledWith(`${userId}:activity.`);
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith(`${userId}:calendar.`);
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith(`${userId}:training.`);
    expect(mockInvalidateByPrefix).toHaveBeenCalledTimes(3);
  });
});
