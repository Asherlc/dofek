import { gradeComponentSchema } from "@dofek/training/climbing-log";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { persistClimbingLogEntries, type SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import {
  area,
  climb,
  climbGrade,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
  pitchGrade,
} from "./schema/climbing.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

const providerId = "climbing-sync-test";
const otherProviderId = "climbing-sync-other";
const otherUserId = "00000000-0000-4000-8000-000000001997";
const projectionSchema = z.object({
  published_grades: z.array(gradeComponentSchema),
  area_path: z.array(z.object({ name: z.string() })),
});
describe("atomic climbing log synchronization", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name) VALUES
      (${providerId}, 'Climbing sync test'), (${otherProviderId}, 'Other climbing sync test')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name) VALUES (${otherUserId}::uuid, 'Other climbing owner')
    `);
  });
  afterEach(async () => {
    const scope = inArray(climbingLogEntry.providerId, [providerId, otherProviderId]);
    await context.db.delete(climbingLogEntry).where(scope);
    await context.db.delete(climb).where(inArray(climb.providerId, [providerId, otherProviderId]));
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area).where(inArray(area.providerId, [providerId, otherProviderId]));
  });
  afterAll(async () => {
    await context.cleanup();
  });
  function write(entries: readonly SourceClimbingLogEntry[]) {
    return persistClimbingLogEntries(context.db, { userId: TEST_USER_ID, providerId, entries });
  }
  async function attempts(logEntryId: string) {
    return context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, logEntryId))
      .orderBy(asc(climbingAttempt.id));
  }
  it("replaces ordered published collections without changing reported grades", async () => {
    const source: SourceClimbingLogEntry = {
      externalId: "grades:log",
      climb: {
        externalId: "grades:route",
        kind: "route",
        publishedGrades: [
          { value: "5.12a", system: "yds" },
          { value: "A3", system: "aid" },
        ],
        pitches: [
          {
            externalId: "grades:pitch",
            number: 1,
            publishedGrades: [{ value: "5.11a", system: "yds" }],
          },
        ],
      },
      reportedGrades: [{ value: "5.12b", system: "yds" }],
      attempts: [{ scope: "climb" }],
    };
    const first = await write([source]);
    const [log] = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.id, first.logEntryIds[0] ?? ""));
    if (!log?.climbId) throw new Error("Expected located graded log");
    await write([
      {
        externalId: source.externalId,
        climb: { externalId: "grades:route" },
        attempts: [{ scope: "climb" }],
      },
    ]);
    expect(
      await context.db
        .select({ value: climbGrade.value, system: climbGrade.system })
        .from(climbGrade)
        .where(eq(climbGrade.climbId, log.climbId))
        .orderBy(climbGrade.position),
    ).toEqual([
      { value: "5.12a", system: "yds" },
      { value: "A3", system: "aid" },
    ]);
    await write([
      {
        externalId: "grades:other",
        climb: {
          externalId: "grades:route",
          publishedGrades: [
            { value: "A4-", system: "aid" },
            { value: "5.12c", system: "yds" },
          ],
        },
        attempts: [{ scope: "climb" }],
      },
    ]);
    expect(
      await context.db
        .select({ value: climbingLogEntryGrade.value })
        .from(climbingLogEntryGrade)
        .where(eq(climbingLogEntryGrade.climbingLogEntryId, log.id)),
    ).toEqual([{ value: "5.12b" }]);
    expect((await context.db.select().from(pitchGrade))[0]).toMatchObject({
      value: "5.11a",
      system: "yds",
    });
    await write([
      {
        externalId: source.externalId,
        climb: { externalId: "grades:route", publishedGrades: [] },
        reportedGrades: [],
        attempts: [{ scope: "climb" }],
      },
    ]);
    expect(
      await context.db.select().from(climbGrade).where(eq(climbGrade.climbId, log.climbId)),
    ).toHaveLength(0);
    expect(
      await context.db
        .select()
        .from(climbingLogEntryGrade)
        .where(eq(climbingLogEntryGrade.climbingLogEntryId, log.id)),
    ).toHaveLength(0);
  });

  it("reconciles pitch counts without synthetic whole tries and preserves grouping UUIDs", async () => {
    const source: SourceClimbingLogEntry = {
      externalId: "pitch:only",
      climb: {
        externalId: "pitch:route",
        kind: "route",
        pitches: [{ externalId: "pitch:first", number: 1 }],
      },
      attempts: [
        {
          scope: "pitch",
          pitch: { externalId: "pitch:first" },
          sourceResult: "completed",
          ropeMethod: "lead",
          solo: true,
          hadCompletedBefore: true,
        },
      ],
      reportedAttemptCounts: [{ scope: "pitch", pitch: { externalId: "pitch:first" }, count: 3 }],
    };
    const first = await write([source]);
    const id = first.logEntryIds[0];
    if (!id) throw new Error("Expected pitch log");
    const before = await attempts(id);
    expect(before).toHaveLength(3);
    expect(before.map((a) => a.scope)).toEqual(["pitch", "pitch", "pitch"]);
    await write([source]);
    expect(await attempts(id)).toEqual(before);
    const grouped: SourceClimbingLogEntry = {
      externalId: "pitch:group",
      climb: source.climb,
      attempts: [
        { scope: "climb", sourceKey: "whole", sourceResult: "completed" },
        {
          scope: "pitch",
          pitch: { number: 1 },
          parentSourceKey: "whole",
          sourceResult: "completed",
        },
        { scope: "pitch", parentSourceKey: "whole", notes: "Unidentified pitch" },
      ],
    };
    const second = await write([grouped]);
    const groupId = second.logEntryIds[0];
    if (!groupId) throw new Error("Expected grouped log");
    const groupBefore = await attempts(groupId);
    const parent = groupBefore.find((a) => a.scope === "climb");
    expect(parent).toBeDefined();
    expect(groupBefore.filter((a) => a.scope === "pitch").map((a) => a.parentAttemptId)).toEqual([
      parent?.id,
      parent?.id,
    ]);
    await write([grouped]);
    expect(await attempts(groupId)).toEqual(groupBefore);
  });

  it("preserves a known pitch and parent when a partial source omits their references", async () => {
    const first = await write([
      {
        externalId: "pitch:partial",
        climb: {
          externalId: "pitch:partial-route",
          pitches: [{ externalId: "pitch:partial-one", number: 1 }],
        },
        attempts: [
          { scope: "climb", sourceKey: "whole" },
          {
            scope: "pitch",
            pitch: { number: 1 },
            parentSourceKey: "whole",
            notes: "Recorded pitch",
          },
        ],
      },
    ]);
    const id = first.logEntryIds[0];
    if (!id) throw new Error("Expected partial pitch log");
    const before = await attempts(id);
    const child = before.find((row) => row.scope === "pitch");
    await write([
      {
        externalId: "pitch:partial",
        attempts: [{ scope: "pitch", notes: "Recorded pitch", solo: true }],
      },
    ]);
    const after = await attempts(id);
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.scope === "pitch")).toMatchObject({
      id: child?.id,
      pitchId: child?.pitchId,
      parentAttemptId: child?.parentAttemptId,
      notes: "Recorded pitch",
      solo: true,
    });
  });
  it.each([" rEdPoInT ", "Send"])(
    "preserves pitch grouping when the raw result label changes to %s",
    async (sourceResult) => {
      const source: SourceClimbingLogEntry = {
        externalId: "pitch:result-refresh",
        climb: {
          externalId: "pitch:result-route",
          pitches: [{ externalId: "pitch:result-one", number: 1 }],
        },
        attempts: [
          { scope: "climb", sourceKey: "whole" },
          {
            scope: "pitch",
            pitch: { number: 1 },
            parentSourceKey: "whole",
            sourceResult: "Redpoint",
          },
        ],
        reportedAttemptCounts: [{ scope: "climb", count: 2 }],
      };
      const result = await write([source]);
      const id = result.logEntryIds[0];
      if (!id) throw new Error("Expected the grouped log");
      const before = await attempts(id);
      const child = before.find((row) => row.scope === "pitch");
      const otherWhole = before.find(
        (row) => row.scope === "climb" && row.id !== child?.parentAttemptId,
      );
      if (!child?.parentAttemptId || !otherWhole)
        throw new Error("Expected two whole occurrences and a grouped pitch");
      await context.db
        .update(climbingAttempt)
        .set({ createdAt: new Date("2000-01-01T00:00:00Z") })
        .where(eq(climbingAttempt.id, otherWhole.id));
      await write([
        {
          ...source,
          attempts: source.attempts.map((attempt) =>
            attempt.scope === "pitch" ? { ...attempt, sourceResult } : attempt,
          ),
        },
      ]);
      const after = await attempts(id);
      expect(after).toHaveLength(3);
      expect(after.find((row) => row.id === child.id)).toMatchObject({
        sourceResult,
        parentAttemptId: child.parentAttemptId,
        pitchId: child.pitchId,
      });
    },
  );

  it("protects false array history and grouping facts from count correction", async () => {
    const source: SourceClimbingLogEntry = {
      externalId: "facts:protected",
      attempts: [
        { scope: "climb", solo: false },
        { scope: "climb", protectionUsed: ["trad"] },
        { scope: "climb", hadCompletedBefore: false },
      ],
      reportedAttemptCounts: [{ scope: "climb", count: 4 }],
    };
    const first = await write([source]);
    const id = first.logEntryIds[0];
    if (!id) throw new Error("Expected protected facts");
    const before = await attempts(id);
    await expect(
      write([
        {
          externalId: source.externalId,
          attempts: [{ scope: "climb" }],
          reportedAttemptCounts: [{ scope: "climb", count: 2 }],
        },
      ]),
    ).rejects.toThrow("recorded attempts");
    expect(await attempts(id)).toEqual(before);
  });

  it.each([false, true])(
    "resolves target-specific Flash history before batch order reverse=%s",
    async (reverse) => {
      const definition = {
        externalId: "history:route",
        kind: "route" as const,
        pitches: [
          { externalId: "history:one", number: 1 },
          { externalId: "history:two", number: 2 },
        ],
      };
      const flash: SourceClimbingLogEntry = {
        externalId: "history:flash",
        climb: definition,
        attempts: [
          {
            scope: "pitch",
            pitch: { number: 1 },
            qualifier: "free-flash",
            sourceResult: "completed",
          },
        ],
      };
      const unrelated: SourceClimbingLogEntry = {
        externalId: "history:other",
        climb: definition,
        attempts: [{ scope: "climb" }, { scope: "pitch", pitch: { number: 2 } }],
      };
      const result = await write(reverse ? [unrelated, flash] : [flash, unrelated]);
      const id = result.logEntryIds[reverse ? 1 : 0];
      if (!id) throw new Error("Expected Flash log");
      expect((await attempts(id))[0]).toMatchObject({
        scope: "pitch",
        attemptIndex: 1,
        receivedBeta: true,
      });
      await write([flash]);
      expect((await attempts(id))[0]?.receivedBeta).toBe(true);
      const otherFlash: SourceClimbingLogEntry = {
        externalId: "history:second-flash",
        climb: definition,
        attempts: [
          {
            scope: "pitch",
            pitch: { number: 1 },
            qualifier: "free-flash",
            sourceResult: "completed",
          },
        ],
      };
      const later = await write([otherFlash]);
      expect((await attempts(later.logEntryIds[0] ?? ""))[0]?.receivedBeta).toBeNull();
    },
  );

  it("expands count summaries without duplicating tries on resync", async () => {
    const source: SourceClimbingLogEntry = {
      externalId: "occurrence:count",
      attempts: [{ scope: "climb" as const }],
      reportedAttemptCounts: [{ scope: "climb" as const, count: 4 }],
    };
    const first = await write([source]);
    const id = first.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    const before = await attempts(id);
    expect(before).toHaveLength(4);
    expect(
      before.map((a) => [a.attemptIndex, a.sourceResult, a.fellOrHung, a.receivedBeta]),
    ).toEqual(Array(4).fill([null, null, null, null]));
    const second = await write([source]);
    expect(second).toEqual({ logEntryIds: [id], recordsSynced: 1 });
    expect((await attempts(id)).map((a) => a.id)).toEqual(before.map((a) => a.id));
  });
  it("uses one recorded occurrence when count is absent", async () => {
    const result = await write([
      { externalId: "occurrence:unknown", attempts: [{ scope: "climb" as const }] },
    ]);
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    expect(await attempts(id)).toHaveLength(1);
    expect((await attempts(id))[0]).toMatchObject({ sourceResult: null, attemptIndex: null });
  });
  it("preserves aid first-try facts when a later qualified response omits method", async () => {
    const first = await write([
      {
        externalId: "aid:first",
        climb: { externalId: "aid:route" },
        attempts: [
          { scope: "climb" as const, qualifier: "aid-onsight" as const, sourceResult: "completed" },
        ],
      },
    ]);
    const id = first.logEntryIds[0];
    if (!id) throw new Error("Expected aid log");
    const before = await attempts(id);
    expect(before).toEqual([
      expect.objectContaining({
        sourceResult: "completed",
        fellOrHung: null,
        usedAid: true,
        receivedBeta: false,
        attemptIndex: 1,
      }),
    ]);
    await write([
      {
        externalId: "aid:first",
        attempts: [
          { scope: "climb" as const, qualifier: "aid-onsight" as const, sourceResult: "completed" },
        ],
      },
    ]);
    expect(await attempts(id)).toEqual(before);
  });
  it("preserves known facts when later responses omit them", async () => {
    const source: SourceClimbingLogEntry = {
      externalId: "occurrence:detailed",
      climbedOn: "2026-10-01",
      notes: "Source note",
      climb: {
        externalId: "route:known",
        name: "Known climb",
        coordinates: { latitude: 37.5, longitude: -122.25 },
      },
      attempts: [
        {
          scope: "climb" as const,
          sourceResult: "completed",
          fellOrHung: false,
          usedAid: false,
          receivedBeta: false,
          notes: "First try note",
        },
      ],
    };
    const result = await write([source]);
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    const original = (await attempts(id))[0];
    await write([
      {
        externalId: source.externalId,
        climb: { externalId: "route:known" },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    expect((await attempts(id))[0]).toEqual(original);
    const [log] = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.id, id));
    expect(log).toMatchObject({ climbedOn: "2026-10-01", notes: "Source note" });
    const [definition] = await context.db
      .select()
      .from(climb)
      .where(eq(climb.externalId, "route:known"));
    expect(definition).toMatchObject({ name: "Known climb", coordinates: { x: -122.25, y: 37.5 } });
    await write([
      {
        externalId: source.externalId,
        climbedOn: null,
        notes: null,
        climb: { externalId: "route:known", coordinates: null },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const [cleared] = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.id, id));
    expect(cleared).toMatchObject({ climbedOn: null, notes: null });
    const [clearedClimb] = await context.db
      .select()
      .from(climb)
      .where(eq(climb.externalId, "route:known"));
    expect(clearedClimb?.coordinates).toBeNull();
  });
  it.each([" rEdPoInT ", "Send"])(
    "updates the same described occurrence when its raw result changes to %s",
    async (sourceResult) => {
      const source: SourceClimbingLogEntry = {
        externalId: "result:refresh",
        attempts: [{ scope: "climb", sourceResult: "Redpoint", fellOrHung: false, usedAid: false }],
        reportedAttemptCounts: [{ scope: "climb", count: 3 }],
      };
      const result = await write([source]);
      const id = result.logEntryIds[0];
      if (!id) throw new Error("Expected the source log");
      const original = (await attempts(id)).find((row) => row.sourceResult !== null);
      if (!original) throw new Error("Expected the described attempt");
      await write([
        { ...source, attempts: [{ ...source.attempts[0], scope: "climb", sourceResult }] },
      ]);
      const refreshed = await attempts(id);
      expect(refreshed).toHaveLength(3);
      expect(refreshed.find((row) => row.sourceResult !== null)).toMatchObject({
        id: original.id,
        sourceResult,
      });
      expect(refreshed.filter((row) => row.sourceResult === null)).toHaveLength(2);
      await write([{ externalId: source.externalId, attempts: [{ scope: "climb" }] }]);
      expect((await attempts(id)).find((row) => row.id === original.id)?.sourceResult).toBe(
        sourceResult,
      );
    },
  );
  it("rejects a count below described evidence", async () => {
    const result = await write([
      {
        externalId: "occurrence:described",
        attempts: [
          { scope: "climb" as const, notes: "One" },
          { scope: "climb" as const, notes: "Two" },
        ],
        reportedAttemptCounts: [{ scope: "climb" as const, count: 3 }],
      },
    ]);
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    const before = await attempts(id);
    await expect(
      write([
        {
          externalId: "occurrence:described",
          attempts: [{ scope: "climb" as const }],
          reportedAttemptCounts: [{ scope: "climb" as const, count: 1 }],
        },
      ]),
    ).rejects.toThrow("recorded attempts");
    expect(await attempts(id)).toEqual(before);
  });
  it("removes only surplus unknown rows on a verified count correction", async () => {
    const result = await write([
      {
        externalId: "occurrence:corrected",
        attempts: [{ scope: "climb" as const, notes: "Described try", sourceResult: "failed" }],
        reportedAttemptCounts: [{ scope: "climb" as const, count: 4 }],
      },
    ]);
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    const described = (await attempts(id)).find((a) => a.notes === "Described try");
    await write([
      {
        externalId: "occurrence:corrected",
        attempts: [{ scope: "climb" as const }],
        reportedAttemptCounts: [{ scope: "climb" as const, count: 2 }],
      },
    ]);
    expect(await attempts(id)).toHaveLength(2);
    expect((await attempts(id)).find((a) => a.notes === "Described try")).toEqual(described);
    await write([{ externalId: "occurrence:corrected", attempts: [{ scope: "climb" as const }] }]);
    expect(await attempts(id)).toHaveLength(2);
  });
  it("rejects ambiguous new detail when described and unknown tries cannot be distinguished", async () => {
    const result = await write([
      {
        externalId: "occurrence:ambiguous",
        attempts: [{ scope: "climb" as const, notes: "Previously described try" }],
        reportedAttemptCounts: [{ scope: "climb" as const, count: 3 }],
      },
    ]);
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    const before = await attempts(id);
    await expect(
      write([
        {
          externalId: "occurrence:ambiguous",
          attempts: [{ scope: "climb" as const, notes: "Changed unidentified try" }],
          reportedAttemptCounts: [{ scope: "climb" as const, count: 3 }],
        },
      ]),
    ).rejects.toThrow("ambiguously");
    expect(await attempts(id)).toEqual(before);
  });
  it("fills an unknown try when its actual order distinguishes it from described tries", async () => {
    const result = await write([
      {
        externalId: "occurrence:known-order",
        attempts: [{ scope: "climb" as const, attemptIndex: 1, notes: "First try" }],
        reportedAttemptCounts: [{ scope: "climb" as const, count: 3 }],
      },
    ]);
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    const first = (await attempts(id)).find((a) => a.attemptIndex === 1);
    await write([
      {
        externalId: "occurrence:known-order",
        attempts: [{ scope: "climb" as const, attemptIndex: 3, notes: "Third try" }],
        reportedAttemptCounts: [{ scope: "climb" as const, count: 3 }],
      },
    ]);
    expect((await attempts(id)).find((a) => a.attemptIndex === 1)).toEqual(first);
    expect((await attempts(id)).find((a) => a.attemptIndex === 3)?.notes).toBe("Third try");
    expect(await attempts(id)).toHaveLength(3);
  });
  it("excludes self history from flash beta inference", async () => {
    const source: SourceClimbingLogEntry = {
      externalId: "occurrence:flash",
      climb: { externalId: "route:flash" },
      attempts: [
        { scope: "climb" as const, qualifier: "free-flash" as const, sourceResult: "completed" },
      ],
    };
    const result = await write([source]);
    const id = result.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    const before = (await attempts(id))[0];
    expect(before).toMatchObject({
      sourceResult: "completed",
      fellOrHung: false,
      usedAid: false,
      receivedBeta: true,
      attemptIndex: 1,
    });
    await write([source]);
    expect((await attempts(id))[0]).toEqual(before);
  });
  it.each([false, true])(
    "resolves other batch history before Flash inference, reversed=%s",
    async (reversed) => {
      const source: SourceClimbingLogEntry[] = [
        {
          externalId: "occurrence:prior",
          climb: { externalId: "route:shared" },
          attempts: [{ scope: "climb" }],
        },
        {
          externalId: "occurrence:later",
          climb: { externalId: "route:shared" },
          attempts: [{ scope: "climb", qualifier: "free-flash", sourceResult: "completed" }],
        },
      ];
      await write(reversed ? [...source].reverse() : source);
      const [log] = await context.db
        .select()
        .from(climbingLogEntry)
        .where(eq(climbingLogEntry.externalId, "occurrence:later"));
      if (!log) throw new Error("Expected a Flash log");
      expect((await attempts(log.id))[0]).toMatchObject({ receivedBeta: null, attemptIndex: 1 });
    },
  );
  it("keeps completion fall hang and actual order independent", async () => {
    await write([
      {
        externalId: "occurrence:onsight",
        climb: { externalId: "route:onsight", kind: "route" },
        attempts: [
          {
            scope: "climb" as const,
            qualifier: "free-onsight" as const,
            sourceResult: "completed",
          },
        ],
      },
      {
        externalId: "occurrence:hung",
        attempts: [{ scope: "climb" as const, qualifier: "fell-hung" as const }],
      },
      {
        externalId: "occurrence:summit",
        attempts: [{ scope: "climb" as const, sourceResult: "completed" }],
      },
      {
        externalId: "occurrence:unknown-order",
        attempts: [{ scope: "climb" as const }],
        reportedAttemptCounts: [{ scope: "climb" as const, count: 2 }],
      },
    ]);
    const logs = await context.db.select().from(climbingLogEntry);
    for (const log of logs) {
      const rows = await attempts(log.id);
      if (log.externalId === "occurrence:onsight")
        expect(rows[0]).toMatchObject({
          sourceResult: "completed",
          fellOrHung: false,
          usedAid: false,
          receivedBeta: false,
          attemptIndex: 1,
        });
      if (log.externalId === "occurrence:hung")
        expect(rows[0]).toMatchObject({ sourceResult: null, fellOrHung: true });
      if (log.externalId === "occurrence:summit")
        expect(rows[0]).toMatchObject({ sourceResult: "completed", fellOrHung: null });
      if (log.externalId === "occurrence:unknown-order")
        expect(rows.map((a) => a.attemptIndex)).toEqual([null, null]);
    }
  });
  it("reuses local objects only through the same occurrence", async () => {
    const first: SourceClimbingLogEntry = {
      externalId: "occurrence:local-one",
      climb: {
        externalId: null,
        name: "Same label",
        areas: [{ externalId: null, name: "Same place" }],
      },
      attempts: [{ scope: "climb" as const }],
    };
    await write([first]);
    const [before] = await context.db.select().from(climbingLogEntry);
    await write([first]);
    const [after] = await context.db.select().from(climbingLogEntry);
    expect(after?.climbId).toBe(before?.climbId);
    await write([{ ...first, externalId: "occurrence:local-two" }]);
    const definitions = await context.db.select().from(climb);
    expect(definitions).toHaveLength(2);
    expect(await context.db.select().from(area)).toHaveLength(2);
  });
  it("updates historical displays from shared definitions", async () => {
    const definition = {
      externalId: "route:shared-grade",
      name: "Known route",
      kind: "route" as const,
      areas: [
        { externalId: "area:region", name: "Original region" },
        { externalId: "area:crag", name: "Original crag" },
      ],
      publishedGrades: [{ value: "5.10a", system: "yds" as const }],
    };
    const first = await write([
      {
        externalId: "occurrence:historical",
        climb: definition,
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const id = first.logEntryIds[0];
    if (!id) throw new Error("Expected an imported log");
    await write([
      {
        externalId: "occurrence:current",
        climb: {
          ...definition,
          areas: [
            { externalId: "area:region", name: "Updated region" },
            { externalId: "area:crag", name: "Updated crag" },
          ],
          publishedGrades: [{ value: "5.11a", system: "yds" as const }],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const [projection] = await executeWithSchema(
      context.db,
      projectionSchema,
      sql`SELECT published_grades, area_path FROM fitness.v_climbing_log_entry WHERE id = ${id}::uuid`,
    );
    expect(projection?.published_grades).toEqual([{ value: "5.11a", system: "yds" }]);
    expect(projection?.area_path.map((node) => node.name)).toEqual([
      "Updated region",
      "Updated crag",
    ]);
    expect(await context.db.select().from(climb)).toHaveLength(1);
  });
  it("retains verified area identity through an associated path when later responses lack identifiers", async () => {
    await write([
      {
        externalId: "occurrence:missing-ids",
        climb: {
          externalId: "route:retained",
          areas: [
            {
              externalId: "area:retained",
              name: "Known area",
              coordinates: { longitude: -122.25, latitude: 37.5 },
            },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const [before] = await context.db.select().from(area);
    await write([
      {
        externalId: "occurrence:missing-ids",
        climb: { externalId: null, areas: [{ externalId: null, name: "Known area" }] },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    expect(await context.db.select().from(area)).toEqual([before]);
    expect((await context.db.select().from(climb))[0]?.externalId).toBe("route:retained");
  });
  it("removes replaced unreferenced local chains", async () => {
    await write([
      {
        externalId: "occurrence:move",
        climb: {
          externalId: "route:moved",
          areas: [
            { externalId: null, name: "Old region" },
            { externalId: null, name: "Old gym" },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    await write([
      {
        externalId: "occurrence:move",
        climb: {
          externalId: "route:moved",
          areas: [
            { externalId: null, name: "New region" },
            { externalId: null, name: "New gym" },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    expect((await context.db.select().from(area)).map((a) => a.name).sort()).toEqual([
      "New gym",
      "New region",
    ]);
    await write([
      {
        externalId: "occurrence:move",
        climb: { externalId: "route:moved", areas: [] },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    expect(await context.db.select().from(area)).toHaveLength(0);
    expect((await context.db.select().from(climb))[0]?.areaId).toBeNull();
  });
  it("isolates equal source keys and names by owner and provider", async () => {
    const entries: SourceClimbingLogEntry[] = [
      {
        externalId: "occurrence:same",
        attempts: [{ scope: "climb" }],
        climb: {
          externalId: "route:same",
          areas: [{ externalId: "area:same", name: "Same place" }],
        },
      },
    ];
    await write(entries);
    await persistClimbingLogEntries(context.db, { userId: otherUserId, providerId, entries });
    await persistClimbingLogEntries(context.db, {
      userId: TEST_USER_ID,
      providerId: otherProviderId,
      entries,
    });
    expect(await context.db.select().from(climbingLogEntry)).toHaveLength(3);
    expect(await context.db.select().from(climb)).toHaveLength(3);
    expect(await context.db.select().from(area)).toHaveLength(3);
  });
  it("clears a shared area's parent only from explicit source evidence", async () => {
    await write([
      {
        externalId: "occurrence:root-change",
        climb: {
          externalId: "route:root-change",
          areas: [
            { externalId: "area:former-parent", name: "Former parent" },
            { externalId: "area:now-root", name: "Recorded place" },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    await write([
      {
        externalId: "occurrence:root-change",
        climb: {
          externalId: "route:root-change",
          areas: [{ externalId: "area:now-root", name: "Recorded place" }],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const [preserved] = await context.db
      .select()
      .from(area)
      .where(eq(area.externalId, "area:now-root"));
    expect(preserved?.parentAreaId).not.toBeNull();
    await write([
      {
        externalId: "occurrence:root-change",
        climb: {
          externalId: "route:root-change",
          areas: [{ externalId: "area:now-root", name: "Recorded place", parentExternalId: null }],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const [cleared] = await context.db
      .select()
      .from(area)
      .where(eq(area.externalId, "area:now-root"));
    expect(cleared?.parentAreaId).toBeNull();
    expect((await context.db.select().from(area)).map((a) => a.name)).toEqual(["Recorded place"]);
  });
  it("rolls back all graph writes when a batch entry is invalid", async () => {
    await write([
      {
        externalId: "occurrence:existing",
        climb: {
          externalId: "route:existing",
          publishedGrades: [{ value: "5.10a", system: "yds" }],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const logsBefore = await context.db.select().from(climbingLogEntry);
    await expect(
      write([
        {
          externalId: "occurrence:existing",
          climb: {
            externalId: "route:existing",
            publishedGrades: [{ value: "5.11a", system: "yds" as const }],
          },
          attempts: [{ scope: "climb" as const }],
        },
        {
          externalId: "occurrence:bad",
          attempts: [
            {
              scope: "climb" as const,
              usedAid: true,
              qualifier: "free-onsight" as const,
              sourceResult: "Onsight",
            },
          ],
        },
      ]),
    ).rejects.toThrow("usedAid");
    expect(await context.db.select().from(climbingLogEntry)).toEqual(logsBefore);
    expect((await context.db.select().from(climbGrade))[0]).toMatchObject({
      value: "5.10a",
      system: "yds",
    });
  });
  it("serializes opposite reparentings to reject a concurrent cycle", async () => {
    await write([
      {
        externalId: "occurrence:a",
        climb: { externalId: "route:a", areas: [{ externalId: "area:a", name: "A" }] },
        attempts: [{ scope: "climb" as const }],
      },
      {
        externalId: "occurrence:b",
        climb: { externalId: "route:b", areas: [{ externalId: "area:b", name: "B" }] },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const locked = createTestBarrier();
    const release = createTestBarrier();
    const first = context.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`climbing-graph:${TEST_USER_ID}:${providerId}`}, 0))`,
      );
      locked.resolve();
      await release.promise;
      return persistClimbingLogEntries(tx, {
        userId: TEST_USER_ID,
        providerId,
        entries: [
          {
            externalId: "occurrence:a",
            climb: {
              externalId: "route:a",
              areas: [
                { externalId: "area:b", name: "B" },
                { externalId: "area:a", name: "A" },
              ],
            },
            attempts: [{ scope: "climb" as const }],
          },
        ],
      });
    });
    await locked.promise;
    const second = write([
      {
        externalId: "occurrence:b",
        climb: {
          externalId: "route:b",
          areas: [
            { externalId: "area:a", name: "A" },
            { externalId: "area:b", name: "B" },
          ],
        },
        attempts: [{ scope: "climb" as const }],
      },
    ]);
    const settled = Promise.allSettled([first, second]);
    try {
      await expect.poll(() => hasDatabaseLockWaiter(context.db)).toBe(true);
    } finally {
      release.resolve();
    }
    const result = await settled;
    expect(result.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const [a] = await context.db
      .select()
      .from(area)
      .where(and(eq(area.providerId, providerId), eq(area.externalId, "area:a")));
    const [b] = await context.db
      .select()
      .from(area)
      .where(and(eq(area.providerId, providerId), eq(area.externalId, "area:b")));
    expect(a?.parentAreaId).toBe(b?.id);
    expect(b?.parentAreaId).toBeNull();
  });
});
