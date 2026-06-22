import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn().mockResolvedValue([]);
const mockReconcile = vi.fn().mockResolvedValue(undefined);

vi.mock("./provider-activity-absence.ts", () => ({
  reconcileProviderActivityAbsence: (...args: unknown[]) => mockReconcile(...args),
  markProviderActivityAbsent: vi.fn(),
}));

import type { SyncDatabase } from "./index.ts";
import {
  finishProviderActivityListSync,
  ProviderActivityListSync,
  upsertProviderActivity,
} from "./provider-activity-sync.ts";
import { activity } from "./schema.ts";

function makeMockDb(onConflictDoUpdate = vi.fn()): SyncDatabase {
  const returning = vi.fn().mockResolvedValue([{ id: "activity-id" }]);
  onConflictDoUpdate.mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    select: vi.fn(),
    insert,
    delete: vi.fn(),
    execute: mockExecute,
  };
}

describe("upsertProviderActivity", () => {
  it("does not include providerAbsentAt in conflict updates", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);
    await upsertProviderActivity(
      db,
      {
        providerId: "apple_health",
        externalId: "hk:workout:abc",
        activityType: "running",
        startedAt: new Date("2026-06-20T21:49:00Z"),
        endedAt: new Date("2026-06-20T22:17:59Z"),
      },
      {
        activityType: "running",
      },
    );

    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: {
        activityType: "running",
      },
    });
  });

  it("throws when upserting an activity without an external id", async () => {
    await expect(
      upsertProviderActivity(
        makeMockDb(),
        {
          providerId: "apple_health",
          activityType: "running",
          startedAt: new Date("2026-06-20T21:49:00Z"),
        },
        { activityType: "running" },
      ),
    ).rejects.toThrow("Provider activity upsert requires externalId");
  });

  it("throws when upserting an activity with a whitespace-only external id", async () => {
    await expect(
      upsertProviderActivity(
        makeMockDb(),
        {
          providerId: "apple_health",
          externalId: "   ",
          activityType: "running",
          startedAt: new Date("2026-06-20T21:49:00Z"),
        },
        { activityType: "running" },
      ),
    ).rejects.toThrow("Provider activity upsert requires externalId");
  });

  it("trims external ids before insert", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);
    await upsertProviderActivity(
      db,
      {
        providerId: "apple_health",
        externalId: " hk:workout:abc ",
        activityType: "running",
        startedAt: new Date("2026-06-20T21:49:00Z"),
      },
      { activityType: "running" },
    );

    expect(vi.mocked(db.insert)).toHaveBeenCalledWith(activity);
    const values = vi.mocked(db.insert).mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: "hk:workout:abc",
      }),
    );
  });
});

describe("ProviderActivityListSync", () => {
  beforeEach(() => {
    mockReconcile.mockClear();
  });

  it("tracks upserts and reconciles against the sync window", async () => {
    const db = makeMockDb();
    const sync = new ProviderActivityListSync({
      db,
      providerId: "apple_health",
      userId: "user-1",
      windowStart: new Date("2026-06-13T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
    });

    await sync.upsert(
      {
        providerId: "apple_health",
        externalId: "hk:workout:present",
        activityType: "running",
        startedAt: new Date("2026-06-20T21:49:00Z"),
      },
      { activityType: "running" },
    );
    await sync.reconcile();

    expect(mockReconcile).toHaveBeenCalledWith(db, {
      providerId: "apple_health",
      userId: "user-1",
      windowStart: new Date("2026-06-13T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
      presentExternalIds: new Set(["hk:workout:present"]),
    });
  });

  it("tracks only non-empty trimmed external ids", () => {
    const sync = new ProviderActivityListSync({
      db: makeMockDb(),
      providerId: "whoop",
      windowStart: new Date("2026-06-01T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
    });

    sync.trackPresent(null);
    sync.trackPresent(undefined);
    sync.trackPresent("");
    sync.trackPresent("   ");
    sync.trackPresent(" whoop-workout-1 ");

    expect([...sync.presentExternalIds]).toEqual(["whoop-workout-1"]);
  });

  it("allows overriding the authoritative present list", async () => {
    const db = makeMockDb();
    const sync = new ProviderActivityListSync({
      db,
      providerId: "whoop",
      windowStart: new Date("2026-06-01T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
    });

    sync.trackPresent("stale-workout");
    sync.replacePresentExternalIds([" whoop-workout-1 ", "", "   "]);
    await sync.reconcile();

    expect([...sync.presentExternalIds]).toEqual(["whoop-workout-1"]);
    expect(mockReconcile).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["whoop-workout-1"]),
      }),
    );
  });

  it("does not reconcile when reconciliation is disabled", async () => {
    const sync = new ProviderActivityListSync({
      db: makeMockDb(),
      providerId: "apple_health",
      windowStart: new Date("2026-06-13T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
    });

    sync.trackPresent("hk:workout:present");
    sync.disableReconciliation();
    await sync.reconcile();

    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it("throws when list-scoped upsert is missing an external id", async () => {
    const sync = new ProviderActivityListSync({
      db: makeMockDb(),
      providerId: "apple_health",
      windowStart: new Date("2026-06-13T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
    });

    await expect(
      sync.upsert(
        {
          providerId: "apple_health",
          activityType: "running",
          startedAt: new Date("2026-06-20T21:49:00Z"),
        },
        { activityType: "running" },
      ),
    ).rejects.toThrow("Provider activity upsert requires externalId");
  });
});

describe("finishProviderActivityListSync", () => {
  beforeEach(() => {
    mockReconcile.mockClear();
  });

  it("delegates to provider activity absence reconciliation", async () => {
    const db = makeMockDb();
    await finishProviderActivityListSync(db, {
      providerId: "strava",
      userId: "user-1",
      windowStart: new Date("2026-06-01T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
      presentExternalIds: new Set(["123"]),
    });

    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });
});
