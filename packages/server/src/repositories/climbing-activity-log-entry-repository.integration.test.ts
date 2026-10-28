import { eq, inArray, sql } from "drizzle-orm";
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
import { ProviderDetailRepository } from "./provider-detail-repository.ts";

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
    await context.db
      .delete(activity)
      .where(inArray(activity.providerId, ["openbeta", "mountain-project", "kaya"]));
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
  it.each([false, true])(
    "projects historical retained KAYA tags without rewriting raw source records (ascent: %s)",
    async (ascent) => {
      await ensureProvider(context.db, "kaya", "KAYA", undefined, userId);
      const tags = [
        { id: "custom", name: "Funky", tag_type_id: "81" },
        { id: "technical", name: "Technical", tag_type_id: "6" },
      ];
      const raw = ascent ? { climb: { tags } } : { tags };
      const written = await persistClimbingLogEntries(context.db, {
        userId,
        providerId: "kaya",
        entries: [
          {
            externalId: "historical-tags",
            climbedOn: "2026-10-02",
            raw,
            attempts: [{ scope: "climb" }],
          },
        ],
      });
      const id = written.logEntryIds[0];
      if (!id) throw new Error("Expected historical KAYA log");
      const [active] = await repo().getLogEntries([id]);
      const retained = await repo().getProviderLogEntry("kaya", id);
      const expected = [
        {
          providerId: "kaya",
          sourceKey: "custom",
          label: "Funky",
          categoryKey: "81",
          categoryLabel: null,
        },
        {
          providerId: "kaya",
          sourceKey: "technical",
          label: "Technical",
          categoryKey: "6",
          categoryLabel: "Style",
        },
      ];
      expect(active?.toDetail().tags).toEqual(expected);
      expect(retained?.tags).toEqual(expected);
      const [stored] = await context.db
        .select({ raw: climbingLogEntry.raw })
        .from(climbingLogEntry)
        .where(eq(climbingLogEntry.id, id));
      expect(stored?.raw).toEqual(raw);
    },
  );
  it("unions retained tags from a nonpreferred KAYA activity member", async () => {
    await ensureProvider(context.db, "kaya", "KAYA", undefined, userId);
    const [preferred] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "openbeta",
        externalId: "tags-preferred",
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-10-02T10:00:00Z"),
      })
      .returning();
    if (!preferred?.groupId) throw new Error("Expected preferred activity group");
    const [other] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "kaya",
        externalId: "tags-other",
        groupId: preferred.groupId,
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-10-02T10:00:00Z"),
      })
      .returning();
    if (!other) throw new Error("Expected KAYA activity");
    const sharedClimb = { ...route, areas: [{ externalId: "tags-wall", name: "Wall" }] };
    await write({
      externalId: "tags-preferred-log",
      activityId: preferred.id,
      climb: sharedClimb,
      attempts: [
        {
          scope: "climb",
          ropeMethod: "lead",
          sourceResult: "Send",
          qualifier: "free-send",
          fellOrHung: false,
          usedAid: false,
        },
      ],
    });
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "kaya",
      entries: [
        {
          externalId: "tags-other-log",
          activityId: other.id,
          climb: sharedClimb,
          attempts: [{ scope: "climb", ropeMethod: "lead" }],
          raw: { tags: [{ id: "technical", name: "Technical", tag_type_id: "6" }] },
        },
      ],
    });
    const details = (await repo().getActivityLogEntries(preferred.groupId)).map((entry) =>
      entry.toDetail(),
    );
    expect(details).toHaveLength(1);
    expect(details[0]?.providerId).toBe("openbeta");
    expect(details[0]?.tags).toEqual([
      {
        providerId: "kaya",
        sourceKey: "technical",
        label: "Technical",
        categoryKey: "6",
        categoryLabel: "Style",
      },
    ]);
  });
  it("retains private KAYA media provenance in Postgres while serving sanitized active and provider details", async () => {
    await ensureProvider(context.db, "kaya", "KAYA", undefined, userId);
    const raw = {
      photo: {
        photo_url: "https://upstream.test/private.jpg?token=secret",
        thumb_url: "https://upstream.test/thumb.jpg",
      },
      climb: { slug: "corner", color: "blue" },
      rating: 4,
    };
    const written = await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "kaya",
      entries: [
        {
          externalId: "kaya:ascent:private-photo",
          climbedOn: "2026-10-02",
          attempts: [{ scope: "climb" }],
          raw,
        },
      ],
    });
    const id = written.logEntryIds[0];
    if (!id) throw new Error("Expected KAYA log");
    const [active] = await repo().getLogEntries([id]);
    const provider = new ProviderDetailRepository(context.db, userId);
    const detail = await provider.getRecordDetail("kaya", "climbingLogEntries", id);
    expect(active?.toDetail().raw).toEqual({ climb: { slug: "corner", color: "blue" }, rating: 4 });
    expect(detail?.raw).toEqual({ climb: { slug: "corner", color: "blue" }, rating: 4 });
    const [retained] = await context.db
      .select({ raw: climbingLogEntry.raw })
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.id, id));
    expect(retained?.raw).toEqual(raw);
    await context.db
      .update(climbingLogEntry)
      .set({ providerAbsentAt: new Date() })
      .where(eq(climbingLogEntry.id, id));
    const absent = await provider.getRecordDetail("kaya", "climbingLogEntries", id);
    expect(absent?.raw).toEqual({ climb: { slug: "corner", color: "blue" }, rating: 4 });
  });
  it.each([null, "indoor", "outdoor"] as const)(
    "uses the canonical catalogue setting when the source setting is %s",
    async (setting) => {
      const log = await write({
        externalId: "catalogue-setting",
        discipline: "rock_climbing",
        climb: { ...route, setting },
        attempts: [{ scope: "climb", ropeMethod: "lead" }],
      });
      expect(log.climb?.setting).toBe(setting ?? "outdoor");
      if (!log.climbId) throw new Error("Expected a catalogue climb");
      const [stored] = await context.db
        .select({ setting: climb.setting })
        .from(climb)
        .where(eq(climb.id, log.climbId));
      expect(stored?.setting).toBe(setting);
    },
  );
  it("uses the same selected source graph as activity detail for equivalent cross-provider logs", async () => {
    await ensureProvider(context.db, "mountain-project", "Mountain Project", undefined, userId);
    const [first] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "openbeta",
        externalId: "equivalent-one",
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-10-02T10:00:00Z"),
      })
      .returning();
    if (!first?.groupId) throw new Error("Expected group");
    const [second] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "mountain-project",
        externalId: "equivalent-two",
        groupId: first.groupId,
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-10-02T10:00:00Z"),
      })
      .returning();
    if (!second) throw new Error("Expected member");
    await write({
      externalId: "equivalent-openbeta",
      activityId: first.id,
      climbedOn: "2026-10-02",
      climb: {
        ...route,
        coordinates: { latitude: 10, longitude: 10 },
        areas: [{ externalId: "crag", name: "Crag" }],
      },
      attempts: [{ scope: "climb", ropeMethod: "lead", sourceResult: "Unrecognized result" }],
    });
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "mountain-project",
      entries: [
        {
          externalId: "equivalent-mp",
          activityId: second.id,
          climbedOn: "2026-10-02",
          climb: {
            ...route,
            coordinates: { latitude: 40.007, longitude: -105.4 },
            areas: [{ externalId: "crag", name: "Crag" }],
          },
          attempts: [
            {
              scope: "climb",
              ropeMethod: "lead",
              sourceResult: "Send",
              qualifier: "free-send",
              usedAid: false,
              fellOrHung: false,
            },
          ],
        },
      ],
    });
    const detail = (await repo().getActivityLogEntries(first.groupId)).map((entry) =>
      entry.toDetail(),
    );
    expect(detail).toHaveLength(1);
    expect(detail[0]?.mapLocation?.providerId).toBe("mountain-project");
    expect((await repo().getActivityMapLocations([first.groupId])).get(first.groupId)).toEqual(
      detail.map((entry) => entry.mapLocation),
    );
  });
  it("batches native source points across canonical activity members without crossing ownership", async () => {
    const [first] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "openbeta",
        externalId: "map-session-one",
        canonicalType: "climbing",
        providerType: "rock-climbing",
        startedAt: new Date("2026-10-02T12:00:00Z"),
      })
      .returning();
    if (!first?.groupId) throw new Error("Expected canonical activity group");
    const [second] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId: "openbeta",
        externalId: "map-session-two",
        groupId: first.groupId,
        canonicalType: "climbing",
        providerType: "rock-climbing",
        startedAt: new Date("2026-10-02T12:00:00Z"),
      })
      .returning();
    if (!second) throw new Error("Expected second activity member");
    const exact = await write({
      externalId: "exact-map-log",
      activityId: first.id,
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
      climb: { ...route, coordinates: { latitude: 0, longitude: -122.25 } },
    });
    const areaLog = await write({
      externalId: "area-map-log",
      activityId: second.id,
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
      climb: {
        ...route,
        externalId: "area-route",
        areas: [
          {
            externalId: "outer-map-area",
            name: "Outer",
            coordinates: { latitude: 12, longitude: 0 },
          },
          {
            externalId: "near-map-area",
            name: "Nearest",
            coordinates: { latitude: 40.01, longitude: -105.28 },
          },
          { externalId: "unknown-map-wall", name: "Wall" },
        ],
      },
    });
    await write({
      externalId: "repeated-map-log",
      activityId: second.id,
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
      climb: { externalId: "area-route" },
    });
    await write({
      externalId: "no-map-log",
      activityId: first.id,
      title: "No GPS",
      attempts: [{ scope: "climb" }],
    });
    await write({
      externalId: "unattached-map-log",
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
      climb: {
        ...route,
        externalId: "unattached-route",
        coordinates: { latitude: 50, longitude: 50 },
      },
    });
    const locations = await repo().getActivityMapLocations([first.groupId]);
    expect(locations.get(first.groupId)).toEqual(
      expect.arrayContaining([exact.mapLocation, areaLog.mapLocation]),
    );
    expect(locations.get(first.groupId)).toHaveLength(2);
    expect(
      await new ClimbingActivityLogEntryRepository(
        context.db,
        "00000000-0000-4000-8000-000000000099",
        "UTC",
      ).getActivityMapLocations([first.groupId]),
    ).toEqual(new Map());
    await context.db
      .update(climbingLogEntry)
      .set({ providerAbsentAt: new Date() })
      .where(eq(climbingLogEntry.id, exact.id));
    expect((await repo().getActivityMapLocations([first.groupId])).get(first.groupId)).toEqual([
      areaLog.mapLocation,
    ]);
    await context.db
      .update(activity)
      .set({ deletedAt: new Date() })
      .where(eq(activity.id, second.id));
    expect(await repo().getActivityMapLocations([first.groupId])).toEqual(new Map());
  });
  it("projects native Climb points before the nearest native Area point", async () => {
    const first = await write({
      externalId: "mapped-log",
      climb: {
        ...route,
        coordinates: { latitude: 12, longitude: 0 },
        areas: [
          { externalId: "region", name: "Region", coordinates: { latitude: 40, longitude: -120 } },
          { externalId: "crag", name: "Crag", coordinates: { latitude: 0, longitude: -122.25 } },
          { externalId: "wall", name: "Wall" },
        ],
      },
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
    });
    expect(first.mapLocation).toEqual({
      coordinates: { latitude: 12, longitude: 0 },
      scope: "climb",
      objectId: first.climbId,
      providerId: "openbeta",
      name: "Route",
    });
    const updated = await write({
      externalId: "mapped-log",
      climb: { externalId: "route-one", coordinates: null },
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
    });
    expect(updated.climb?.areaPath.map((area) => area.name)).toEqual(["Region", "Crag", "Wall"]);
    const crag = updated.climb?.areaPath.find((area) => area.externalId === "crag");
    if (!crag) throw new Error("Expected source Crag");
    expect(updated.mapLocation).toEqual({
      coordinates: { latitude: 0, longitude: -122.25 },
      scope: "area",
      objectId: crag.id,
      providerId: "openbeta",
      name: "Crag",
    });
    expect(updated.climb?.coordinates).toBeNull();
  });

  it.each([
    { sourceResult: "Redpoint", outcome: "completed", labels: ["sent"] },
    { sourceResult: "failed", outcome: "failed", labels: [] },
    { sourceResult: null, outcome: "completed", labels: ["sent"] },
    { sourceResult: "Unrecognized result", outcome: null, labels: [] },
  ])("computes $outcome from stored source evidence", async ({ sourceResult, outcome, labels }) => {
    const before = await write({
      externalId: "source-result",
      discipline: "rock_climbing",
      climb: route,
      attempts: [{ scope: "climb", ropeMethod: "lead", fellOrHung: false, usedAid: false }],
    });
    await context.db.execute(sql`
      UPDATE fitness.climbing_attempt SET source_result = ${sourceResult}
      WHERE climbing_log_entry_id = ${before.id}::uuid
    `);
    const [entry] = await repo().getLogEntries([before.id]);
    expect(entry?.toDetail()).toMatchObject({
      recordedClimbAttemptCount: 1,
      recordedPitchAttemptCount: 0,
      recordedClimbOutcome: outcome,
      attempts: [{ outcome, rockResultLabels: labels }],
    });
  });
  it.each([
    {
      name: "clean completion",
      sourceResult: "completed",
      fellOrHung: false,
      usedAid: false,
      freeSend: true,
    },
    {
      name: "failed attempt",
      sourceResult: "failed",
      fellOrHung: null,
      usedAid: null,
      freeSend: false,
    },
    {
      name: "completion with a fall or hang",
      sourceResult: "completed",
      fellOrHung: true,
      usedAid: false,
      freeSend: false,
    },
    {
      name: "completion using aid",
      sourceResult: "completed",
      fellOrHung: false,
      usedAid: true,
      freeSend: false,
    },
    {
      name: "completion with unknown fall or hang",
      sourceResult: "completed",
      fellOrHung: null,
      usedAid: false,
      freeSend: null,
    },
    {
      name: "unknown outcome",
      sourceResult: "Unrecognized result",
      fellOrHung: false,
      usedAid: false,
      freeSend: null,
    },
    {
      name: "unlabeled OpenBeta completion",
      sourceResult: null,
      fellOrHung: null,
      usedAid: null,
      freeSend: true,
    },
  ])(
    "projects free-send evidence for $name",
    async ({ sourceResult, fellOrHung, usedAid, freeSend }) => {
      const log = await write({
        externalId: "free-send-evidence",
        discipline: "rock_climbing",
        climb: route,
        attempts: [{ scope: "climb", ropeMethod: "lead", sourceResult, fellOrHung, usedAid }],
      });
      expect(log).toMatchObject({ freeSend });
    },
  );
  it.each([{ outcomes: ["failed", "completed"] }, { outcomes: ["completed", "failed"] }] as const)(
    "retains a free send across mixed attempts $outcomes",
    async ({ outcomes }) => {
      const log = await write({
        externalId: "mixed-free-send-evidence",
        discipline: "rock_climbing",
        climb: route,
        attempts: outcomes.map((sourceResult, index) => ({
          scope: "climb",
          attemptIndex: index + 1,
          ropeMethod: "lead",
          sourceResult,
          fellOrHung: sourceResult === "failed",
          usedAid: false,
        })),
      });
      expect(log).toMatchObject({ freeSend: true, recordedClimbAttemptCount: 2 });
      expect(log.attempts.map((attempt) => attempt.outcome)).toEqual(outcomes);
    },
  );
  it("projects a completed pitch without claiming route completion", async () => {
    const log = await write({
      externalId: "pitch-only",
      discipline: "rock_climbing",
      climb: route,
      attempts: [
        {
          scope: "pitch",
          pitch: { number: 1 },
          ropeMethod: "lead",
          sourceResult: "Onsight",
          qualifier: "free-onsight",
        },
        { scope: "pitch", pitch: { number: 1 }, ropeMethod: "lead" },
      ],
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
        {
          scope: "climb",
          sourceKey: "whole",
          ropeMethod: "lead",
          sourceResult: "completed",
          usedAid: true,
        },
        {
          scope: "pitch",
          pitch: { number: 1 },
          parentSourceKey: "whole",
          ropeMethod: "lead",
          sourceResult: "completed",
        },
        { scope: "pitch", parentSourceKey: "whole", ropeMethod: "lead", sourceResult: "failed" },
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
        {
          scope: "pitch",
          ropeMethod: "lead",
          sourceResult: "completed",
          notes: "First unidentified pitch",
        },
        {
          scope: "pitch",
          ropeMethod: "lead",
          sourceResult: "failed",
          notes: "Another unidentified pitch",
        },
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
      attempts: [
        { scope: "climb", ropeMethod: "lead", sourceResult: "Send", qualifier: "free-send" },
      ],
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
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
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
      attempts: [{ scope: "climb", sourceResult: "completed" }],
    });
    expect(summit).toMatchObject({
      climbedOn: null,
      displayGrade: null,
      recordedClimbAttemptCount: 1,
      recordedClimbOutcome: "completed",
      freeSend: null,
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
      attempts: [
        {
          scope: "climb",
          sourceResult: "Dab",
          qualifier: "dab",
          fellOrHung: false,
          usedAid: false,
        },
      ],
    });
    expect(dab).toMatchObject({ recordedClimbOutcome: "completed", freeSend: false });
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
      attempts: [{ scope: "climb", sourceResult: "completed" }],
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
      climb: { ...route, coordinates: { latitude: 12, longitude: 0 } },
      attempts: [{ scope: "climb", ropeMethod: "lead" }],
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
    expect((await limited.getActivityMapLocations([outing.groupId])).get(outing.groupId)).toEqual([
      log.mapLocation,
    ]);
    const outside = new ClimbingActivityLogEntryRepository(
      context.db,
      userId,
      "America/Los_Angeles",
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-10-03",
        endDateExclusive: "2026-10-04",
      },
    );
    expect(await outside.getActivityMapLocations([outing.groupId])).toEqual(new Map());
  });
});
