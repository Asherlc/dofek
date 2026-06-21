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

function makeMockDb(): SyncDatabase {
  const returning = vi.fn().mockResolvedValue([{ id: "activity-id" }]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    select: vi.fn(),
    insert,
    delete: vi.fn(),
    execute: mockExecute,
  } as unknown as SyncDatabase;
}

describe("upsertProviderActivity", () => {
  it("does not include providerAbsentAt in conflict updates", async () => {
    const db = makeMockDb();
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

    const insert = db.insert as unknown as ReturnType<typeof vi.fn>;
    const onConflictDoUpdate = insert.mock.results[0]?.value.values.mock.results[0]?.value
      .onConflictDoUpdate as ReturnType<typeof vi.fn>;
    expect(onConflictDoUpdate.mock.calls[0]?.[0]?.set).toEqual({
      activityType: "running",
    });
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

  it("allows overriding the authoritative present list", async () => {
    const db = makeMockDb();
    const sync = new ProviderActivityListSync({
      db,
      providerId: "whoop",
      windowStart: new Date("2026-06-01T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
    });

    sync.replacePresentExternalIds(["whoop-workout-1"]);
    await sync.reconcile();

    expect(mockReconcile).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["whoop-workout-1"]),
      }),
    );
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
