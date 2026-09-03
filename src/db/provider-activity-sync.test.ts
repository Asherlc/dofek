import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.fn().mockResolvedValue([]);
const mockReconcile = vi.fn().mockResolvedValue(undefined);
const mockCaptureException = vi.fn();
const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock("./provider-activity-absence.ts", () => ({
  reconcileProviderActivityAbsence: (...args: unknown[]) => mockReconcile(...args),
  markProviderActivityAbsent: vi.fn(),
}));
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock("../logger.ts", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: mockLoggerWarn },
}));

import type { SyncDatabase } from "./index.ts";
import {
  findUniqueProviderActivityByExactIdentity,
  finishProviderActivityListSync,
  type ProviderActivityExactIdentity,
  ProviderActivityListSync,
  upsertProviderActivity,
} from "./provider-activity-sync.ts";
import { runWithProviderIngestContext } from "./provider-ingest-context.ts";
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
        canonicalType: "hiking",
        providerType: "hiking",
        modality: null,
        startedAt: new Date("2022-05-17T17:23:08.000Z"),
        endedAt: new Date("2022-05-17T19:03:19.201Z"),
      }),
    ).resolves.toEqual({ id: "11111111-1111-4111-8111-111111111111" });
  });

  it("does not choose an activity when the exact identity is absent or ambiguous", async () => {
    const identity: ProviderActivityExactIdentity = {
      providerId: "garmin-dump",
      userId: "00000000-0000-0000-0000-000000000001",
      canonicalType: "hiking",
      providerType: "hiking",
      modality: null,
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
    mockLoggerWarn.mockClear();
  });

  it("rejects a fixed Etc/GMT provider offset that conflicts with the home zone", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "peloton",
        externalId: "workout-1",
        activityType: resolveProviderActivityType("cycling", "indoor_cycling"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        endedAt: new Date("2026-09-01T15:25:54.000Z"),
        timezone: "Etc/GMT+4",
        homeTimezone: "America/Los_Angeles",
      },
      { activityType: resolveProviderActivityType("cycling", "indoor_cycling") },
    );

    const values = vi.mocked(db.insert).mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "home_zone_fallback",
        rejectedProviderTimezone: "Etc/GMT+4",
        rejectedProviderStartUtcOffsetMinutes: -240,
        rejectedProviderEndUtcOffsetMinutes: -240,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "home_zone_fallback",
        rejectedProviderTimezone: "Etc/GMT+4",
        rejectedProviderStartUtcOffsetMinutes: -240,
      }),
    });
  });

  it("uses the run-scoped home timezone when a fixed provider zone is implausible", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await runWithProviderIngestContext({ homeTimezone: "America/Los_Angeles" }, () =>
      upsertProviderActivity(
        db,
        {
          providerId: "kaya",
          externalId: "ascent-1",
          activityType: resolveProviderActivityType("climbing", "rock_climbing"),
          startedAt: new Date("2026-09-01T14:55:54.000Z"),
          endedAt: new Date("2026-09-01T15:25:54.000Z"),
          timezone: "Etc/GMT+4",
        },
        { activityType: resolveProviderActivityType("climbing", "rock_climbing") },
      ),
    );

    const values = vi.mocked(db.insert).mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "home_zone_fallback",
        rejectedProviderStartUtcOffsetMinutes: -240,
      }),
    );
  });

  it("rejects a conflicting explicitly sourced fixed Etc/GMT zone", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await runWithProviderIngestContext({ homeTimezone: "America/Los_Angeles" }, () =>
      upsertProviderActivity(
        db,
        {
          providerId: "peloton",
          externalId: "workout-explicit-zone",
          activityType: resolveProviderActivityType("cycling", "indoor_cycling"),
          startedAt: new Date("2026-09-01T14:55:54.000Z"),
          endedAt: new Date("2026-09-01T15:25:54.000Z"),
          timezone: "Etc/GMT+4",
          startUtcOffsetMinutes: -240,
          endUtcOffsetMinutes: -240,
          localTimeSource: "provider_timezone",
        },
        { activityType: resolveProviderActivityType("cycling", "indoor_cycling") },
      ),
    );

    const values = vi.mocked(db.insert).mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "home_zone_fallback",
        rejectedProviderStartUtcOffsetMinutes: -240,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "home_zone_fallback",
        rejectedProviderStartUtcOffsetMinutes: -240,
      }),
    });
  });

  it("normalizes contradictory offsets for an explicitly sourced named provider zone", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "garmin",
        externalId: "named-explicit-zone",
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone: "America/New_York",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_timezone",
        homeTimezone: "America/Los_Angeles",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );

    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: null,
        localTimeSource: "home_zone_fallback",
        rejectedProviderTimezone: "America/New_York",
        rejectedProviderStartUtcOffsetMinutes: -240,
      }),
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "activity local-time context rejected",
      expect.objectContaining({ activity_id: "activity-id", provider_id: "garmin" }),
    );
  });

  it("downgrades an invalid explicitly sourced provider timezone to unknown", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "garmin",
        externalId: "invalid-explicit-zone",
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone: "Not/A_Timezone",
        startUtcOffsetMinutes: -240,
        endUtcOffsetMinutes: -240,
        localTimeSource: "provider_timezone",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );

    const explicitUnknown = {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      localTimeSource: "unknown",
    };
    expect(vi.mocked(db.insert).mock.results[0]?.value.values).toHaveBeenCalledWith(
      expect.objectContaining(explicitUnknown),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: expect.objectContaining(explicitUnknown),
    });
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { operation: "provider-activity-local-time-context" },
    });
  });

  it("audits a malformed timezone even when its raw offset matches the home zone", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "garmin",
        externalId: "malformed-zone-plausible-offset",
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone: "Not/A_Timezone",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_timezone",
        homeTimezone: "America/Los_Angeles",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );

    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        localTimeSource: "home_zone_fallback",
        rejectedProviderTimezone: "Not/A_Timezone",
        rejectedProviderStartUtcOffsetMinutes: -420,
      }),
    });
  });

  it("rejects provider context when neither GPS nor a home timezone can validate it", async () => {
    await upsertProviderActivity(
      makeMockDb(),
      {
        providerId: "garmin",
        externalId: "provider-zone-without-home",
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone: "America/New_York",
        localTimeSource: "provider_timezone",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "activity local-time context rejected",
      expect.objectContaining({
        supplied: expect.objectContaining({ timezone: "America/New_York" }),
        substituted: expect.objectContaining({ source: "unknown" }),
      }),
    );
  });

  it("does not warn when provider and home timezones differ by exactly 60 minutes", async () => {
    await upsertProviderActivity(
      makeMockDb(),
      {
        providerId: "garmin",
        externalId: "one-hour-zone-difference",
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone: "America/New_York",
        localTimeSource: "provider_timezone",
        homeTimezone: "America/Chicago",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("reports an invalid home zone and rejects provider context that cannot be validated", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "garmin",
        externalId: "invalid-home-zone",
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone: "America/New_York",
        startUtcOffsetMinutes: -240,
        endUtcOffsetMinutes: null,
        localTimeSource: "provider_timezone",
        homeTimezone: "Not/A_Timezone",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { operation: "provider-activity-home-timezone-context" },
    });
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: expect.objectContaining({
        timezone: null,
        localTimeSource: "unknown",
        rejectedProviderTimezone: "America/New_York",
      }),
    });
  });

  it.each([
    ["Etc/GMT", 0],
    ["Etc/GMT+10", -600],
  ])("normalizes the fixed-zone grammar %s to its derived offset", async (timezone, offset) => {
    const db = makeMockDb();
    await upsertProviderActivity(
      db,
      {
        providerId: "peloton",
        externalId: `workout-${timezone}`,
        activityType: resolveProviderActivityType("cycling", "indoor_cycling"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone,
        homeTimezone: "  America/Los_Angeles  ",
      },
      { activityType: resolveProviderActivityType("cycling", "indoor_cycling") },
    );
    expect(vi.mocked(db.insert).mock.results[0]?.value.values).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: null,
        localTimeSource: "home_zone_fallback",
        rejectedProviderTimezone: timezone,
        rejectedProviderStartUtcOffsetMinutes: offset,
      }),
    );
  });

  it.each(["prefixEtc/GMT+4", "Etc/GMT+4suffix"])(
    "does not classify malformed zone %s as a fixed Etc/GMT zone",
    async (timezone) => {
      const db = makeMockDb();
      await upsertProviderActivity(
        db,
        {
          providerId: "peloton",
          externalId: "malformed-zone",
          activityType: resolveProviderActivityType("cycling", "indoor_cycling"),
          startedAt: new Date("2026-09-01T14:55:54.000Z"),
          timezone,
          homeTimezone: "America/Los_Angeles",
        },
        { activityType: resolveProviderActivityType("cycling", "indoor_cycling") },
      );
      expect(mockCaptureException).toHaveBeenCalledOnce();
      expect(vi.mocked(db.insert).mock.results[0]?.value.values).toHaveBeenCalledWith(
        expect.objectContaining({
          timezone: "America/Los_Angeles",
          localTimeSource: "home_zone_fallback",
          rejectedProviderTimezone: timezone,
        }),
      );
    },
  );

  it("logs only provider/home offset disagreements above 60 minutes", async () => {
    for (const startUtcOffsetMinutes of [-360, -359]) {
      const db = makeMockDb();
      await upsertProviderActivity(
        db,
        {
          providerId: "whoop",
          externalId: `offset-${startUtcOffsetMinutes}`,
          activityType: resolveProviderActivityType("running", "running"),
          startedAt: new Date("2026-09-01T14:55:54.000Z"),
          timezone: null,
          startUtcOffsetMinutes,
          endUtcOffsetMinutes: startUtcOffsetMinutes,
          localTimeSource: "provider_offset",
          homeTimezone: "America/Los_Angeles",
        },
        { activityType: resolveProviderActivityType("running", "running") },
      );
    }
    expect(mockLoggerWarn).toHaveBeenCalledOnce();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "activity local-time context rejected",
      expect.objectContaining({
        provider_id: "whoop",
        supplied: expect.objectContaining({ startUtcOffsetMinutes: -359 }),
        substituted: expect.objectContaining({ startUtcOffsetMinutes: -420 }),
      }),
    );
  });

  it("rejects a named provider zone that conflicts with the home zone", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);

    await upsertProviderActivity(
      db,
      {
        providerId: "garmin",
        externalId: "named-provider-zone",
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone: "America/New_York",
        homeTimezone: "America/Los_Angeles",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );

    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: expect.objectContaining({
        timezone: "America/Los_Angeles",
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: null,
        localTimeSource: "home_zone_fallback",
        rejectedProviderTimezone: "America/New_York",
      }),
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "activity local-time context rejected",
      expect.objectContaining({ activity_id: "activity-id", provider_id: "garmin" }),
    );
  });

  it("does not log when provider and home named zones agree", async () => {
    const db = makeMockDb();
    await upsertProviderActivity(
      db,
      {
        providerId: "garmin",
        externalId: "matching-provider-zone",
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-09-01T14:55:54.000Z"),
        timezone: "America/Los_Angeles",
        homeTimezone: "America/Los_Angeles",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it("does not include providerAbsentAt in conflict updates", async () => {
    const onConflictDoUpdate = vi.fn();
    const db = makeMockDb(onConflictDoUpdate);
    await upsertProviderActivity(
      db,
      {
        providerId: "apple_health",
        externalId: "hk:workout:abc",
        activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
        startedAt: new Date("2026-06-20T21:49:00Z"),
        endedAt: new Date("2026-06-20T22:17:59Z"),
      },
      {
        activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
      },
    );

    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: {
        canonicalType: "running",
        providerType: "HKWorkoutActivityTypeRunning",
        modality: null,
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
            activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
            startedAt: new Date("2026-06-20T21:49:00Z"),
          },
          {
            activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
          },
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
        activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
        startedAt: new Date("2026-06-20T21:49:00Z"),
      },
      {
        activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
      },
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
          activityType: resolveProviderActivityType("indoor_cycling", "indoor_cycling"),
          startedAt: new Date("2026-06-20T21:49:00Z"),
          endedAt: new Date("2026-06-20T22:17:59Z"),
          timezone: "Not/A_Timezone",
          startUtcOffsetMinutes: 123,
          endUtcOffsetMinutes: 124,
          localTimeSource: "unknown",
        },
        { activityType: resolveProviderActivityType("indoor_cycling", "indoor_cycling") },
      ),
    ).resolves.toEqual({ id: "activity-id" });

    const values = vi.mocked(db.insert).mock.results[0]?.value.values;
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        localTimeSource: "unknown",
        rejectedProviderTimezone: "Not/A_Timezone",
        rejectedProviderStartUtcOffsetMinutes: 123,
        rejectedProviderEndUtcOffsetMinutes: 124,
      }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: {
        canonicalType: "cycling",
        providerType: "indoor_cycling",
        modality: "indoor",
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        localTimeSource: "unknown",
        rejectedProviderTimezone: "Not/A_Timezone",
        rejectedProviderStartUtcOffsetMinutes: 123,
        rejectedProviderEndUtcOffsetMinutes: 124,
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
        activityType: resolveProviderActivityType("indoor_cycling", "indoor_cycling"),
        startedAt: new Date("2026-03-08T09:30:00.000Z"),
        endedAt: new Date("2026-03-08T10:30:00.000Z"),
        timezone: "  America/Los_Angeles  ",
        homeTimezone: "America/Los_Angeles",
      },
      { activityType: resolveProviderActivityType("indoor_cycling", "indoor_cycling") },
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
      set: {
        canonicalType: "cycling",
        providerType: "indoor_cycling",
        modality: "indoor",
        ...expectedContext,
        rejectedProviderTimezone: null,
        rejectedProviderStartUtcOffsetMinutes: null,
        rejectedProviderEndUtcOffsetMinutes: null,
      },
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
        activityType: resolveProviderActivityType("running", "running"),
        startedAt: new Date("2026-06-20T21:49:00Z"),
        timezone: null,
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_offset",
        homeTimezone: "America/Los_Angeles",
      },
      { activityType: resolveProviderActivityType("running", "running") },
    );

    expect(onConflictDoUpdate).toHaveBeenCalledWith({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: {
        canonicalType: "running",
        providerType: "running",
        modality: null,
        timezone: null,
        startUtcOffsetMinutes: -420,
        endUtcOffsetMinutes: -420,
        localTimeSource: "provider_offset",
        rejectedProviderTimezone: null,
        rejectedProviderStartUtcOffsetMinutes: null,
        rejectedProviderEndUtcOffsetMinutes: null,
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
        activityType: resolveProviderActivityType("indoor_cycling", "indoor_cycling"),
        startedAt: new Date("2026-06-20T21:49:00Z"),
        timezone: "   ",
        startUtcOffsetMinutes: 123,
        endUtcOffsetMinutes: 124,
        localTimeSource: "unknown",
      },
      { activityType: resolveProviderActivityType("indoor_cycling", "indoor_cycling") },
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
      set: {
        canonicalType: "cycling",
        providerType: "indoor_cycling",
        modality: "indoor",
        ...explicitUnknown,
        rejectedProviderTimezone: null,
        rejectedProviderStartUtcOffsetMinutes: null,
        rejectedProviderEndUtcOffsetMinutes: null,
      },
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
        activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
        startedAt: new Date("2026-06-20T21:49:00Z"),
      },
      {
        activityType: resolveProviderActivityType("HKWorkoutActivityTypeRunning", "running"),
      },
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

import { resolveProviderActivityType } from "@dofek/training/activity-types";
