import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity, climbingAttempt, climbingEntry } from "../../db/schema/activity.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { ensureProvider } from "../../db/tokens.ts";
import { importKayaExportFile } from "./import.ts";

const header =
  "date,stiffness,rating,ascent_type,attempts,grade,color,climb_name,gym,location,country";
const row = (result: string, attempts = "2") =>
  `2026-09-01T12:00:00Z,0,,${result},${attempts},v3,Blue,Test Climb,Test Gym,,`;

describe("Kaya CSV climbing context (PostgreSQL integration)", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await context?.cleanup();
  });

  it("preserves source identities, attached foreign ticks, and detailed attempts across a successful re-import", async () => {
    const csv = `${header}\n${row("Redpoint")}`;
    await expect(importKayaExportFile(context.db, csv, TEST_USER_ID)).resolves.toMatchObject({
      recordsSynced: 1,
      errors: [],
    });
    const [session] = await context.db
      .select()
      .from(activity)
      .where(and(eq(activity.userId, TEST_USER_ID), eq(activity.providerId, "kaya-export")));
    const [entry] = await context.db
      .select()
      .from(climbingEntry)
      .where(eq(climbingEntry.providerId, "kaya-export"));
    if (!session || !entry) throw new Error("Kaya CSV session was not persisted");
    await ensureProvider(context.db, "openbeta", "OpenBeta", undefined, TEST_USER_ID);
    const [foreign] = await context.db
      .insert(climbingEntry)
      .values({
        userId: TEST_USER_ID,
        providerId: "openbeta",
        activityId: session.id,
        externalId: "openbeta:attached",
        climbType: "route",
        gradeSystem: "yds",
        grade: "5.10a",
        climbStyle: "follow",
        resultStyle: "Frenchfree",
        raw: { style: "Follow" },
      })
      .returning();
    if (!foreign) throw new Error("Failed to seed foreign-provider attachment");
    const [attempt] = await context.db
      .insert(climbingAttempt)
      .values({
        climbingEntryId: entry.id,
        attemptIndex: 1,
        outcome: "failed",
        failureReason: "fell",
      })
      .returning();
    await expect(
      importKayaExportFile(context.db, `${header}\n${row("Redpoint", "3")}`, TEST_USER_ID),
    ).resolves.toMatchObject({ recordsSynced: 1, errors: [] });
    expect(
      await context.db.select().from(climbingEntry).where(eq(climbingEntry.id, foreign.id)),
    ).toEqual([foreign]);
    const [refreshed] = await context.db
      .select()
      .from(climbingEntry)
      .where(eq(climbingEntry.id, entry.id));
    expect(refreshed).toMatchObject({
      id: entry.id,
      activityId: session.id,
      attemptCount: 3,
      raw: { attempts: 3 },
    });
    expect(
      await context.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingEntryId, entry.id)),
    ).toEqual([attempt]);
    const partial = await importKayaExportFile(
      context.db,
      `${header}\n${row("Attempt")}\nnot-a-date,0,,Redpoint,,v3,Blue,Test Climb,Test Gym,,`,
      TEST_USER_ID,
    );
    expect(partial).toMatchObject({ recordsSynced: 1, errors: [expect.any(Object)] });
    expect(
      await context.db.select().from(climbingEntry).where(eq(climbingEntry.id, entry.id)),
    ).toEqual([expect.objectContaining({ id: entry.id, providerAbsentAt: null })]);
  });

  it("preserves missing and unfamiliar CSV results with independently interpreted outcomes", async () => {
    const labels = ["Attempt", "Pinkpoint", "Frenchfree", "Unfamiliar result", ""];
    const result = await importKayaExportFile(
      context.db,
      `${header}\n${labels.map((label) => row(label, "")).join("\n")}`,
      TEST_USER_ID,
    );
    expect(result).toMatchObject({ recordsSynced: labels.length, errors: [] });
    const entries = await context.db.execute<{
      result_style: string | null;
      sent: boolean | null;
      attempt_count: number | null;
      raw: { ascentType: string };
    }>(sql`
      SELECT result_style, sent, attempt_count, raw FROM fitness.v_climbing_entry
      WHERE provider_id = 'kaya-export' AND result_style IS DISTINCT FROM 'Redpoint'
    `);
    expect(entries).toHaveLength(labels.length);
    for (const [label, sent] of [
      ["Attempt", false],
      ["Pinkpoint", true],
      ["Frenchfree", null],
      ["Unfamiliar result", null],
      ["", null],
    ] as const) {
      expect(entries).toContainEqual({
        result_style: label || null,
        sent,
        attempt_count: null,
        raw: expect.objectContaining({ ascentType: label }),
      });
    }
  });
});
