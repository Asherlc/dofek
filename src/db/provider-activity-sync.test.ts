import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn().mockResolvedValue([]);
const mockReconcile = vi.fn().mockResolvedValue(undefined);
const mockCaptureException = vi.fn();

vi.mock("./provider-activity-absence.ts", () => ({
  reconcileProviderActivityAbsence: (...args: unknown[]) => mockReconcile(...args),
  markProviderActivityAbsent: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import type { SyncDatabase } from "./index.ts";
import {
  findUniqueProviderActivityByExactIdentity,
  finishProviderActivityListSync,
  type ProviderActivityExactIdentity,
  ProviderActivityListSync,
  upsertProviderActivity,
} from "./provider-activity-sync.ts";
import { activity } from "./schema/activity.ts";

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

describe("findUniqueProviderActivityByExactIdentity", () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("returns the activity when the exact identity matches one active row", async () => {
    mockExecute.mockResolvedValueOnce([{ id: "11111111-1111-4111-8111-111111111111" }]);

    await expect(
      findUniqueProviderActivityByExactIdentity(makeMockDb(), {
        providerId: "garmin-dump",
        userId: "00000000-0000-0000-0000-000000000001",
        activityType: "hiking",
        startedAt: new Date("2022-05-17T17:23:08.000Z"),
        endedAt: new Date("2022-05-17T19:03:19.201Z"),
      }),
    ).resolves.toEqual({ id: "11111111-1111-4111-8111-111111111111" });
  });

  it("does not choose an activity when the exact identity is absent or ambiguous", async () => {
    const identity: ProviderActivityExactIdentity = {
      providerId: "garmin-dump",
      userId: "00000000-0000-0000-0000-000000000001",
      activityType: "hiking",
      startedAt: new Date("2022-05-17T17:23:08.000Z"),
      endedAt: new Date("2022-05-17T19:03:19.201Z"),
    };
    mockExecute.mockResolvedValueOnce([]);
    await expect(findUniqueProviderActivityByExactIdentity(makeMockDb(), identity)).resolves.toBe(
      undefined,
    );

    mockExecute.mockResolvedValueOnce([
      { id: "11111111-1111-4111-8111-111111111111" },
      { id: "22222222-2222-4222-8222-222222222222" },
    ]);
    await expect(findUniqueProviderActivityByExactIdentity(makeMockDb(), identity)).resolves.toBe(
      undefined,
    );
  });
});

describe("upsertProviderActivity", () => {
  beforeEach(() => {
    mockCaptureException.mockClear();
  });

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

  it("throws when upserting an activity with a whitespace-only external id", async () => {
    for (const externalId of ["", "   "]) {
      await expect(
        upsertProviderActivity(
          makeMockDb(),
          {
            providerId: "apple_health",
            externalId,
            activityType: "running",
            startedAt: new Date("2026-06-20T21:49:00Z"),
          },
          { activityType: "running" },
        ),
      ).rejects.toThrow("Provider activity upsert requires externalId");
    }
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

  it("stores explicit unknown context when an optional provider timezone is invalid", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await expect(
      upsertProviderActivity(
        db,
        {
          providerId: "peloton",
          externalId: "workout-1",
          activityType: "indoor_cycling",
          startedAt: new Date("2026-06-20T21:49:00Z"),
          endedAt: new Date("2026-06-20T22:17:59Z"),
          timezone: "Not/A_Timezone",
          startUtcOffsetMinutes: 123,
          endUtcOffsetMinutes: 124,
          localTimeSource: "unknown",
        },
        { activityType: "indoor_cycling" },
      ),
    ).resolves.toEqual({ id: "activity-id" });

    const values = vi.mocked(db.insert).mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        localTimeSource: "unknown",
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: {
        activityType: "indoor_cycling",
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        localTimeSource: "unknown",
      },
    });
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { operation: "provider-activity-local-time-context" },
    });
  });

  it("resolves and trims a valid optional provider timezone", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "peloton",
        externalId: "workout-1",
        activityType: "indoor_cycling",
        startedAt: new Date("2026-03-08T09:30:00.000Z"),
        endedAt: new Date("2026-03-08T10:30:00.000Z"),
        timezone: "  America/Los_Angeles  ",
      },
      { activityType: "indoor_cycling" },
    );

    const expectedContext = {
      timezone: "America/Los_Angeles",
      startUtcOffsetMinutes: -480,
      endUtcOffsetMinutes: -420,
      localTimeSource: "provider_timezone",
    };
    const values = vi.mocked(db.insert).mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith(expect.objectContaining(expectedContext));
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: { activityType: "indoor_cycling", ...expectedContext },
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("preserves explicitly supplied authoritative offset context", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "whoop",
        externalId: "workout-1",
        activityType: "running",
        startedAt: new Date("2026-06-20T21:49:00Z"),
        timezone: null,
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_offset",
      },
      { activityType: "running" },
    );

    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: {
        activityType: "running",
        timezone: null,
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_offset",
      },
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("normalizes a whitespace-only optional timezone to explicit unknown", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "peloton",
        externalId: "workout-1",
        activityType: "indoor_cycling",
        startedAt: new Date("2026-06-20T21:49:00Z"),
        timezone: "   ",
        startUtcOffsetMinutes: 123,
        endUtcOffsetMinutes: 124,
        localTimeSource: "unknown",
      },
      { activityType: "indoor_cycling" },
    );

    const explicitUnknown = {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      localTimeSource: "unknown",
    };
    const values = vi.mocked(db.insert).mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith(expect.objectContaining(explicitUnknown));
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: { activityType: "indoor_cycling", ...explicitUnknown },
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
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

    expect(mockReconcile).toHaveBeenCalledWith(db, {
      providerId: "strava",
      userId: "user-1",
      windowStart: new Date("2026-06-01T00:00:00Z"),
      windowEnd: new Date("2026-06-21T00:00:00Z"),
      presentExternalIds: new Set(["123"]),
    });
  });

  it("propagates provider activity absence reconciliation errors", async () => {
    const db = makeMockDb();
    mockReconcile.mockRejectedValueOnce(new Error("reconciliation failed"));

    await expect(
      finishProviderActivityListSync(db, {
        providerId: "strava",
        userId: "user-1",
        windowStart: new Date("2026-06-01T00:00:00Z"),
        windowEnd: new Date("2026-06-21T00:00:00Z"),
        presentExternalIds: new Set(["123"]),
      }),
    ).rejects.toThrow("reconciliation failed");
  });
});
