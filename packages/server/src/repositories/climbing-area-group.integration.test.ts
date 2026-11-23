import { randomUUID } from "node:crypto";
import { groupClimbingLogEntriesByArea } from "@dofek/training/climbing-log-groups";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assertPostgresAccountErasureCoverage,
  erasePostgresAccount,
} from "../../../../src/account-erasure/postgres-erasure.ts";
import {
  persistClimbingLogEntries,
  type SourceClimbingLogEntry,
} from "../../../../src/db/climbing-log-sync.ts";
import {
  clearClimbingLogSyncTestContext,
  createClimbingLogSyncTestContext,
  CLIMBING_SYNC_OTHER_PROVIDER_ID as otherProviderId,
  CLIMBING_SYNC_OTHER_USER_ID as otherUserId,
  CLIMBING_SYNC_PROVIDER_ID as providerId,
} from "../../../../src/db/climbing-log-sync-test-helpers.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { area } from "../../../../src/db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import type { TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../../../../src/db/typed-sql.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";

describe("automatic climbing area groups", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await createClimbingLogSyncTestContext();
  });
  afterEach(async () => {
    await clearClimbingLogSyncTestContext(context);
    await context.db.delete(activity).where(eq(activity.providerId, providerId));
  });
  afterAll(async () => {
    await context.cleanup();
  });

  const entry = (name: string): SourceClimbingLogEntry => ({
    externalId: "log",
    climbedOn: "2026-11-09",
    climb: { externalId: "problem", name: "Problem", areas: [{ externalId: "gym", name }] },
    attempts: [{ scope: "climb" }],
  });
  const write = (provider: string, source: SourceClimbingLogEntry, owner = userId) =>
    persistClimbingLogEntries(context.db, {
      userId: owner,
      providerId: provider,
      entries: [source],
    });
  const repository = () => new ClimbingActivityLogEntryRepository(context.db, userId, "UTC");

  async function climbingActivity(externalId: string) {
    const [record] = await context.db
      .insert(activity)
      .values({
        userId,
        providerId,
        externalId,
        canonicalType: "climbing",
        providerType: "climbing",
        startedAt: new Date("2026-11-22T22:00:00Z"),
      })
      .returning({ id: activity.id, groupId: activity.groupId });
    if (!record) throw new Error("Expected a climbing activity");
    return record;
  }

  it("groups the Picnic Table Wall climbs from both sources on an attached activity", async () => {
    const record = await climbingActivity("berkeley-outing");
    const shortPath = ["Berkeley", "Indian Rock", "Picnic Table Wall"];
    const longPath = [
      "California",
      "San Francisco Bay Area",
      "East Bay Area",
      "Berkeley",
      "Indian Rock Park",
      "Picnic Table Wall",
    ];
    const sources = [
      {
        provider: providerId,
        names: shortPath,
        climbs: ["Picnic Traverse", "Overhang Variations", "Face Variations"],
      },
      { provider: providerId, names: [...shortPath.slice(0, -1), "Ape"], climbs: ["Ape Overhang"] },
      { provider: otherProviderId, names: longPath, climbs: ["The Roof", "Left Route"] },
    ];
    for (const { provider, names, climbs } of sources) {
      const areas = names.map((name) => ({ externalId: name, name }));
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId: provider,
        entries: climbs.map((name) => ({
          externalId: name,
          activityId: record.id,
          climbedOn: "2026-11-22",
          climb: {
            externalId: name,
            name,
            kind: "boulder",
            setting: provider === providerId ? "outdoor" : null,
            areas,
          },
          attempts: [],
        })),
      });
    }
    const logs = (await repository().getActivityLogEntries(record.groupId)).map((log) =>
      log.toDetail(),
    );
    const groups = groupClimbingLogEntriesByArea(logs);
    expect(groups.map((group) => [group.area?.name, group.entries.length])).toEqual(
      expect.arrayContaining([
        ["Picnic Table Wall", 5],
        ["Ape", 1],
      ]),
    );
    expect(groups).toHaveLength(2);
    expect(logs.filter((log) => log.providerId === otherProviderId)).toHaveLength(2);
    for (const log of logs.filter((log) => log.providerId === otherProviderId)) {
      expect(log.areaPath?.map((source) => source.name)).toEqual(longPath);
    }
  });

  it("keeps same-name logs with different recorded paths under one display heading", async () => {
    const record = await climbingActivity("shared-heading");
    for (const [provider, names] of [
      [providerId, ["Berkeley", "Indian Rock", "Wall"]],
      [otherProviderId, ["California", "Berkeley", "Indian Rock Park", "Wall"]],
    ] as const) {
      await write(provider, {
        externalId: "route-log",
        activityId: record.id,
        climbedOn: "2026-11-22",
        areas: names.map((name) => ({ externalId: name, name })),
        climb: {
          externalId: "route",
          name: "Corner",
          kind: "route",
          setting: "outdoor",
          areas: [{ externalId: "catalogue-wall", name: "Wall" }],
          publishedGrades: [{ value: "5.10a", system: "yds" }],
        },
        attempts: [{ scope: "climb" }],
      });
    }
    const logs = (await repository().getActivityLogEntries(record.groupId)).map((log) =>
      log.toDetail(),
    );
    expect(logs.map((log) => log.providerId).sort()).toEqual([otherProviderId, providerId]);
    expect(groupClimbingLogEntriesByArea(logs)).toHaveLength(1);
  });

  it.each([
    {
      scenario: "unpinned gyms",
      providers: [providerId, otherProviderId],
      coordinates: null,
      expectedCount: 2,
    },
    {
      scenario: "competing gym matches",
      providers: [providerId, providerId, otherProviderId],
      coordinates: { latitude: 37.81644, longitude: -122.28852 },
      expectedCount: 3,
    },
    {
      scenario: "one corroborated gym",
      providers: [providerId, otherProviderId],
      coordinates: { latitude: 37.81644, longitude: -122.28852 },
      expectedCount: 1,
    },
  ])(
    "consolidates same-name gym routes with $scenario",
    async ({ providers, coordinates, expectedCount }) => {
      const record = await climbingActivity("same-name-gyms");
      for (const [index, provider] of providers.entries()) {
        await write(provider, {
          externalId: `log-${index}`,
          activityId: record.id,
          climbedOn: "2026-11-22",
          climb: {
            externalId: `route-${index}`,
            name: "Corner",
            kind: "route",
            setting: "indoor",
            areas: [{ externalId: `wall-${index}`, name: "Main Wall", coordinates }],
            publishedGrades: [{ value: "5.10a", system: "yds" }],
          },
          attempts: [{ scope: "climb" }],
        });
      }
      const logs = await repository().getActivityLogEntries(record.groupId);
      expect(logs).toHaveLength(expectedCount);
    },
  );

  it("groups nearby gyms with different source names", async () => {
    for (const [provider, name, latitude] of [
      [providerId, "Touchstone Pacific Pipe", 37.815355],
      [otherProviderId, "Pacific Pipe Climbing", 37.81644],
    ] as const) {
      await write(provider, {
        ...entry(name),
        climb: { externalId: "problem", setting: "indoor" },
        areas: [{ externalId: "gym", name, coordinates: { latitude, longitude: -122.28852 } }],
      });
    }
    const projected = await repository().getUnattachedLogEntriesForDate("2026-11-09");
    expect(groupClimbingLogEntriesByArea(projected)).toHaveLength(1);
    expect(projected.map((log) => log.areaPath?.[0]?.name).sort()).toEqual([
      "Pacific Pipe Climbing",
      "Touchstone Pacific Pipe",
    ]);
  });

  it("resolves a standalone unlocated log from an unselected exact session peer", async () => {
    await write(providerId, {
      externalId: "located",
      climbedOn: "2026-11-09",
      areas: [
        {
          externalId: "gym",
          name: "Pacific Pipe",
          coordinates: { latitude: 37.81644, longitude: -122.28852 },
        },
      ],
      climb: { externalId: "known-problem", setting: "indoor" },
      raw: { sessionId: "source-session" },
      attempts: [],
    });
    const raw = { sessionId: "source-session", boardId: null };
    const saved = await write(providerId, {
      externalId: "unlocated",
      climbedOn: "2026-11-09",
      climb: { externalId: "other-problem", setting: "indoor" },
      raw,
      attempts: [],
    });
    const id = saved.logEntryIds[0];
    if (!id) throw new Error("Expected stored log");
    const projected = await repository().getProviderLogEntry(providerId, id);
    expect(projected?.areaPath?.map((source) => source.name)).toEqual(["Pacific Pipe"]);
    expect(projected?.mapLocation).toMatchObject({ name: "Pacific Pipe", scope: "area" });
    expect(projected?.raw).toEqual(raw);
    const stored = await executeWithSchema(
      context.db,
      z.object({ area_id: z.null(), raw: z.json() }),
      sql`SELECT area_id,raw FROM fitness.climbing_log_entry WHERE id=${id}::uuid`,
    );
    expect(stored).toEqual([{ area_id: null, raw }]);

    await write(providerId, {
      externalId: "second-gym",
      climbedOn: "2026-11-08",
      areas: [{ externalId: "other-gym", name: "Another gym" }],
      climb: { externalId: "another-problem", setting: "indoor" },
      raw: { sessionId: "source-session" },
      attempts: [],
    });
    const ambiguous = await repository().getProviderLogEntry(providerId, id);
    expect(ambiguous?.areaPath).toEqual([]);
    expect(ambiguous?.mapLocation).toBeNull();
  });

  it.each([
    "absent",
    "other-owner",
    "other-provider",
    "other-session",
    "outside-access",
    "deleted-activity",
  ] as const)("excludes an %s source-session peer from location recovery", async (reason) => {
    const located = await write(
      reason === "other-provider" ? otherProviderId : providerId,
      {
        externalId: "located-peer",
        climbedOn: reason === "outside-access" ? "2026-11-08" : "2026-11-09",
        activityObservation:
          reason === "deleted-activity" ? { recordedAt: "2026-11-09T12:00:00Z" } : undefined,
        areas: [{ externalId: "gym", name: "Pacific Pipe" }],
        climb: { externalId: "located-problem", setting: "indoor" },
        raw: { session_id: reason === "other-session" ? "other-session" : "source-session" },
        attempts: [],
      },
      reason === "other-owner" ? otherUserId : userId,
    );
    const locatedId = located.logEntryIds[0];
    if (!locatedId) throw new Error("Expected stored peer");
    if (reason === "absent")
      await context.db.execute(
        sql`UPDATE fitness.climbing_log_entry SET provider_absent_at=now() WHERE id=${locatedId}::uuid`,
      );
    if (reason === "deleted-activity")
      await context.db.execute(
        sql`UPDATE fitness.activity SET deleted_at=now() WHERE id=(SELECT activity_id FROM fitness.climbing_log_entry WHERE id=${locatedId}::uuid)`,
      );
    const saved = await write(providerId, {
      externalId: "unlocated-log",
      climbedOn: "2026-11-09",
      climb: { externalId: "unlocated-problem", setting: "indoor" },
      raw: { session_id: "source-session" },
      attempts: [],
    });
    const id = saved.logEntryIds[0];
    if (!id) throw new Error("Expected stored log");
    const projected = await new ClimbingActivityLogEntryRepository(context.db, userId, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-11-09",
      endDateExclusive: "2026-11-10",
    }).getProviderLogEntry(providerId, id);
    expect(projected?.areaPath).toEqual([]);
    expect(projected?.mapLocation).toBeNull();
  });

  it.each([true, false])(
    "preserves native climb coordinates with a session peer pin: %s",
    async (hasCoordinates) => {
      await write(providerId, {
        externalId: "located-area",
        climbedOn: "2026-11-09",
        areas: [
          {
            externalId: "gym",
            name: "Pacific Pipe",
            coordinates: hasCoordinates ? { latitude: 37.81644, longitude: -122.28852 } : null,
          },
        ],
        climb: { externalId: "located-problem", setting: "indoor" },
        raw: { sessionId: "source-session" },
        attempts: [],
      });
      const saved = await write(providerId, {
        externalId: "native-location",
        climbedOn: "2026-11-09",
        climb: {
          externalId: "native-problem",
          setting: "indoor",
          coordinates: { latitude: 38, longitude: -122 },
        },
        raw: { sessionId: "source-session" },
        attempts: [],
      });
      const id = saved.logEntryIds[0];
      if (!id) throw new Error("Expected stored log");
      const projected = await repository().getProviderLogEntry(providerId, id);
      expect(projected?.areaPath).toEqual([]);
      expect(projected?.mapLocation).toMatchObject({
        coordinates: { latitude: 38, longitude: -122 },
        scope: "climb",
        providerId,
      });
    },
  );

  it("uses the log's recorded area for grouping before its catalogue area", async () => {
    const source = {
      ...entry("Catalogue gym"),
      areas: [{ externalId: "logged-gym", name: "Recorded gym" }],
    };
    await write(providerId, source);
    const [log] = await repository().getUnattachedLogEntriesForDate("2026-11-09");
    if (!log) throw new Error("Expected projected log");
    expect(log.areaGroupId).toBe(log.areaPath?.at(-1)?.id);
    expect(log).toMatchObject({
      areaPath: [expect.objectContaining({ name: "Recorded gym" })],
      climb: { areaPath: [expect.objectContaining({ name: "Catalogue gym" })] },
    });
  });

  it("erases source areas for the requested account and retains another owner's areas", async () => {
    await write(providerId, entry("Erased gym"), otherUserId);
    await write(providerId, entry("Retained gym"));
    await expect(assertPostgresAccountErasureCoverage(context.db)).resolves.toBeUndefined();
    const requestId = randomUUID();
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_request(id,user_id,user_hash,user_hash_key_id,write_fence_hash,status_token_hash,replay_retained_until,completion_deadline) VALUES(${requestId}::uuid,${otherUserId}::uuid,${"1".repeat(64)},'test-key',${"2".repeat(64)},${"3".repeat(64)},now()+interval '7 days',now()+interval '30 days')`,
    );
    await erasePostgresAccount(context.db, requestId, otherUserId);
    expect(await context.db.select().from(area).where(eq(area.userId, otherUserId))).toEqual([]);
    expect(
      await context.db.select({ name: area.name }).from(area).where(eq(area.userId, userId)),
    ).toEqual([{ name: "Retained gym" }]);
    const logs = await repository().getUnattachedLogEntriesForDate("2026-11-09");
    expect(logs.map((log) => log.areaPath?.at(-1)?.name)).toEqual(["Retained gym"]);
  });
});
