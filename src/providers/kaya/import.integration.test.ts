import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { persistClimbingLogEntries } from "../../db/climbing-log-sync.ts";
import { activity } from "../../db/schema/activity.ts";
import {
  area,
  climb,
  climbingAttempt,
  climbingLogEntry,
  climbingLogEntryGrade,
} from "../../db/schema/climbing.ts";
import { TEST_USER_ID as userId } from "../../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { importKayaExportFile } from "./import.ts";

const header =
  "date,stiffness,rating,ascent_type,attempts,grade,color,climb_name,gym,location,country";
const row = (
  label = "Redpoint",
  count = "2",
  date = "2026-09-01T12:00:00Z",
  grade = "v3",
  gym = "Test Gym",
) => `${date},0,,${label},${count},${grade},Blue,Test Climb,${gym},,`;
describe("Kaya CSV canonical persistence", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
  });
  afterEach(async () => {
    await context.db.delete(climbingLogEntry);
    await context.db.delete(climb);
    await context.db.update(area).set({ parentAreaId: null });
    await context.db.delete(area);
    await context.db.delete(activity).where(eq(activity.providerId, "kaya-export"));
  });
  afterAll(async () => {
    await context.cleanup();
  });
  const logs = () =>
    context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, "kaya-export"));
  it("preserves occurrence IDs foreign attachments and described tries while correcting counts", async () => {
    const csv = `${header}\n${row()}`;
    expect(await importKayaExportFile(context.db, csv, userId)).toMatchObject({
      recordsSynced: 1,
      errors: [],
    });
    const [entry] = await logs();
    const [session] = await context.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "kaya-export"));
    if (!entry || !session) throw new Error("Expected CSV session and log");
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, userId);
    const foreignResult = await persistClimbingLogEntries(context.db, {
      userId,
      providerId: "openbeta",
      entries: [
        {
          externalId: "openbeta:attached",
          activityId: session.id,
          climbedOn: "2026-09-01",
          attempts: [{ scope: "climb", ropeMethod: "follow", usedAid: true, outcome: "completed" }],
        },
      ],
    });
    const [foreign] = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.id, foreignResult.logEntryIds[0] ?? ""));
    const before = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, entry.id));
    const unknown = before.find((attempt) => attempt.outcome === null);
    if (!unknown) throw new Error("Expected count placeholder");
    await context.db
      .update(climbingAttempt)
      .set({ outcome: "failed", fellOrHung: true, notes: "Recorded failed try" })
      .where(eq(climbingAttempt.id, unknown.id));
    expect(
      await importKayaExportFile(context.db, `${header}\n${row("Redpoint", "3")}`, userId),
    ).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await logs()).toEqual([
      expect.objectContaining({
        id: entry.id,
        activityId: session.id,
        climbedOn: "2026-09-01",
        raw: expect.objectContaining({ attempts: 3 }),
      }),
    ]);
    const after = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, entry.id));
    expect(after).toHaveLength(3);
    expect(after).toContainEqual(
      expect.objectContaining({
        id: unknown.id,
        outcome: "failed",
        fellOrHung: true,
        notes: "Recorded failed try",
      }),
    );
    expect(
      await context.db
        .select()
        .from(climbingLogEntry)
        .where(eq(climbingLogEntry.id, foreign?.id ?? "")),
    ).toEqual([foreign]);
    expect(
      await context.db
        .select()
        .from(climbingLogEntryGrade)
        .where(eq(climbingLogEntryGrade.climbingLogEntryId, entry.id)),
    ).toEqual([expect.objectContaining({ value: "V3", system: "v_scale" })]);
    expect(
      await importKayaExportFile(
        context.db,
        `${header}\n${row("Attempt")}\n${row("Redpoint", "2", "not-a-date")}`,
        userId,
      ),
    ).toMatchObject({ recordsSynced: 1, errors: [expect.any(Object)] });
    expect((await logs()).find((log) => log.id === entry.id)?.providerAbsentAt).toBeNull();
  });
  it("expands one occurrence without totals and normalizes only supported completion labels", async () => {
    const labels = ["Attempt", "Flash", "Redpoint", "Repeat", "Unfamiliar result", ""];
    expect(
      await importKayaExportFile(
        context.db,
        `${header}\n${labels.map((label) => row(label, "")).join("\n")}`,
        userId,
      ),
    ).toMatchObject({ recordsSynced: labels.length, errors: [] });
    const saved = await logs();
    const attempts = await context.db
      .select({ attempt: climbingAttempt, raw: climbingLogEntry.raw })
      .from(climbingAttempt)
      .innerJoin(climbingLogEntry, eq(climbingAttempt.climbingLogEntryId, climbingLogEntry.id))
      .where(
        and(eq(climbingLogEntry.userId, userId), eq(climbingLogEntry.providerId, "kaya-export")),
      );
    expect(saved).toHaveLength(labels.length);
    expect(attempts).toHaveLength(labels.length);
    for (const label of labels) {
      const source = attempts.find(
        (result) =>
          z.object({ ascentType: z.string() }).safeParse(result.raw).data?.ascentType === label,
      );
      expect(source?.attempt).toMatchObject({
        scope: "climb",
        outcome: ["Flash", "Redpoint", "Repeat"].includes(label) ? "completed" : null,
      });
    }
    expect(
      attempts.find((result) => result.attempt.hadCompletedBefore === true)?.attempt.outcome,
    ).toBe("completed");
  });
  it("retains undated ungraded logs without fabricating an activity or merging object names", async () => {
    const source = row("", "", "", "", "");
    expect(
      await importKayaExportFile(context.db, `${header}\n${source}\n${source}`, userId),
    ).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await logs()).toEqual([
      expect.objectContaining({ activityId: null, climbedOn: null }),
      expect.objectContaining({ activityId: null, climbedOn: null }),
    ]);
    expect(await context.db.select().from(climb)).toHaveLength(2);
    expect(
      await context.db.select().from(activity).where(eq(activity.providerId, "kaya-export")),
    ).toEqual([]);
    expect(await context.db.select().from(climbingAttempt)).toHaveLength(2);
    expect(
      await importKayaExportFile(context.db, `${header}\n${source}\n${source}`, userId),
    ).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(await context.db.select().from(climb)).toHaveLength(2);
  });
});
