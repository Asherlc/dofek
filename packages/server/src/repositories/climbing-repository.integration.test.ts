import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../../../src/db/climbing-log-sync.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { area, climb, climbingLogEntry } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import {
  climbingTestDate,
  seedClimbingActivity,
  seedClimbingLog,
} from "./climbing-integration-test-helpers.ts";
import { ClimbingRepository } from "./climbing-repository.ts";

describe("ClimbingRepository PostgreSQL scoped rock summaries", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    for (const provider of ["climbing-summary-test", "mountain-project", "openbeta"])
      await ensureProvider(context.db, provider, provider, undefined, TEST_USER_ID);
  });
  afterEach(async () => {
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
    await context.db.delete(activity).where(eq(activity.userId, TEST_USER_ID));
  });
  afterAll(async () => context.cleanup());
  const repo = (timezone = "UTC") => new ClimbingRepository(context.db, TEST_USER_ID, timezone);
  const route = {
    externalId: "route",
    name: "Corner",
    kind: "route",
    publishedGrades: [{ value: "5.10a", system: "yds" }],
    areas: [{ externalId: "wall", name: "Wall" }],
  } as const;
  async function write(
    source: Partial<SourceClimbingLogEntry> = {},
    providerId = "climbing-summary-test",
  ) {
    return seedClimbingLog(context.db, providerId, {
      externalId: "log",
      climbedOn: await climbingTestDate(context.db),
      discipline: "rock_climbing",
      climb: route,
      attempts: [{ scope: "climb", sourceResult: "Send", qualifier: "free-send" }],
      ...source,
    });
  }
  const volume = async (filters: ClimbingFilters = {}) =>
    (await repo().getVolumeByGrade(30, filters)).map((row) => row.toDetail());

  it("maps native climb coordinates before the nearest coordinate-bearing area", async () => {
    const id = await write({
      climb: {
        ...route,
        coordinates: { latitude: 12, longitude: 0 },
        areas: [
          { externalId: "region", name: "Region", coordinates: { latitude: 40, longitude: -120 } },
          { externalId: "crag", name: "Crag", coordinates: { latitude: 0, longitude: -122.25 } },
          { externalId: "wall", name: "Wall" },
        ],
      },
    });
    expect(await repo().getMapEntries(30)).toEqual([
      {
        id,
        activityId: null,
        date: await climbingTestDate(context.db),
        label: "Corner",
        grade: "5.10a",
        location: {
          coordinates: { latitude: 12, longitude: 0 },
          scope: "climb",
          objectId: expect.any(String),
          providerId: "climbing-summary-test",
          name: "Corner",
        },
      },
    ]);
    await context.db.update(climb).set({ coordinates: null });
    expect(await repo().getMapEntries(30)).toEqual([
      expect.objectContaining({
        id,
        location: {
          coordinates: { latitude: 0, longitude: -122.25 },
          scope: "area",
          objectId: expect.any(String),
          providerId: "climbing-summary-test",
          name: "Crag",
        },
      }),
    ]);
    await context.db.update(area).set({ coordinates: null });
    expect(await repo().getMapEntries(30)).toEqual([]);
  });
  it("maps one selected source graph for cross-provider duplicates and retains same-provider laps", async () => {
    const outing = await seedClimbingActivity(context.db, "climbing-summary-test", "map-outing");
    const mpClimb = { ...route, coordinates: { latitude: 35, longitude: -119 } };
    const obClimb = { ...route, coordinates: { latitude: 38, longitude: -120 } };
    const first = await write(
      { activityId: outing.id, externalId: "mp-first", climb: mpClimb },
      "mountain-project",
    );
    await write({ activityId: outing.id, externalId: "ob-first", climb: obClimb }, "openbeta");
    const second = await write(
      { activityId: outing.id, externalId: "mp-second", climb: mpClimb },
      "mountain-project",
    );
    expect(await repo().getMapEntries(30)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first,
          activityId: outing.groupId,
          location: expect.objectContaining({
            providerId: "mountain-project",
            coordinates: { latitude: 35, longitude: -119 },
          }),
        }),
        expect.objectContaining({
          id: second,
          activityId: outing.groupId,
          location: expect.objectContaining({
            providerId: "mountain-project",
            coordinates: { latitude: 35, longitude: -119 },
          }),
        }),
      ]),
    );
    expect(await repo().getMapEntries(30)).toHaveLength(2);
  });
  it("counts a multi-pitch log once and applies filters before choosing located entries", async () => {
    const id = await write({
      climb: {
        ...route,
        setting: "outdoor",
        routeProtection: ["sport"],
        coordinates: { latitude: 37, longitude: -121 },
        pitches: [
          {
            externalId: "first-pitch",
            number: 1,
            publishedGrades: [{ value: "5.10a", system: "yds" }],
          },
          {
            externalId: "second-pitch",
            number: 2,
            publishedGrades: [{ value: "5.10b", system: "yds" }],
          },
        ],
      },
      attempts: [
        {
          scope: "pitch",
          pitch: { number: 1 },
          ropeMethod: "lead",
          solo: false,
          protectionUsed: ["sport"],
        },
        {
          scope: "pitch",
          pitch: { number: 2 },
          ropeMethod: "lead",
          solo: false,
          protectionUsed: ["sport"],
        },
      ],
    });
    expect(await repo().getMapEntries(30)).toEqual([]);
    expect(
      await repo().getMapEntries(30, {
        attemptScope: "pitch",
        setting: "outdoor",
        climbKind: "route",
        ropeMethod: "lead",
        solo: false,
        routeProtection: "sport",
        protectionUsed: "sport",
      }),
    ).toEqual([expect.objectContaining({ id, grade: "5.10a" })]);
    expect(await repo().getMapEntries(30, { attemptScope: "pitch", setting: "indoor" })).toEqual(
      [],
    );
    expect(
      await repo().getMapEntries(30, { attemptScope: "pitch", ropeMethod: "top_rope" }),
    ).toEqual([]);
  });
  it("excludes unavailable dates, absent records, other users, and entries outside the access window", async () => {
    const mappedClimb = { ...route, coordinates: { latitude: 37, longitude: -121 } };
    const date = await climbingTestDate(context.db);
    const included = await write({ externalId: "included", climb: mappedClimb });
    const earlier = await write({
      externalId: "earlier-map",
      climbedOn: await climbingTestDate(context.db, 10),
      climb: mappedClimb,
    });
    await write({ externalId: "undated-map", climbedOn: null, climb: mappedClimb });
    await write({
      externalId: "old-map",
      climbedOn: await climbingTestDate(context.db, 31),
      climb: mappedClimb,
    });
    await write({ externalId: "future-map", climbedOn: "2999-01-01", climb: mappedClimb });
    const absent = await write({ externalId: "absent-map", climb: mappedClimb });
    await context.db
      .update(climbingLogEntry)
      .set({ providerAbsentAt: new Date() })
      .where(eq(climbingLogEntry.id, absent));
    const otherUser = "b0000000-0000-4000-8000-000000000001";
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id,name) VALUES (${otherUser},'Other user') ON CONFLICT DO NOTHING`,
    );
    await ensureProvider(context.db, "climbing-summary-test", "Climbing", undefined, otherUser);
    await persistClimbingLogEntries(context.db, {
      userId: otherUser,
      providerId: "climbing-summary-test",
      entries: [
        {
          externalId: "other-map",
          climbedOn: date,
          discipline: "rock_climbing",
          climb: mappedClimb,
          attempts: [{ scope: "climb" }],
        },
      ],
    });
    expect(await repo().getMapEntries(30)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: included }),
        expect.objectContaining({ id: earlier }),
      ]),
    );
    expect(await repo().getMapEntries(30)).toHaveLength(2);
    const limited = new ClimbingRepository(context.db, TEST_USER_ID, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: date,
      endDateExclusive: await climbingTestDate(context.db, 0),
    });
    expect(await limited.getMapEntries(30)).toEqual([expect.objectContaining({ id: included })]);
    const exclusiveEnd = new ClimbingRepository(context.db, TEST_USER_ID, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: await climbingTestDate(context.db, 10),
      endDateExclusive: date,
    });
    expect(await exclusiveEnd.getMapEntries(30)).toEqual([
      expect.objectContaining({ id: earlier }),
    ]);
  });

  it("counts one send despite equivalent and aid grade components", async () => {
    await write({
      climb: {
        ...route,
        publishedGrades: [
          { value: "6a", system: "french" },
          { value: "5.10a", system: "yds" },
          { value: "A1", system: "aid" },
        ],
      },
    });
    expect(await volume()).toEqual([
      expect.objectContaining({
        climbKind: "route",
        grade: "5.10a",
        sends: 1,
        recordedAttempts: 1,
      }),
    ]);
  });
  it("uses pitch grades only for pitch-scoped results", async () => {
    await write({
      climb: {
        ...route,
        pitches: [
          { externalId: "pitch", number: 1, publishedGrades: [{ value: "5.12a", system: "yds" }] },
        ],
      },
      attempts: [
        { scope: "pitch", pitch: { number: 1 }, sourceResult: "Send", qualifier: "free-send" },
      ],
    });
    expect(await volume()).toEqual([]);
    expect(await volume({ attemptScope: "pitch" })).toEqual([
      expect.objectContaining({ grade: "5.12a", sends: 1, recordedAttempts: 1 }),
    ]);
    expect(
      (await repo().getGradeProgression(30, { attemptScope: "pitch" })).flatMap((row) =>
        row.toDetail().grades.map((grade) => grade.grade),
      ),
    ).toEqual(["5.12a"]);
  });
  it("requires combined method and solo filters on the same attempt", async () => {
    await write({
      attempts: [
        { scope: "climb", ropeMethod: "lead", solo: false },
        { scope: "climb", ropeMethod: "top_rope", solo: true },
      ],
    });
    expect(await volume({ ropeMethod: "lead", solo: true })).toEqual([]);
    expect(await volume({ ropeMethod: "lead", solo: false })).toEqual([
      expect.objectContaining({ recordedAttempts: 1 }),
    ]);
  });
  it("keeps aid completion and dabs out of free-send metrics", async () => {
    await write({
      attempts: [{ scope: "climb", sourceResult: "completed", usedAid: true, fellOrHung: false }],
    });
    await write({
      externalId: "dab",
      climb: {
        externalId: "boulder",
        kind: "boulder",
        publishedGrades: [{ value: "V4", system: "v_scale" }],
      },
      attempts: [
        {
          scope: "climb",
          sourceResult: "Dab",
          qualifier: "dab",
          usedAid: false,
          fellOrHung: false,
        },
      ],
    });
    expect(await volume()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grade: "5.10a", sends: 0, recordedAttempts: 1 }),
        expect.objectContaining({ grade: "V4", sends: 0, recordedAttempts: 1 }),
      ]),
    );
  });
  it("keeps advertised protection separate from actual protection", async () => {
    await write({
      climb: { ...route, routeProtection: ["sport"] },
      attempts: [{ scope: "climb", protectionUsed: ["trad"] }],
    });
    expect(await volume({ routeProtection: "sport" })).toHaveLength(1);
    expect(await volume({ protectionUsed: "sport" })).toEqual([]);
    expect(await volume({ protectionUsed: "trad" })).toHaveLength(1);
  });
  it("filters known rock observations before converting grades", async () => {
    await write({
      externalId: "ice",
      discipline: "ice_climbing",
      climb: { ...route, publishedGrades: [{ value: "WI5", system: "water_ice" }] },
    });
    await write({
      externalId: "aid-grade",
      climb: {
        externalId: "aid",
        kind: "route",
        publishedGrades: [{ value: "A2", system: "aid" }],
      },
    });
    await write({
      externalId: "reported-only",
      climb: { externalId: "ungraded", kind: "route" },
      reportedGrades: [{ value: "5.14a", system: "yds" }],
    });
    await write({
      externalId: "summit",
      discipline: "mountaineering",
      climb: { externalId: "summit", kind: "summit" },
    });
    expect(await volume()).toEqual([]);
    expect(await repo().getGradeProgression(30)).toEqual([]);
  });
  it("counts known rock ungraded participation without treating opinions as published difficulty", async () => {
    const outing = await seedClimbingActivity(
      context.db,
      "climbing-summary-test",
      "ungraded-session",
    );
    await write({
      activityId: outing.id,
      climb: { externalId: "ungraded", kind: "route" },
      reportedGrades: [{ value: "5.14a", system: "yds" }],
    });
    expect(await volume()).toEqual([]);
    expect((await repo().getSessionSummaries(30)).map((row) => row.toDetail())).toEqual([
      expect.objectContaining({
        activityId: outing.groupId,
        attempts: 1,
        sends: 1,
        hardestRouteGrade: null,
      }),
    ]);
  });
  it("counts each recorded attempt once and preserves multiple completed attempts", async () => {
    await write({
      attempts: [
        { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
        { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
        { scope: "climb", sourceResult: "failed" },
      ],
    });
    expect(await volume()).toEqual([
      expect.objectContaining({ attempts: 3, recordedAttempts: 3, sends: 2 }),
    ]);
  });
  it("retains one unknown attempt when the provider gives no total", async () => {
    await write({ attempts: [{ scope: "climb" }] });
    expect(await volume()).toEqual([
      expect.objectContaining({ attempts: 1, recordedAttempts: 1, sends: 0 }),
    ]);
    const [lane] = await repo().getGradeProgression(30);
    expect(lane?.toDetail().periods[0]?.settings[0]).toMatchObject({
      climbingDays: 1,
      unknownOutcomes: 1,
      sends: 0,
    });
  });
  it("retains attached and standalone rock metrics", async () => {
    const outing = await seedClimbingActivity(context.db, "climbing-summary-test", "outing");
    await write({ activityId: outing.id, reportedAttemptCounts: [{ scope: "climb", count: 2 }] });
    await write({
      externalId: "standalone",
      climb: {
        externalId: "other",
        kind: "boulder",
        publishedGrades: [{ value: "V4", system: "v_scale" }],
      },
      reportedAttemptCounts: [{ scope: "climb", count: 3 }],
    });
    expect(await volume()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grade: "5.10a", attempts: 2, sends: 1 }),
        expect.objectContaining({ grade: "V4", attempts: 3, sends: 1 }),
      ]),
    );
    expect((await repo().getSessionSummaries(30)).map((row) => row.toDetail())).toEqual([
      expect.objectContaining({ attempts: 2, sends: 1, hardestRouteGrade: "5.10a" }),
    ]);
  });
  it("consolidates exact provider observations while preserving same-provider laps", async () => {
    const outing = await seedClimbingActivity(context.db, "climbing-summary-test", "outing");
    await write({ activityId: outing.id, externalId: "mp-first" }, "mountain-project");
    await write({ activityId: outing.id, externalId: "ob-first" }, "openbeta");
    await write({ activityId: outing.id, externalId: "mp-second" }, "mountain-project");
    expect(await volume()).toEqual([expect.objectContaining({ recordedAttempts: 2, sends: 2 })]);
  });
  it("retains conflicting provider attempt totals as an unknown canonical total", async () => {
    const outing = await seedClimbingActivity(context.db, "climbing-summary-test", "outing");
    await write(
      { activityId: outing.id, reportedAttemptCounts: [{ scope: "climb", count: 2 }] },
      "mountain-project",
    );
    await write(
      { activityId: outing.id, reportedAttemptCounts: [{ scope: "climb", count: 4 }] },
      "openbeta",
    );
    expect(await volume()).toEqual([
      expect.objectContaining({ attempts: null, recordedAttempts: null, sends: 1 }),
    ]);
  });
  it("preserves standalone source observations without cross-provider merging", async () => {
    await write({}, "mountain-project");
    await write({}, "openbeta");
    expect(await volume()).toEqual([expect.objectContaining({ recordedAttempts: 2, sends: 2 })]);
  });
  it.each(["mountain-project", "openbeta"])(
    "retains unknown %s setting without an inferred provider default",
    async (provider) => {
      await write({}, provider);
      expect(await volume({ setting: "outdoor" })).toEqual([]);
      expect(await volume({ setting: "unknown" })).toHaveLength(1);
    },
  );
  it("uses verified settings for both attached and standalone filters", async () => {
    const outing = await seedClimbingActivity(context.db, "climbing-summary-test", "outing");
    await write({ activityId: outing.id, climb: { ...route, setting: "indoor" } });
    await write({
      externalId: "outdoor",
      climb: { ...route, externalId: "outdoor-route", setting: "outdoor" },
    });
    expect(await volume({ setting: "indoor" })).toEqual([
      expect.objectContaining({ recordedAttempts: 1 }),
    ]);
    expect(await volume({ setting: "outdoor" })).toEqual([
      expect.objectContaining({ recordedAttempts: 1 }),
    ]);
    expect(await repo().getSessionSummaries(30, { setting: "outdoor" })).toEqual([]);
  });
  it("excludes absent source logs and restores them with unchanged attempts", async () => {
    const outing = await seedClimbingActivity(context.db, "climbing-summary-test", "outing");
    const id = await write({ activityId: outing.id, raw: { retained: true } });
    await context.db
      .update(climbingLogEntry)
      .set({ providerAbsentAt: new Date() })
      .where(eq(climbingLogEntry.id, id));
    expect(await volume()).toEqual([]);
    expect(await repo().getActivityLogEntries(outing.groupId)).toEqual([]);
    await context.db
      .update(climbingLogEntry)
      .set({ providerAbsentAt: null })
      .where(eq(climbingLogEntry.id, id));
    expect(await volume()).toEqual([expect.objectContaining({ recordedAttempts: 1, sends: 1 })]);
    expect((await repo().getActivityLogEntries(outing.groupId))[0]?.toDetail()).toMatchObject({
      raw: { retained: true },
      recordedClimbAttemptCount: 1,
    });
  });
  it("uses strict calendar-day boundaries and does not invent dates for standalone logs", async () => {
    const boundaryDate = await climbingTestDate(context.db, 30);
    const outing = await seedClimbingActivity(
      context.db,
      "climbing-summary-test",
      "boundary",
      new Date(`${boundaryDate}T12:00:00Z`),
    );
    await write({ activityId: outing.id, climbedOn: boundaryDate });
    await write({ externalId: "boundary-standalone", climbedOn: boundaryDate });
    await write({ externalId: "undated", climbedOn: null });
    expect(await volume()).toEqual([]);
    expect(await repo().getGradeProgression(30)).toEqual([]);
    expect(await repo().getSessionSummaries(30)).toEqual([]);
  });
  it("uses source-resolved activity dates independently of the log source date", async () => {
    const date = await climbingTestDate(context.db);
    const outing = await seedClimbingActivity(
      context.db,
      "climbing-summary-test",
      "offset",
      new Date(`${date}T23:30:00Z`),
    );
    await context.db
      .update(activity)
      .set({
        localTimeSource: "provider_offset",
        startUtcOffsetMinutes: 120,
        endUtcOffsetMinutes: 120,
      })
      .where(and(eq(activity.id, outing.id), eq(activity.userId, TEST_USER_ID)));
    await write({ activityId: outing.id, climbedOn: "2020-01-01" });
    const expectedDate = new Date(Date.parse(`${date}T23:30:00Z`) + 120 * 60000)
      .toISOString()
      .slice(0, 10);
    expect(
      (await repo("America/Los_Angeles").getSessionSummaries(30))[0]?.toDetail(),
    ).toMatchObject({ date: expectedDate, attempts: 1 });
  });
  it("returns exact-range attached rock observations with one grade and scoped counts", async () => {
    const date = await climbingTestDate(context.db);
    const outing = await seedClimbingActivity(
      context.db,
      "climbing-summary-test",
      "exact-range",
      new Date(`${date}T12:00:00Z`),
    );
    await write({
      activityId: outing.id,
      climb: {
        ...route,
        publishedGrades: [
          { value: "5.10a", system: "yds" },
          { value: "6a", system: "french" },
        ],
        pitches: [
          { externalId: "pitch", number: 1, publishedGrades: [{ value: "5.12a", system: "yds" }] },
        ],
      },
      attempts: [
        { scope: "climb", sourceResult: "Send", qualifier: "free-send" },
        { scope: "pitch", pitch: { number: 1 }, sourceResult: "Send", qualifier: "free-send" },
      ],
      reportedAttemptCounts: [{ scope: "climb", count: 3 }],
    });
    await write({ externalId: "standalone" });
    expect(await repo().getAttachedRockObservations(date, date)).toEqual([
      expect.objectContaining({
        activityId: outing.groupId,
        climbKind: "route",
        attemptScope: "climb",
        recordedAttempts: 3,
        sends: 1,
        observedOutcomes: 1,
        displayGrade: { grade: "5.10a", gradeSystem: "yds", gradeSortValue: expect.any(Number) },
      }),
    ]);
    expect(await repo().getAttachedRockObservations("2000-01-01", "2000-01-01")).toEqual([]);
  });
});
