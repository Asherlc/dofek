import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder, Profile, Utils } from "@garmin/fitsdk";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity, activityInterval } from "../db/schema/activity.ts";
import { TEST_USER_ID } from "../db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider } from "../db/tokens.ts";
import { createCapturingMetricStreamPublisher } from "../providers/test-helpers.ts";
import { createProviderArtifactStorageTestContext } from "../test-helpers.ts";
import { importFitFile } from "./process-fit-file-import-job.ts";

const endpoint = "https://r2.fit-import-retention.test";
const archive = createProviderArtifactStorageTestContext(endpoint);
let context: TestContext;
let directory: string;

function sourceData(filePath: string, providerId = "fit-file") {
  return { filePath, originalPath: "uploaded.fit", userId: TEST_USER_ID, providerId };
}

function archivedKey(bytes: Buffer, providerId = "fit-file") {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `provider-artifacts/${TEST_USER_ID}/${providerId}/${digest}.fit`;
}

function encodedLambertsRide(workoutName: string): Buffer {
  const startedAt = Utils.convertDateToDateTime(new Date("2026-11-13T12:00:00Z"));
  const encoder = new Encoder();
  encoder.writeMesg({ mesgNum: Profile.MesgNum.FILE_ID, type: "activity" });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.WORKOUT,
    wktName: workoutName,
    sport: "cycling",
    numValidSteps: 5,
  });
  encoder.writeMesg({ mesgNum: Profile.MesgNum.ZONES_TARGET, maxHeartRate: 190 });

  let stageStart = startedAt + 120;
  for (const [index, { duration, target }] of [
    { duration: 360, target: 60 },
    { duration: 30, target: null },
    { duration: 360, target: 80 },
    { duration: 180, target: 90 },
    { duration: 90, target: null },
  ].entries()) {
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.WORKOUT_STEP,
      messageIndex: index,
      durationType: "time",
      durationValue: duration * 1_000,
      ...(target === null
        ? { targetType: "open", intensity: "recovery" }
        : {
            targetType: "heartRate",
            targetValue: 0,
            customTargetValueLow: target,
            customTargetValueHigh: target,
          }),
    });
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: stageStart,
      heartRate: 120,
      power: 150,
    });
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.LAP,
      wktStepIndex: index,
      startTime: stageStart,
      timestamp: stageStart + duration,
      totalElapsedTime: duration,
      totalTimerTime: duration,
    });
    stageStart += duration;
  }
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.SESSION,
    sport: "cycling",
    subSport: "indoorCycling",
    startTime: startedAt,
    timestamp: startedAt + 1_200,
    totalElapsedTime: 1_200,
  });
  return Buffer.from(encoder.close());
}

beforeAll(async () => {
  archive.server.activate({ onUnhandledFrame: "error" });
  context = await setupTestDatabase();
  await ensureProvider(context.db, "fit-file", "FIT File", undefined, TEST_USER_ID);
}, 60_000);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fit-import-retention-"));
  archive.originals.clear();
  archive.writes.length = 0;
  await context.db.delete(activity);
});

afterEach(async () => {
  archive.server.resetHandlers();
  await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  archive.server.deactivate();
  archive.client.destroy();
  await context?.cleanup();
});

describe("shared native FIT import retains original files", () => {
  it("retains recorded Lamberts stages with original FIT evidence on a repeat import", async () => {
    const filePath = join(directory, "cycle.fit");
    await writeFile(filePath, encodedLambertsRide("LSCT"));
    const capture = createCapturingMetricStreamPublisher();
    for (const _ of [1, 2]) {
      const result = await importFitFile(
        context.db,
        sourceData(filePath),
        async () => {},
        capture.publisher,
        archive.storage,
      );
      expect(result.errors).toEqual([]);
    }
    const [storedActivity] = await context.db.select().from(activity);
    const intervals = await context.db
      .select()
      .from(activityInterval)
      .orderBy(activityInterval.intervalIndex);
    expect(intervals.map((interval) => interval.segmentType)).toEqual([
      "lsct_stage_1",
      "lsct_calibration",
      "lsct_stage_2",
      "lsct_stage_3",
      "lsct_recovery",
    ]);
    expect(intervals[0]).toMatchObject({
      startedAt: new Date("2026-11-13T12:02:00Z"),
      sourceKind: "provider_recorded",
      sourceProvider: "fit-file",
      sourceActivityId: storedActivity?.id,
      raw: {
        fitWorkout: { wkt_name: "LSCT" },
        fitZonesTarget: { max_heart_rate: 190 },
        fitWorkoutStep: { custom_target_value_low: 60 },
        fitLap: { wkt_step_index: 0 },
      },
    });
  });

  it("keeps a similar structured workout with a different name out of the test history", async () => {
    const filePath = join(directory, "cycle.fit");
    await writeFile(filePath, encodedLambertsRide("Progressive Ride"));
    const result = await importFitFile(
      context.db,
      sourceData(filePath),
      async () => {},
      createCapturingMetricStreamPublisher().publisher,
      archive.storage,
    );
    expect(result.errors).toEqual([]);
    expect(await context.db.select().from(activityInterval)).toEqual([]);
  });

  it("keeps a recoverable original after source cleanup and preserves reimport identity", async () => {
    const bytes = await readFile(new URL("../fit/fixtures/test.fit", import.meta.url));
    const filePath = join(directory, "source.fit");
    await writeFile(filePath, bytes);
    const capture = createCapturingMetricStreamPublisher();
    const result = await importFitFile(
      context.db,
      sourceData(filePath),
      async () => {},
      capture.publisher,
      archive.storage,
    );
    expect(result.errors).toEqual([]);
    const ownedActivity = and(
      eq(activity.userId, TEST_USER_ID),
      eq(activity.providerId, "fit-file"),
    );
    const before = await context.db.select().from(activity).where(ownedActivity);
    expect(before).toHaveLength(1);
    expect(before[0]?.raw).toMatchObject({ fitPath: "uploaded.fit" });

    await rm(filePath);
    const replayPath = join(directory, "recovered.fit");
    await archive.storage.materializeArtifact(archivedKey(bytes), replayPath);
    expect(await readFile(replayPath)).toEqual(bytes);
    const replay = await importFitFile(
      context.db,
      sourceData(replayPath),
      async () => {},
      capture.publisher,
      archive.storage,
    );
    expect(replay.errors).toEqual([]);
    const after = await context.db.select().from(activity).where(ownedActivity);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.externalId).toBe(before[0]?.externalId);
    expect(archive.writes).toEqual([archivedKey(bytes)]);
  });

  it("retains byte-exact malformed provider input even when native decoding fails", async () => {
    const bytes = Buffer.from("malformed original Wahoo FIT");
    const filePath = join(directory, "download.fit");
    await writeFile(filePath, bytes);
    const result = await importFitFile(
      context.db,
      sourceData(filePath, "wahoo"),
      async () => {},
      undefined,
      archive.storage,
    );
    expect(result.errors).toHaveLength(1);
    expect(result.recordsSynced).toBe(0);
    await rm(filePath);
    const replayPath = join(directory, "recovered.fit");
    await archive.storage.materializeArtifact(archivedKey(bytes, "wahoo"), replayPath);
    expect(await readFile(replayPath)).toEqual(bytes);
  });

  it("retains FIT file types that the current importer does not consume", async () => {
    const encoder = new Encoder();
    encoder.writeMesg({ mesgNum: Profile.MesgNum.FILE_ID, type: "monitoringB" });
    const bytes = Buffer.from(encoder.close());
    const filePath = join(directory, "monitoring.fit");
    await writeFile(filePath, bytes);
    const result = await importFitFile(
      context.db,
      sourceData(filePath, "garmin-dump"),
      async () => {},
      undefined,
      archive.storage,
    );
    expect(result).toEqual({ recordsSynced: 0, errors: [] });
    expect(archive.originals.get(archivedKey(bytes, "garmin-dump"))).toEqual(bytes);
  });

  it("does not decode or persist when the original cannot be archived", async () => {
    archive.server.use(
      http.put(
        `${endpoint}/imports/*`,
        () =>
          new HttpResponse(
            "<Error><Code>AccessDenied</Code><Message>Archive write denied</Message></Error>",
            { status: 403, headers: { "Content-Type": "application/xml" } },
          ),
      ),
    );
    const bytes = await readFile(new URL("../fit/fixtures/test.fit", import.meta.url));
    const filePath = join(directory, "source.fit");
    await writeFile(filePath, bytes);
    const capture = createCapturingMetricStreamPublisher();
    await expect(
      importFitFile(
        context.db,
        sourceData(filePath),
        async () => {},
        capture.publisher,
        archive.storage,
      ),
    ).rejects.toMatchObject({
      name: "OriginalFitRetentionError",
      cause: expect.objectContaining({ message: "Archive write denied" }),
    });
    expect(await readFile(filePath)).toEqual(bytes);
    expect(await context.db.select().from(activity)).toEqual([]);
    expect(capture.publishedMetricStreamRows).toEqual([]);
    expect(capture.deletedMetricStreamScopes).toEqual([]);
  });
});
