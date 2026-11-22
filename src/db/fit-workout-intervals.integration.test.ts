import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder, Profile } from "@garmin/fitsdk";
import { asc, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importFitFile } from "../jobs/process-fit-file-import-job.ts";
import { createCapturingMetricStreamPublisher } from "../providers/test-helpers.ts";
import { createProviderArtifactStorageTestContext } from "../test-helpers.ts";
import { activity, activityInterval } from "./schema/activity.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

const archive = createProviderArtifactStorageTestContext("https://r2.fit-workout-intervals.test");
let context: TestContext;
let directory: string;

function sourceData(filePath: string, providerId = "fit-file") {
  return { filePath, originalPath: "uploaded_12345.fit", userId: TEST_USER_ID, providerId };
}

beforeAll(async () => {
  archive.server.activate({ onUnhandledFrame: "error" });
  context = await setupTestDatabase();
  await ensureProvider(context.db, "fit-file", "FIT File", undefined, TEST_USER_ID);
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fit-workout-intervals-"));
  await context.db.delete(activity);
  await context.db.delete(activityInterval);
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

const workoutStart = new Date("2026-07-01T12:00:00.000Z");

interface WorkoutFixtureLap {
  stepIndex: number;
  offsetSeconds: number;
  timerSeconds: number | undefined;
  elapsedSeconds: number;
}

function workoutFitBytes(options: {
  sport?: string;
  steps: Array<{ low: number; high: number; targetType?: string; durationValue?: number }>;
  laps: WorkoutFixtureLap[];
  withWorkout?: boolean;
}): Buffer {
  const encoder = new Encoder();
  const at = (offsetSeconds: number) => new Date(workoutStart.getTime() + offsetSeconds * 1000);
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    manufacturer: "development",
    product: 1,
    timeCreated: workoutStart,
  });
  if (options.withWorkout !== false) {
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.WORKOUT,
      sport: "cycling",
      numValidSteps: options.steps.length,
      wktName: "Test workout",
    });
    options.steps.forEach((step, index) => {
      encoder.writeMesg({
        mesgNum: Profile.MesgNum.WORKOUT_STEP,
        messageIndex: index,
        wktStepName: `Step ${index}`,
        durationType: "time",
        durationValue: step.durationValue ?? 180000,
        targetType: step.targetType ?? "power",
        targetValue: 0,
        customTargetValueLow: step.low,
        customTargetValueHigh: step.high,
        intensity: "active",
      });
    });
  }
  const elapsedEnd = Math.max(...options.laps.map((lap) => lap.offsetSeconds + lap.elapsedSeconds));
  for (let second = 0; second < elapsedEnd; second += 5) {
    encoder.writeMesg({ mesgNum: Profile.MesgNum.RECORD, timestamp: at(second), power: 200 });
  }
  options.laps.forEach((lap, index) => {
    encoder.writeMesg({
      mesgNum: Profile.MesgNum.LAP,
      messageIndex: index,
      timestamp: at(lap.offsetSeconds + lap.elapsedSeconds),
      startTime: at(lap.offsetSeconds),
      totalElapsedTime: lap.elapsedSeconds,
      ...(lap.timerSeconds === undefined ? {} : { totalTimerTime: lap.timerSeconds }),
      wktStepIndex: lap.stepIndex,
    });
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.SESSION,
    timestamp: at(elapsedEnd),
    startTime: workoutStart,
    totalElapsedTime: elapsedEnd,
    totalTimerTime: elapsedEnd,
    sport: options.sport ?? "cycling",
    firstLapIndex: 0,
    numLaps: options.laps.length,
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.ACTIVITY,
    timestamp: at(elapsedEnd),
    numSessions: 1,
    type: "manual",
  });
  return Buffer.from(encoder.close());
}

async function importWorkoutFit(bytes: Buffer, name: string) {
  const filePath = join(directory, name);
  await writeFile(filePath, bytes);
  const result = await importFitFile(
    context.db,
    sourceData(filePath),
    async () => {},
    createCapturingMetricStreamPublisher().publisher,
    archive.storage,
  );
  expect(result.errors).toEqual([]);
}

async function fitIntervals() {
  return context.db
    .select()
    .from(activityInterval)
    .orderBy(asc(activityInterval.startedAt), asc(activityInterval.intervalIndex));
}

describe("FIT workout step interval import", () => {
  const rangeLaps: WorkoutFixtureLap[] = [
    { stepIndex: 0, offsetSeconds: 0, timerSeconds: 180, elapsedSeconds: 180 },
    { stepIndex: 0, offsetSeconds: 180, timerSeconds: 134, elapsedSeconds: 145 },
    { stepIndex: 1, offsetSeconds: 325, timerSeconds: 180, elapsedSeconds: 180 },
  ];
  const steps = [
    { low: 1250, high: 1265 },
    { low: 1260, high: 1260 },
  ];

  it("stores repeated lap links with range, point, planned and timer facts, replacing on reimport", async () => {
    await importWorkoutFit(workoutFitBytes({ steps, laps: rangeLaps }), "a.fit");
    const rows = await fitIntervals();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.fitSource)).toEqual(Array(3).fill("workout_step_lap"));
    expect(rows.map((row) => row.sourceKind)).toEqual(Array(3).fill("provider_recorded"));
    expect(rows.map((row) => row.sourceProvider)).toEqual(Array(3).fill("fit-file"));
    expect(rows.map((row) => row.plannedDurationSeconds)).toEqual([180, 180, 180]);
    expect(rows.map((row) => row.recordedTimerDurationSeconds)).toEqual([180, 134, 180]);
    expect(rows.map((row) => row.targetPowerMinWatts)).toEqual([250, 250, null]);
    expect(rows.map((row) => row.targetPowerMaxWatts)).toEqual([265, 265, null]);
    expect(rows.map((row) => row.targetPowerWatts)).toEqual([null, null, 260]);
    expect(rows[1]?.endedAt?.toISOString()).toBe("2026-07-01T12:05:25.000Z");

    await importWorkoutFit(workoutFitBytes({ steps, laps: rangeLaps }), "a-again.fit");
    expect(await fitIntervals()).toHaveLength(3);
  });

  it("clears stale FIT rows on reimport, preserving unrelated interval rows and other activities", async () => {
    await importWorkoutFit(workoutFitBytes({ steps, laps: rangeLaps }), "a.fit");
    const [owner] = await context.db.select().from(activity);
    if (!owner) throw new Error("Expected imported activity");
    await context.db.insert(activityInterval).values({
      activityId: owner.id,
      intervalIndex: 99,
      startedAt: workoutStart,
      endedAt: new Date(workoutStart.getTime() + 60_000),
      sourceKind: "inferred",
    });
    await importWorkoutFit(
      workoutFitBytes({ steps: [{ low: 90, high: 105 }], laps: rangeLaps.slice(0, 1) }),
      "a.fit",
    );
    const rows = await context.db.select().from(activityInterval);
    expect(rows.filter((row) => row.fitSource !== null)).toEqual([]);
    expect(rows.filter((row) => row.fitSource === null)).toHaveLength(1);
  });

  const ineligibleFiles: Array<[string, Partial<Parameters<typeof workoutFitBytes>[0]>]> = [
    ["noncycling", { sport: "running" }],
    ["no workout header", { withWorkout: false }],
    [
      "relative target",
      {
        steps: [
          { low: 90, high: 105 },
          { low: 80, high: 80 },
        ],
      },
    ],
    [
      "non-power target",
      {
        steps: [
          { low: 1250, high: 1265, targetType: "heartRate" },
          { low: 1, high: 1 },
        ],
      },
    ],
  ];
  it.each(ineligibleFiles)("stores no intervals for a %s file", async (_name, overrides) => {
    await importWorkoutFit(workoutFitBytes({ steps, laps: rangeLaps, ...overrides }), "b.fit");
    expect(await fitIntervals()).toEqual([]);
  });

  it("keeps a missing lap timer null", async () => {
    await importWorkoutFit(
      workoutFitBytes({
        steps,
        laps: [{ stepIndex: 0, offsetSeconds: 0, timerSeconds: undefined, elapsedSeconds: 180 }],
      }),
      "c.fit",
    );
    const rows = await fitIntervals();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recordedTimerDurationSeconds).toBeNull();
    expect(
      await context.db.select().from(activityInterval).where(isNull(activityInterval.fitSource)),
    ).toEqual([]);
  });

  it("enforces the FIT interval storage contract, including NULL source, end and planned time", async () => {
    await importWorkoutFit(workoutFitBytes({ steps, laps: rangeLaps }), "a.fit");
    const [owner] = await context.db.select().from(activity);
    if (!owner) throw new Error("Expected imported activity");
    const valid = {
      activityId: owner.id,
      intervalIndex: 50,
      startedAt: workoutStart,
      endedAt: new Date(workoutStart.getTime() + 60_000),
      sourceKind: "provider_recorded" as const,
      fitSource: "workout_step_lap" as const,
      plannedDurationSeconds: 60,
      targetPowerWatts: 200,
    };
    const invalid = [
      { ...valid, sourceKind: null },
      { ...valid, sourceKind: "inferred" as const },
      { ...valid, endedAt: null },
      { ...valid, endedAt: workoutStart },
      { ...valid, plannedDurationSeconds: null },
      { ...valid, plannedDurationSeconds: 0 },
      { ...valid, recordedTimerDurationSeconds: -1 },
      { ...valid, targetPowerWatts: null },
      { ...valid, targetPowerMinWatts: 200, targetPowerMaxWatts: 250 },
      { ...valid, targetPowerWatts: null, targetPowerMinWatts: 250, targetPowerMaxWatts: 200 },
      { ...valid, targetPowerWatts: null, targetPowerMinWatts: 250 },
      { ...valid, fitSource: null },
    ];
    for (const row of invalid) {
      await expect(context.db.insert(activityInterval).values(row)).rejects.toThrow();
    }
    await context.db.insert(activityInterval).values({ ...valid, recordedTimerDurationSeconds: 0 });
    const [zero] = await context.db
      .select()
      .from(activityInterval)
      .where(eq(activityInterval.intervalIndex, 50));
    expect(zero?.recordedTimerDurationSeconds).toBe(0);
  });
});
