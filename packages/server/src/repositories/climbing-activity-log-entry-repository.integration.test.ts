import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { area, climb, climbingLogEntry } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";

describe("ClimbingActivityLogEntryRepository PostgreSQL projection", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, userId);
  });
  afterEach(async () => {
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
    await context.db.delete(activity).where(eq(activity.providerId, "openbeta"));
  });
  afterAll(async () => {
    await context.cleanup();
  });
  const repo = () => new ClimbingActivityLogEntryRepository(context.db, userId, "UTC");
  async function write(source: SourceClimbingLogEntry) {
    const result = await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "openbeta",
      entries: [source],
    });
    const [entry] = await repo().getLogEntries(result.logEntryIds);
    if (!entry) throw new Error("Expected projected log");
    return entry.toDetail();
  }
  const route = {
    externalId: "route-one",
    name: "Route",
    kind: "route",
    publishedGrades: [{ value: "5.10a", system: "yds" }],
    pitches: [
      { externalId: "pitch-one", number: 1, publishedGrades: [{ value: "5.8", system: "yds" }] },
    ],
  } as const;
  it("projects a completed pitch without claiming route completion", async () => {
    const log = await write({
      externalId: "pitch-only",
      discipline: "rock_climbing",
      climb: route,
      attempts: [{ scope: "pitch", pitch: { number: 1 }, qualifier: "free-onsight" }],
      reportedAttemptCounts: [{ scope: "pitch", pitch: { number: 1 }, count: 2 }],
    });
    expect(log).toMatchObject({
      recordedClimbAttemptCount: 0,
      recordedPitchAttemptCount: 2,
      recordedClimbOutcome: null,
      pitchResults: [
        { recordedAttemptCount: 2, recordedOutcome: "completed", displayGrade: "5.8" },
      ],
    });
    expect(
      log.attempts.find((attempt) => attempt.outcome === "completed")?.rockResultLabels,
    ).toEqual(["sent", "Onsight"]);
  });
  it("counts one whole try and two pitch children separately", async () => {
    const log = await write({
      externalId: "grouped",
      climb: route,
      attempts: [
        { scope: "climb", sourceKey: "whole", outcome: "completed", usedAid: true },
        { scope: "pitch", pitch: { number: 1 }, parentSourceKey: "whole", outcome: "completed" },
        { scope: "pitch", parentSourceKey: "whole", outcome: "failed" },
      ],
    });
    expect(log).toMatchObject({
      recordedClimbAttemptCount: 1,
      recordedPitchAttemptCount: 2,
      recordedClimbOutcome: "completed",
    });
    const whole = log.attempts.find((attempt) => attempt.scope === "climb");
    expect(whole?.rockResultLabels).toEqual([]);
    expect(
      log.attempts
        .filter((attempt) => attempt.scope === "pitch")
        .map((attempt) => attempt.parentAttemptId),
    ).toEqual([whole?.id, whole?.id]);
  });
  it("keeps unidentified pitch results visible without inventing shared identity", async () => {
    const log = await write({
      externalId: "unidentified",
      climb: route,
      attempts: [
        { scope: "pitch", outcome: "completed", notes: "First unidentified pitch" },
        { scope: "pitch", outcome: "failed", notes: "Another unidentified pitch" },
      ],
    });
    expect(log.pitchResults).toHaveLength(2);
    expect(log.pitchResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pitch: null,
          recordedAttemptCount: 1,
          recordedOutcome: "completed",
        }),
        expect.objectContaining({
          pitch: null,
          recordedAttemptCount: 1,
          recordedOutcome: "failed",
        }),
      ]),
    );
    expect(new Set(log.pitchResults.flatMap((result) => result.attemptIds)).size).toBe(2);
  });
  it("preserves reported grades while displaying current shared grades hierarchy and coordinates", async () => {
    const first = await write({
      externalId: "old",
      climbedOn: "2026-10-01",
      reportedGrades: [{ value: "5.9", system: "yds" }],
      climb: {
        ...route,
        areas: [
          { externalId: "country", name: "Country" },
          { externalId: "wall", name: "Wall", coordinates: { latitude: 0, longitude: -122.25 } },
        ],
      },
      attempts: [{ scope: "climb", qualifier: "free-send" }],
    });
    await write({
      externalId: "new",
      climb: {
        ...route,
        name: "Renamed",
        publishedGrades: [{ value: "5.11a", system: "yds" }],
        areas: [
          { externalId: "country", name: "Country" },
          { externalId: "wall", name: "Renamed wall" },
        ],
      },
      attempts: [{ scope: "climb" }],
    });
    const [entry] = await repo().getLogEntries([first.id]);
    expect(entry?.toDetail()).toMatchObject({
      reportedGrades: [{ value: "5.9", system: "yds" }],
      displayGrade: "5.11a",
      climb: {
        name: "Renamed",
        publishedGrades: [{ value: "5.11a", system: "yds" }],
        areaPath: [
          { name: "Country" },
          { name: "Renamed wall", coordinates: { latitude: 0, longitude: -122.25 } },
        ],
      },
    });
  });
  it("retains nullable summit data and excludes aid and dabs from free sends", async () => {
    const summit = await write({
      externalId: "summit",
      discipline: "mountaineering",
      climb: { externalId: "summit-one", kind: "summit", name: "Summit" },
      attempts: [{ scope: "climb", outcome: "completed" }],
    });
    expect(summit).toMatchObject({
      climbedOn: null,
      displayGrade: null,
      recordedClimbAttemptCount: 1,
      recordedClimbOutcome: "completed",
      climb: { publishedGrades: [] },
    });
    expect(summit.attempts[0]?.rockResultLabels).toEqual([]);
    const dab = await write({
      externalId: "dab",
      discipline: "rock_climbing",
      climb: {
        externalId: "boulder-one",
        kind: "boulder",
        publishedGrades: [{ value: "V4", system: "v_scale" }],
      },
      attempts: [{ scope: "climb", qualifier: "dab", fellOrHung: false, usedAid: false }],
    });
    expect(dab).toMatchObject({ recordedClimbOutcome: "completed" });
    expect(dab.attempts[0]?.rockResultLabels).toEqual([]);
  });
  it("loads attached logs for a hiking activity without changing source dates", async () => {
    const [parent] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "openbeta",
        externalId: "hike",
        canonicalType: "hiking",
        providerType: "hike",
        startedAt: new Date("2026-10-02T00:00:00Z"),
      })
      .returning();
    if (!parent?.groupId) throw new Error("Expected hiking group");
    const log = await write({
      externalId: "hiking-log",
      activityId: parent.id,
      climbedOn: "2026-10-01",
      discipline: "mountaineering",
      climb: { externalId: "summit", kind: "summit" },
      attempts: [{ scope: "climb", outcome: "completed" }],
    });
    expect(
      (await repo().getActivityLogEntries(parent.groupId)).map((entry) => entry.toDetail()),
    ).toEqual([log]);
  });
  it("applies the access window to the source-resolved activity date", async () => {
    const [outing] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "openbeta",
        externalId: "offset-access",
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-10-02T00:30:00Z"),
        localTimeSource: "provider_offset",
        startUtcOffsetMinutes: 120,
        endUtcOffsetMinutes: 120,
      })
      .returning();
    if (!outing?.groupId) throw new Error("Expected activity group");
    const log = await write({
      externalId: "offset-access-log",
      activityId: outing.id,
      climbedOn: "2026-10-01",
      attempts: [{ scope: "climb" }],
    });
    const limited = new ClimbingActivityLogEntryRepository(
      context.db,
      userId,
      "America/Los_Angeles",
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-10-02",
        endDateExclusive: "2026-10-03",
      },
    );
    expect(
      (await limited.getActivityLogEntries(outing.groupId)).map((row) => row.toDetail().id),
    ).toEqual([log.id]);
  });
});
