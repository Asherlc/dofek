import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity, strengthSet } from "../../db/schema/activity.ts";
import { climbingAttempt, climbingLogEntry } from "../../db/schema/climbing.ts";
import { TEST_USER_ID } from "../../db/schema/core.ts";
import { userProfile } from "../../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../db/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { createIntegrationMswFixture } from "../../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../../test/msw.ts";
import {
  climbingExportZip,
  crimpdSetHeader,
  crimpdSetRow,
  crimpdWorkoutHeader,
  crimpdWorkoutRow,
} from "../climbing-file-test-helpers.ts";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { CrimpdProvider, importCrimpdExportFile } from "./provider.ts";

const accountServer = createIntegrationMswFixture();

describe("Crimpd automatic account sync", () => {
  let context: TestContext;
  let archive: Buffer;
  let exportStatus: number;
  let rejectOldAccess: boolean;
  let expiredRefresh: boolean;
  let refreshRequests: number;

  beforeAll(async () => {
    context = await setupTestDatabase();
    accountServer.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
  });
  beforeEach(async () => {
    exportStatus = 200;
    rejectOldAccess = false;
    expiredRefresh = false;
    refreshRequests = 0;
    archive = await climbingExportZip({
      "workouts.csv": `${crimpdWorkoutHeader}\n${crimpdWorkoutRow()}`,
      "sets.csv": `${crimpdSetHeader}\n${crimpdSetRow({ ASCENT: "true" })}`,
    });
    await ensureProvider(context.db, "crimpd", "Crimpd", undefined, TEST_USER_ID);
    await saveTokens(
      context.db,
      "crimpd",
      {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date("2099-01-01"),
        providerAccountId: "owner-1",
        scopes: null,
      },
      TEST_USER_ID,
    );
    accountServer.use(
      http.post("https://api.crimpd.com/auth/refresh", async ({ request }) => {
        refreshRequests++;
        expect(await request.json()).toEqual({ refreshToken: "old-refresh" });
        return expiredRefresh
          ? HttpResponse.json({ success: false }, { status: 401 })
          : HttpResponse.json({
              success: true,
              user: { _id: "owner-1" },
              token: "new-access",
              refreshToken: "new-refresh",
              expiresIn: 3600,
              refreshExpiresIn: 7200,
            });
      }),
      http.get("https://api.crimpd.com/analytics/export", async ({ request }) => {
        expect(new URL(request.url).searchParams.get("format")).toBe("zip");
        const bearer = request.headers.get("authorization");
        expect(bearer).toMatch(/^Bearer (old|new)-access$/);
        if (rejectOldAccess && bearer === "Bearer old-access")
          return HttpResponse.json({ success: false }, { status: 401 });
        if (bearer === "Bearer new-access") {
          // A rotated refresh token must already be durable if this request fails.
          expect(await loadTokens(context.db, "crimpd", TEST_USER_ID)).toMatchObject({
            accessToken: "new-access",
            refreshToken: "new-refresh",
          });
        }
        return exportStatus === 200
          ? new HttpResponse(new Uint8Array(archive).buffer, {
              headers: { "content-type": "application/zip" },
            })
          : new HttpResponse(null, { status: exportStatus });
      }),
    );
  });
  afterEach(async () => {
    accountServer.resetHandlers();
    await context.db.delete(climbingLogEntry).where(eq(climbingLogEntry.providerId, "crimpd"));
    await context.db.delete(activity).where(eq(activity.providerId, "crimpd"));
  });
  afterAll(async () => {
    accountServer.deactivate();
    await context.cleanup();
  });

  const sync = () =>
    new CrimpdProvider().sync(
      new SyncRun({ db: context.db, userId: TEST_USER_ID, window: SyncWindow.full() }),
    );
  const activities = () =>
    context.db.select().from(activity).where(eq(activity.providerId, "crimpd"));

  it("propagates cancellation during export without writing activities", async () => {
    const controller = new AbortController();
    const reason = new Error("Crimpd sync cancelled");
    accountServer.use(
      http.get("https://api.crimpd.com/analytics/export", () => {
        controller.abort(reason);
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await expect(
      new CrimpdProvider().sync(
        new SyncRun({
          db: context.db,
          userId: TEST_USER_ID,
          window: SyncWindow.full(),
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow(reason);
    expect(await activities()).toEqual([]);
  });

  it("shares native workout identities and manual attachments with file imports", async () => {
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    const [original] = await activities();
    const [entry] = await context.db.select().from(climbingLogEntry);
    if (!original || !entry) throw new Error("Expected imported workout and climb");
    await context.db
      .update(climbingLogEntry)
      .set({ activityId: null })
      .where(eq(climbingLogEntry.id, entry.id));
    const directory = await mkdtemp(join(tmpdir(), "crimpd-sync-test-"));
    try {
      const filePath = join(directory, "export.zip");
      await writeFile(filePath, archive);
      await importCrimpdExportFile(context.db, filePath, TEST_USER_ID);
    } finally {
      await rm(directory, { recursive: true });
    }
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(await activities()).toHaveLength(1);
    expect((await activities())[0]?.id).toBe(original.id);
    expect(await context.db.select().from(climbingLogEntry)).toMatchObject([
      { id: entry.id, activityId: null },
    ]);
    expect(await context.db.select().from(climbingAttempt)).toHaveLength(3);
  });

  it("refreshes expired credentials and persists rotation before exporting", async () => {
    const saved = await loadTokens(context.db, "crimpd", TEST_USER_ID);
    if (!saved) throw new Error("Expected account credentials");
    await saveTokens(context.db, "crimpd", { ...saved, expiresAt: new Date(0) }, TEST_USER_ID);
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(refreshRequests).toBe(1);
  });

  it("renews an unexpectedly rejected access token once", async () => {
    rejectOldAccess = true;
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(refreshRequests).toBe(1);
  });

  it("keeps rotated credentials when a later export fails without writing activities", async () => {
    rejectOldAccess = true;
    exportStatus = 503;
    await expect(sync()).rejects.toMatchObject({
      name: "ProviderServiceUnavailableError",
      statusCode: 503,
    });
    expect(await loadTokens(context.db, "crimpd", TEST_USER_ID)).toMatchObject({
      refreshToken: "new-refresh",
    });
    expect(await activities()).toEqual([]);
  });

  it("reports revoked refresh credentials without mutating imported history", async () => {
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    const before = await activities();
    rejectOldAccess = true;
    expiredRefresh = true;
    expect(await sync()).toMatchObject({
      recordsSynced: 0,
      errors: [expect.objectContaining({ message: expect.stringMatching(/Reconnect/) })],
    });
    expect(await activities()).toEqual(before);
    expect(refreshRequests).toBe(1);
  });

  it("preserves existing history when an export is empty", async () => {
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    const before = await activities();
    archive = await climbingExportZip({
      "workouts.csv": crimpdWorkoutHeader,
      "sets.csv": crimpdSetHeader,
    });
    expect(await sync()).toMatchObject({ recordsSynced: 0, errors: [] });
    expect(await activities()).toEqual(before);
  });

  it("keeps identical upstream workout IDs isolated between Dofek users", async () => {
    const otherUserId = randomUUID();
    await context.db.insert(userProfile).values({ id: otherUserId, name: "Other climber" });
    await ensureProvider(context.db, "crimpd", "Crimpd", undefined, otherUserId);
    const credentials = await loadTokens(context.db, "crimpd", TEST_USER_ID);
    if (!credentials) throw new Error("Expected account credentials");
    await saveTokens(context.db, "crimpd", credentials, otherUserId);
    expect(await sync()).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(
      await new CrimpdProvider().sync(
        new SyncRun({ db: context.db, userId: otherUserId, window: SyncWindow.full() }),
      ),
    ).toMatchObject({ recordsSynced: 1, errors: [] });
    const rows = await activities();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([TEST_USER_ID, otherUserId]));
    expect(new Set(rows.map((row) => row.externalId)).size).toBe(1);
    const climbs = await context.db.select().from(climbingLogEntry);
    expect(climbs).toHaveLength(2);
    expect(new Set(climbs.map((row) => row.userId))).toEqual(new Set([TEST_USER_ID, otherUserId]));
    expect(await loadTokens(context.db, "crimpd", TEST_USER_ID)).toMatchObject(credentials);
  });
});

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
