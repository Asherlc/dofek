import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder, Profile, Utils } from "@garmin/fitsdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import type { FitStreamConsumer } from "../fit/stream-decoder.ts";
import { exactLambertsWorkout } from "../fit/test-helpers.ts";
import { makeTransactionalTestDatabase } from "../providers/test-helpers.ts";
import { importFitFile } from "./process-fit-file-import-job.ts";

vi.mock("../provider-artifact-storage.ts", () => ({
  createProviderArtifactStorageFromEnv: () => ({
    retainFile: vi
      .fn()
      .mockResolvedValue(`provider-artifacts/user-1/fit-file/${"a".repeat(64)}.fit`),
  }),
}));
vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));
vi.mock("../db/metric-stream-writer.ts", () => ({
  replaceMetricStreamBatch: vi.fn().mockResolvedValue(undefined),
  writeMetricStreamBatch: vi.fn().mockResolvedValue(undefined),
  writeMetricStreamBatchForScope: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db/provider-activity-sync.ts", () => ({
  findUniqueProviderActivityByExactIdentity: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-row-1" }),
}));

const mockStreamFitFile = vi.fn();
const mockReplaceActivityDeviceObservations = vi.fn();
vi.mock("../db/activity-device-observations.ts", () => ({
  replaceActivityDeviceObservations: (...args: unknown[]) =>
    mockReplaceActivityDeviceObservations(...args),
}));
vi.mock("../db/fit-workout-intervals.ts", () => ({
  replaceFitWorkoutIntervals: vi.fn(),
}));
vi.mock("../fit/stream-decoder.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fit/stream-decoder.ts")>();
  return {
    ...actual,
    streamFitFile: (...arguments_: unknown[]) => mockStreamFitFile(...arguments_),
  };
});
vi.mock("../sync-metrics.ts", () => ({
  fitImportDroppedFieldOccurrencesTotal: { add: vi.fn() },
  fitImportFilesWithDroppedFieldTotal: { add: vi.fn() },
}));
vi.mock("../logger.ts", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));

const mockDb: SyncDatabase = makeTransactionalTestDatabase({
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
});

const createdDirectories: string[] = [];

async function writeTempFit(buffer: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fit-lamberts-import-test-"));
  createdDirectories.push(directory);
  const filePath = join(directory, "input.fit");
  await writeFile(filePath, buffer);
  return filePath;
}

function createActivityFit(): Buffer {
  const encoder = new Encoder();
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    timeCreated: Utils.convertDateToDateTime(new Date("2026-07-01T12:00:00.000Z")),
  });
  return Buffer.from(encoder.close());
}

function cyclingSession() {
  return {
    sport: "cycling",
    subSport: "indoor_cycling",
    startTime: new Date("2026-07-01T12:00:00.000Z"),
    totalElapsedTime: 1800,
    totalTimerTime: 1800,
    totalDistance: 5000,
    raw: { sport: "cycling", sub_sport: "indoor_cycling" },
  };
}

describe("importFitFile Lamberts workout structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReplaceActivityDeviceObservations.mockImplementation(async (_db, _scope, batches) => {
      for await (const _batch of batches) {
        /* consume the staged batches */
      }
    });
  });

  afterEach(async () => {
    await Promise.all(
      createdDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("passes the matched Lamberts workout to FIT observation storage after decoding", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockStreamFitFile.mockImplementationOnce(async (_path: string, consumer: FitStreamConsumer) => {
      const messages = exactLambertsWorkout();
      await consumer.onMetadata({
        fileId: { type: 4 },
        fileType: 4,
        fileTypeName: "activity",
        fieldOccurrences: [
          { messageType: "file_id", field: "time_created", occurrences: 2 },
          { messageType: "device_info", field: "type", occurrences: 3 },
          { messageType: "file_id", field: "type", occurrences: 1 },
        ],
        isWeightFile: false,
        session: cyclingSession(),
        recoveryError: null,
      });
      await consumer.onWorkoutStructureBatch?.(messages.slice(0, 5));
      await consumer.onWorkoutStructureBatch?.(messages.slice(5));
      expect(mockReplaceActivityDeviceObservations).not.toHaveBeenCalled();
      return { messageCount: messages.length };
    });

    await importFitFile(
      mockDb,
      { filePath, originalPath: "activity.fit", userId: "user-1", providerId: "garmin" },
      async () => {},
    );
    expect(mockReplaceActivityDeviceObservations.mock.calls[0]?.[3]).toMatchObject({
      workout: { wkt_name: " LSCT " },
      intervals: [
        { segment: "lsct_stage_1" },
        { segment: "lsct_calibration" },
        { segment: "lsct_stage_2" },
        { segment: "lsct_stage_3" },
        { segment: "lsct_recovery" },
      ],
    });
  });

  it.each([
    { label: "unsupported activity sport", cycling: false },
    { label: "partial file recovery", recoveryError: "Damaged tail" },
    { label: "chained FIT files", fileCount: 2 },
    { label: "undeclared FIT file count", fileCount: 0 },
    { label: "excess workout structure across batches", overflow: true },
  ])("keeps an otherwise exact workout out of test history with $label", async (scenario) => {
    const filePath = await writeTempFit(createActivityFit());
    mockStreamFitFile.mockImplementationOnce(async (_path: string, consumer: FitStreamConsumer) => {
      const session = cyclingSession();
      const messages = exactLambertsWorkout();
      const fileCount = scenario.fileCount ?? 1;
      await consumer.onMetadata({
        fileId: { type: 4 },
        fileType: 4,
        fileTypeName: "activity",
        fieldOccurrences:
          fileCount === 0
            ? []
            : [{ messageType: "file_id", field: "type", occurrences: fileCount }],
        isWeightFile: false,
        session:
          scenario.cycling === false
            ? {
                ...session,
                sport: "running",
                subSport: "generic",
                raw: { sport: "running" },
              }
            : session,
        recoveryError: scenario.recoveryError ?? null,
      });
      await consumer.onWorkoutStructureBatch?.(messages);
      if (scenario.overflow) {
        await consumer.onWorkoutStructureBatch?.([{ messageType: "workout", raw: {} }]);
        await consumer.onWorkoutStructureBatch?.([
          { messageType: "lap", raw: { wkt_step_index: 0 } },
        ]);
      }
      return { messageCount: messages.length + (scenario.overflow ? 2 : 0) };
    });

    await importFitFile(
      mockDb,
      { filePath, originalPath: "activity.fit", userId: "user-1", providerId: "garmin" },
      async () => {},
    );
    expect(mockReplaceActivityDeviceObservations).toHaveBeenCalledTimes(1);
    expect(mockReplaceActivityDeviceObservations.mock.calls[0]?.[3]).toBeNull();
  });
});
