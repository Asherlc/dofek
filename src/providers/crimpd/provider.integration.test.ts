import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activity, strengthSet } from "../../db/schema/activity.ts";
import { climbingAttempt, climbingLogEntry } from "../../db/schema/climbing.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import {
  climbingExportZip,
  crimpdSetHeader,
  crimpdSetRow,
  crimpdWorkoutHeader,
  crimpdWorkoutRow,
} from "../climbing-file-test-helpers.ts";
import { importCrimpdExportFile } from "./provider.ts";

describe("Crimpd ZIP import persistence", () => {
  let context: TestContext;
  let directory: string;
  beforeAll(async () => {
    context = await setupTestDatabase();
    directory = await mkdtemp(join(tmpdir(), "crimpd-integration-"));
  });
  afterAll(async () => {
    await context.cleanup();
    await rm(directory, { recursive: true });
  });
  async function upload(sets: string[], workouts = [crimpdWorkoutRow()]): Promise<string> {
    const path = join(directory, "export.zip");
    await writeFile(
      path,
      await climbingExportZip({
        "workouts.csv": `${crimpdWorkoutHeader}\n${workouts.join("\n")}`,
        "sets.csv": `${crimpdSetHeader}\n${sets.join("\n")}`,
      }),
    );
    return path;
  }
  it("persists ASCENT evidence once, retains manual attachments, and imports nonclimbing raw sets without estimates", async () => {
    const strength = crimpdSetRow({
      LOG_ID: "strength-1",
      EXERCISE: "Pull up",
      GRADE: "",
      GRADE_SYSTEM: "",
      ASCENT: "",
      LOCATION: "",
      BOARD: "",
      BOARD_LAYOUT: "",
      REPS: "0",
      RESISTANCE: "0",
      WEIGHT_UNIT: "KG",
      DISTANCE: "0",
      LENGTH_UNIT: "CM",
    });
    const workouts = [
      crimpdWorkoutRow(),
      crimpdWorkoutRow({
        LOG_ID: "strength-1",
        TYPE: "Strength & Power",
        TARGET: "Strength Training",
        WORKOUT_NAME: "Pull ups",
      }),
    ];
    const path = await upload([crimpdSetRow({ ASCENT: "true" }), strength], workouts);
    expect(await importCrimpdExportFile(context.db, path, TEST_USER_ID)).toMatchObject({
      recordsSynced: 2,
      errors: [],
    });
    const [log] = await context.db
      .select()
      .from(climbingLogEntry)
      .where(eq(climbingLogEntry.providerId, "crimpd"));
    if (!log) throw new Error("Expected climb");
    const [strengthActivity] = await context.db
      .select()
      .from(activity)
      .where(and(eq(activity.providerId, "crimpd"), eq(activity.externalId, "strength-1")));
    if (!strengthActivity) throw new Error("Expected strength activity");
    expect(strengthActivity).toMatchObject({
      startedAt: new Date("2026-09-01T23:30:00Z"),
      endedAt: null,
    });
    await context.db
      .update(climbingLogEntry)
      .set({ activityId: strengthActivity.id })
      .where(eq(climbingLogEntry.id, log.id));
    await importCrimpdExportFile(context.db, path, TEST_USER_ID);
    expect(
      await context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.id, log.id)),
    ).toMatchObject([{ activityId: strengthActivity.id }]);
    const attempts = await context.db
      .select()
      .from(climbingAttempt)
      .where(eq(climbingAttempt.climbingLogEntryId, log.id));
    expect(attempts).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.sourceCompleted === true)).toHaveLength(1);
    const sets = await context.db
      .select()
      .from(strengthSet)
      .where(eq(strengthSet.activityId, strengthActivity.id));
    expect(sets).toEqual([
      expect.objectContaining({
        reps: 0,
        distanceMeters: 0,
        weightKg: null,
        durationSeconds: null,
        rpe: null,
        raw: expect.objectContaining({ RESISTANCE: "0", EST_WORK_DURATION: "30" }),
      }),
    ]);
    await importCrimpdExportFile(context.db, await upload([], workouts), TEST_USER_ID);
    expect(
      await context.db
        .select()
        .from(strengthSet)
        .where(eq(strengthSet.activityId, strengthActivity.id)),
    ).toEqual(sets);
    expect(
      await context.db.select().from(climbingLogEntry).where(eq(climbingLogEntry.id, log.id)),
    ).toMatchObject([{ providerAbsentAt: null }]);
  });
  it("validates the entire archive before mutating workouts", async () => {
    const before = await context.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "crimpd"));
    await expect(
      importCrimpdExportFile(
        context.db,
        await upload([crimpdSetRow({ ASCENT: "yes" })]),
        TEST_USER_ID,
      ),
    ).rejects.toMatchObject({ name: "ClimbingImportValidationError" });
    expect(
      await context.db.select().from(activity).where(eq(activity.providerId, "crimpd")),
    ).toEqual(before);
  });

  it.each(["true", "false"])(
    "refreshes ASCENT=%s to unrecorded without changing occurrence identities or manual attachments",
    async (initial) => {
      const logId = `completion-refresh-${initial}-${randomUUID()}`;
      const workouts = [crimpdWorkoutRow({ LOG_ID: logId })];
      await importCrimpdExportFile(
        context.db,
        await upload([crimpdSetRow({ LOG_ID: logId, ASCENT: initial, REPS: "3" })], workouts),
        TEST_USER_ID,
      );
      const [entry] = await context.db
        .select()
        .from(climbingLogEntry)
        .where(
          and(
            eq(climbingLogEntry.providerId, "crimpd"),
            eq(climbingLogEntry.externalId, `crimpd:set:${JSON.stringify([logId, 1, 1])}`),
          ),
        );
      if (!entry) throw new Error("Expected source climb occurrence");
      const [manualActivity] = await context.db
        .insert(activity)
        .values({
          userId: TEST_USER_ID,
          providerId: "crimpd",
          externalId: `manual-attachment-${logId}`,
          canonicalType: "climbing",
          providerType: "manual",
          startedAt: new Date("2026-09-01T12:00:00Z"),
        })
        .returning();
      if (!manualActivity) throw new Error("Expected manual activity attachment");
      await context.db
        .update(climbingLogEntry)
        .set({ activityId: manualActivity.id })
        .where(eq(climbingLogEntry.id, entry.id));
      const original = await context.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingLogEntryId, entry.id));
      expect(original).toHaveLength(3);
      expect(
        original.filter((attempt) => attempt.sourceCompleted === (initial === "true")),
      ).toHaveLength(1);
      expect(original.filter((attempt) => attempt.sourceCompleted === null)).toHaveLength(2);

      await importCrimpdExportFile(
        context.db,
        await upload([crimpdSetRow({ LOG_ID: logId, ASCENT: "", REPS: "3" })], workouts),
        TEST_USER_ID,
      );
      const refreshed = await context.db
        .select()
        .from(climbingLogEntry)
        .where(eq(climbingLogEntry.id, entry.id));
      expect(refreshed).toMatchObject([
        {
          id: entry.id,
          externalId: entry.externalId,
          activityId: manualActivity.id,
          raw: expect.objectContaining({ ASCENT: "" }),
        },
      ]);
      const attempts = await context.db
        .select()
        .from(climbingAttempt)
        .where(eq(climbingAttempt.climbingLogEntryId, entry.id));
      expect(attempts.map((attempt) => attempt.id).sort()).toEqual(
        original.map((attempt) => attempt.id).sort(),
      );
      expect(attempts).toHaveLength(3);
      expect(attempts.every((attempt) => attempt.sourceCompleted === null)).toBe(true);
    },
  );
});
