import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decoder, Encoder, Profile, Stream, Utils } from "@garmin/fitsdk";
import { UnrecoverableError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import type { ParsedFitRecord, ParsedFitSession } from "../fit/parser.ts";
import {
  FitDecoderError,
  type FitStreamConsumer,
  type FitStreamResult,
} from "../fit/stream-decoder.ts";
import { processFitFileImportJob } from "./process-fit-file-import-job.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockReplaceMetricStreamBatch = vi.fn().mockResolvedValue(undefined);
const mockWriteMetricStreamBatch = vi.fn().mockResolvedValue(undefined);
const mockWriteMetricStreamBatchForScope = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/metric-stream-writer.ts", () => ({
  replaceMetricStreamBatch: (...args: unknown[]) => mockReplaceMetricStreamBatch(...args),
  writeMetricStreamBatch: (...args: unknown[]) => mockWriteMetricStreamBatch(...args),
  writeMetricStreamBatchForScope: (...args: unknown[]) =>
    mockWriteMetricStreamBatchForScope(...args),
}));

const mockUpsertProviderActivity = vi.fn().mockResolvedValue({ id: "activity-row-1" });
const mockFindUniqueProviderActivityByExactIdentity = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/provider-activity-sync.ts", () => ({
  findUniqueProviderActivityByExactIdentity: (...args: unknown[]) =>
    mockFindUniqueProviderActivityByExactIdentity(...args),
  upsertProviderActivity: (...args: unknown[]) => mockUpsertProviderActivity(...args),
}));

const mockStreamFitFile = vi.fn();
vi.mock("../fit/stream-decoder.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../fit/stream-decoder.ts")>();
  return {
    ...actual,
    streamFitFile: (...arguments_: unknown[]) => mockStreamFitFile(...arguments_),
  };
});

const mockFitImportDroppedFieldOccurrencesTotalAdd = vi.fn();
const mockFitImportFilesWithDroppedFieldTotalAdd = vi.fn();
vi.mock("../sync-metrics.ts", () => ({
  fitImportDroppedFieldOccurrencesTotal: {
    add: (...args: unknown[]) => mockFitImportDroppedFieldOccurrencesTotalAdd(...args),
  },
  fitImportFilesWithDroppedFieldTotal: {
    add: (...args: unknown[]) => mockFitImportFilesWithDroppedFieldTotalAdd(...args),
  },
}));

const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
vi.mock("../logger.ts", () => ({
  logger: {
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

const mockDb: SyncDatabase = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

const createdDirectories: string[] = [];

interface TestFitActivity {
  session: ParsedFitSession;
  records: ParsedFitRecord[];
  laps: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

function createFitFileImportJob(data: unknown) {
  return {
    data,
    updateProgress: vi.fn().mockResolvedValue(undefined),
  };
}

async function writeTempFit(buffer: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fit-file-import-test-"));
  createdDirectories.push(directory);
  const filePath = join(directory, "input.fit");
  await writeFile(filePath, buffer);
  return filePath;
}

async function fitImportSpoolDirectories(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((entry) => entry.startsWith("dofek-fit-import-")).sort();
}

function createActivityFit(): Buffer {
  const timestamp = Utils.convertDateToDateTime(new Date("2026-07-01T12:00:00.000Z"));
  const encoder = new Encoder();
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    timeCreated: timestamp,
  });
  return Buffer.from(encoder.close());
}

function createActivityFitWithNumericFileType(): Buffer {
  const timestamp = Utils.convertDateToDateTime(new Date("2026-07-01T12:00:00.000Z"));
  const encoder = new Encoder();
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: 8,
    timeCreated: timestamp,
  });
  return Buffer.from(encoder.close());
}

function createWeightFit(): Buffer {
  const timestamp = Utils.convertDateToDateTime(new Date("2026-07-01T12:00:00.000Z"));
  const encoder = new Encoder();
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "weight",
    timeCreated: timestamp,
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.WEIGHT_SCALE,
    timestamp,
    weight: 72,
    percentFat: 18.5,
    percentHydration: 55.2,
    boneMass: 3.1,
    muscleMass: 31.2,
    bmi: 24.1,
  });
  return Buffer.from(encoder.close());
}

function createWeightFileOnlyFit(): Buffer {
  const timestamp = Utils.convertDateToDateTime(new Date("2026-07-01T12:00:00.000Z"));
  const encoder = new Encoder();
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "weight",
    timeCreated: timestamp,
  });
  return Buffer.from(encoder.close());
}

function createNonWeightTypeWithScaleFit(): Buffer {
  const timestamp = Utils.convertDateToDateTime(new Date("2026-07-01T12:00:00.000Z"));
  const encoder = new Encoder();
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "activity",
    timeCreated: timestamp,
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.WEIGHT_SCALE,
    timestamp,
    weight: 72,
    percentFat: 18.5,
    percentHydration: 55.2,
    boneMass: 3.1,
    muscleMass: 31.2,
    bmi: 24.1,
  });
  return Buffer.from(encoder.close());
}

const generatedFitSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  messages: z
    .object({
      fileIdMesgs: z
        .array(z.object({ type: z.union([z.string(), z.number()]).optional() }).passthrough())
        .optional(),
      weightScaleMesgs: z
        .array(
          z
            .object({
              timestamp: z.union([z.date(), z.string()]),
              weight: z.number().optional(),
              percentFat: z.number().optional(),
              percentHydration: z.number().optional(),
              boneMass: z.number().optional(),
              muscleMass: z.number().optional(),
              bmi: z.number().optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .optional(),
});

function defaultFitActivity(): TestFitActivity {
  return {
    session: {
      sport: "cycling",
      subSport: "indoor_cycling",
      startTime: new Date("2026-07-01T12:00:00.000Z"),
      totalElapsedTime: 1800,
      totalTimerTime: 1800,
      totalDistance: 5000,
      raw: { sport: "cycling", sub_sport: "indoor_cycling" },
    },
    records: [
      {
        recordedAt: new Date("2026-07-01T12:01:00.000Z"),
        heartRate: 130,
        power: 180,
        speed: 8.5,
        raw: { heart_rate: 130, power: 180, enhanced_speed: 8.5 },
      },
    ],
    laps: [],
    events: [],
  };
}

async function streamActivity(
  activity: TestFitActivity,
  consumer: FitStreamConsumer,
): Promise<FitStreamResult> {
  await consumer.onMetadata({
    fileType: 4,
    fileTypeName: "activity",
    fieldOccurrences: [],
    isWeightFile: false,
    session: activity.session,
  });
  for (let offset = 0; offset < activity.records.length; offset += 250) {
    await consumer.onRecordBatch(activity.records.slice(offset, offset + 250));
  }
  return { messageCount: activity.records.length };
}

function mockActivityStreamOnce(activity: TestFitActivity): void {
  mockStreamFitFile.mockImplementationOnce(async (_filePath: string, consumer: FitStreamConsumer) =>
    streamActivity(activity, consumer),
  );
}

async function streamGeneratedTestFit(
  filePath: string,
  consumer: FitStreamConsumer,
): Promise<FitStreamResult> {
  let decoded: z.infer<typeof generatedFitSchema>;
  try {
    decoded = generatedFitSchema.parse(
      new Decoder(Stream.fromBuffer(await readFile(filePath))).read(),
    );
  } catch (error) {
    throw new FitDecoderError("FIT decoder reported invalid data", { cause: error });
  }
  if ((decoded.errors?.length ?? 0) > 0) {
    throw new FitDecoderError(`FIT decoder reported ${decoded.errors?.length ?? 0} errors`);
  }
  const fileType = decoded.messages?.fileIdMesgs?.find(
    (message) => message.type !== undefined,
  )?.type;
  const weightRows = decoded.messages?.weightScaleMesgs ?? [];
  const isWeightFile = fileType === "weight" || fileType === 9 || weightRows.length > 0;
  if (fileType === "monitoringB") {
    await consumer.onMetadata({
      fileType: 32,
      fileTypeName: "monitoring_b",
      fieldOccurrences: [
        { messageType: "file_id", field: "type", occurrences: 1 },
        { messageType: "file_id", field: "time_created", occurrences: 1 },
        { messageType: "stress_level", field: "stress_level_time", occurrences: 1 },
        { messageType: "stress_level", field: "stress_level_value", occurrences: 1 },
      ],
      isWeightFile: false,
      session: null,
    });
    return { messageCount: 0 };
  }
  if (!isWeightFile) {
    return streamActivity(defaultFitActivity(), consumer);
  }

  await consumer.onMetadata({
    fileType: typeof fileType === "number" ? fileType : 9,
    fileTypeName: "weight",
    fieldOccurrences: [
      { messageType: "file_id", field: "type", occurrences: 1 },
      { messageType: "file_id", field: "time_created", occurrences: 1 },
    ],
    isWeightFile: true,
    session: null,
  });
  const weights = weightRows.map((weight) => ({
    timestamp: weight.timestamp instanceof Date ? weight.timestamp : new Date(weight.timestamp),
    weight: weight.weight,
    percentFat: weight.percentFat,
    percentHydration: weight.percentHydration,
    boneMass: weight.boneMass,
    muscleMass: weight.muscleMass,
    bmi: weight.bmi,
    raw: weight,
  }));
  if (weights.length > 0) {
    await consumer.onWeightBatch(weights);
  }
  return { messageCount: weights.length };
}

function createMonitoringFit(): Buffer {
  const timestamp = Utils.convertDateToDateTime(new Date("2020-05-21T03:31:00.000Z"));
  const stressTimestamp = Utils.convertDateToDateTime(new Date("2020-05-21T03:32:00.000Z"));
  const encoder = new Encoder();
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: "monitoringB",
    timeCreated: timestamp,
  });
  encoder.writeMesg({
    mesgNum: Profile.MesgNum.STRESS_LEVEL,
    stressLevelTime: stressTimestamp,
    stressLevelValue: -1,
  });
  return Buffer.from(encoder.close());
}

describe("processFitFileImportJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureException.mockClear();
    mockFindUniqueProviderActivityByExactIdentity.mockResolvedValue(undefined);
    mockUpsertProviderActivity.mockResolvedValue({ id: "activity-row-1" });
    mockReplaceMetricStreamBatch.mockResolvedValue(undefined);
    mockWriteMetricStreamBatch.mockResolvedValue(undefined);
    mockWriteMetricStreamBatchForScope.mockResolvedValue(undefined);
    mockStreamFitFile.mockImplementation(streamGeneratedTestFit);
  });

  afterEach(async () => {
    await Promise.all(
      createdDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("fails jobs without a file path or extraction child without retrying", async () => {
    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          originalPath: "DI_CONNECT/activity.fit",
          userId: "user-1",
          providerId: "garmin-dump",
          sourceName: "Garmin Dump",
        }),
        mockDb,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message:
          "Failed to import FIT file activity.fit: FIT import job is missing filePath and has no child extraction result",
      }),
    );
    expect(mockStreamFitFile).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("propagates unexpected extraction lookup failures for BullMQ retries", async () => {
    const redisError = new Error("Redis child lookup failed");
    const job = {
      ...createFitFileImportJob({
        originalPath: "DI_CONNECT/activity.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      getChildrenValues: vi.fn().mockRejectedValue(redisError),
      getIgnoredChildrenFailures: vi.fn().mockResolvedValue({}),
    };

    await expect(processFitFileImportJob(job, mockDb)).rejects.toBe(redisError);

    expect(mockStreamFitFile).not.toHaveBeenCalled();
  });

  it("retains parent-owned temp files when queue payload validation fails", async () => {
    const filePath = await writeTempFit(createActivityFit());

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: "DI_CONNECT/activity.fit",
          userId: "user-1",
          providerId: "garmin-dump",
        }),
        mockDb,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(mockLoggerError).toHaveBeenCalledWith(
      "Failed to import FIT file %s: %s",
      "activity.fit",
      expect.any(String),
    );
    expect(mockStreamFitFile).not.toHaveBeenCalled();
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("keeps the sanitized file name in error messages when job data has extra fields", async () => {
    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          originalPath: "DI_CONNECT/activity.fit",
          ignored: "extra",
        }),
        mockDb,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        message: expect.stringContaining("Failed to import FIT file activity.fit:"),
      }),
    );
  });

  it("imports an activity FIT file with a parent summary and replaces sensor samples", async () => {
    const filePath = await writeTempFit(createActivityFit());

    const job = createFitFileImportJob({
      filePath,
      originalPath: "DI_CONNECT/activity_12345.fit",
      userId: "user-1",
      providerId: "garmin-dump",
      sourceName: "Garmin Dump",
      activitySummary: {
        externalId: "12345",
        activityType: {
          canonicalType: "cycling",
          providerType: "cycling",
          modality: null,
        },
        startedAtIso: "2026-07-01T12:00:00.000Z",
        endedAtIso: "2026-07-01T12:30:00.000Z",
        name: "Morning Ride",
        raw: { activityId: 12345 },
      },
    });
    const result = await processFitFileImportJob(job, mockDb);

    expect(result).toEqual({ recordsSynced: 0, errors: [] });
    expect(mockStreamFitFile).toHaveBeenCalledWith(filePath, expect.any(Object));
    expect(mockFindUniqueProviderActivityByExactIdentity).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        externalId: "12345",
        activityType: {
          canonicalType: "cycling",
          providerType: "cycling",
          modality: null,
        },
        startedAt: new Date("2026-07-01T12:00:00.000Z"),
        endedAt: new Date("2026-07-01T12:30:00.000Z"),
        name: "Morning Ride",
        raw: { activityId: 12345 },
      }),
      expect.objectContaining({ name: "Morning Ride", raw: { activityId: 12345 } }),
    );
    expect(mockReplaceMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      { activityId: "activity-row-1" },
      [],
      "file",
    );
    expect(mockWriteMetricStreamBatchForScope).toHaveBeenCalledWith(
      mockDb,
      { activityId: "activity-row-1" },
      [
        expect.objectContaining({
          providerId: "garmin-dump",
          activityId: "activity-row-1",
          userId: "user-1",
          heartRate: 130,
          power: 180,
          recordedAt: new Date("2026-07-01T12:01:00.000Z"),
        }),
      ],
      "file",
    );
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting FIT file import...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 10,
      message: "Reading FIT file...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 25,
      message: "Decoding FIT file...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 50,
      message: "Importing FIT activity...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 80,
      message: "Writing FIT activity data...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "FIT file import complete.",
    });
  });

  it("reuses the exact Garmin dump summary when its external id differs from the FIT filename", async () => {
    const filePath = await writeTempFit(createActivityFit());
    const activity = defaultFitActivity();
    activity.session = {
      ...activity.session,
      sport: "hiking",
      subSport: "generic",
      startTime: new Date("2022-05-17T17:23:08.000Z"),
      totalElapsedTime: 6011.201,
    };
    mockActivityStreamOnce(activity);
    mockFindUniqueProviderActivityByExactIdentity.mockResolvedValueOnce({
      id: "garmin-summary-row",
    });

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/asher@example.com_137399316854.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(mockFindUniqueProviderActivityByExactIdentity).toHaveBeenCalledWith(mockDb, {
      providerId: "garmin-dump",
      userId: "user-1",
      canonicalType: "hiking",
      startedAt: new Date("2022-05-17T17:23:08.000Z"),
      endedAt: new Date("2022-05-17T19:03:19.201Z"),
    });
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockReplaceMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      { activityId: "garmin-summary-row" },
      [],
      "file",
    );
  });

  it("does not match non-Garmin FIT imports by Garmin summary identity", async () => {
    const filePath = await writeTempFit(createActivityFit());

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "wahoo_workout-42.fit",
        userId: "user-1",
        providerId: "wahoo",
        sourceName: "Wahoo",
      }),
      mockDb,
    );

    expect(mockFindUniqueProviderActivityByExactIdentity).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity).toHaveBeenCalledOnce();
  });

  it("deletes a job-owned downloaded FIT file after a successful import", async () => {
    const filePath = await writeTempFit(createActivityFit());

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "wahoo_workout-42.fit",
        userId: "user-1",
        providerId: "wahoo",
        sourceName: "Wahoo",
        deleteFileAfterImport: true,
        activitySummary: {
          externalId: "workout-42",
          activityType: {
            canonicalType: "cycling",
            providerType: "cycling",
            modality: null,
          },
          startedAtIso: "2026-07-01T12:00:00.000Z",
          name: "Morning ride",
        },
      }),
      mockDb,
    );

    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        endedAt: new Date("2026-07-01T12:30:00.000Z"),
      }),
      expect.any(Object),
    );
  });

  it("deletes a job-owned downloaded FIT file after an unrecoverable decode failure", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockStreamFitFile.mockRejectedValueOnce(new FitDecoderError("invalid FIT CRC"));

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: "coros_workout-7.fit",
          userId: "user-1",
          providerId: "coros",
          sourceName: "COROS",
          deleteFileAfterImport: true,
        }),
        mockDb,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a job-owned downloaded FIT file for a retryable persistence failure", async () => {
    const filePath = await writeTempFit(createActivityFit());
    const databaseError = new Error("Redpanda unavailable");
    mockUpsertProviderActivity.mockRejectedValueOnce(databaseError);

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: "suunto_workout-9.fit",
          userId: "user-1",
          providerId: "suunto",
          sourceName: "Suunto",
          deleteFileAfterImport: true,
        }),
        mockDb,
      ),
    ).rejects.toBe(databaseError);

    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("does not mutate activity data when the decoder fails after a record batch", async () => {
    const filePath = await writeTempFit(createActivityFit());
    const activity = defaultFitActivity();
    const spoolDirectoriesBefore = await fitImportSpoolDirectories();
    mockStreamFitFile.mockImplementationOnce(
      async (_filePath: string, consumer: FitStreamConsumer) => {
        await consumer.onMetadata({
          fileType: 4,
          fileTypeName: "activity",
          fieldOccurrences: [],
          isWeightFile: false,
          session: activity.session,
        });
        await consumer.onRecordBatch(activity.records);
        throw new FitDecoderError("invalid final message count");
      },
    );

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: "DI_CONNECT/activity_12345.fit",
          userId: "user-1",
          providerId: "garmin-dump",
          sourceName: "Garmin Dump",
        }),
        mockDb,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockReplaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(mockWriteMetricStreamBatchForScope).not.toHaveBeenCalled();
    await expect(fitImportSpoolDirectories()).resolves.toEqual(spoolDirectoriesBefore);
  });

  it("fails without mutations when the decoder completes without metadata", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockStreamFitFile.mockResolvedValueOnce({ messageCount: 0 });

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: "DI_CONNECT/activity_12345.fit",
          userId: "user-1",
          providerId: "garmin-dump",
          sourceName: "Garmin Dump",
        }),
        mockDb,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockReplaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(mockWriteMetricStreamBatchForScope).not.toHaveBeenCalled();
  });

  it("replaces activity sensor samples in bounded batches", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockActivityStreamOnce({
      session: {
        sport: "cycling",
        subSport: "indoor_cycling",
        startTime: new Date("2026-07-01T12:00:00.000Z"),
        totalElapsedTime: 1800,
        totalTimerTime: 1800,
        totalDistance: 5000,
        raw: { sport: "cycling", sub_sport: "indoor_cycling" },
      },
      records: Array.from({ length: 501 }, (_, index) => ({
        recordedAt: new Date(1_783_425_660_000 + index * 1_000),
        heartRate: 130,
        raw: { heart_rate: 130 },
      })),
      laps: [],
      events: [],
    });

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/activity_12345.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
        activitySummary: {
          externalId: "12345",
          activityType: {
            canonicalType: "cycling",
            providerType: "cycling",
            modality: null,
          },
          startedAtIso: "2026-07-01T12:00:00.000Z",
          endedAtIso: "2026-07-01T12:30:00.000Z",
          name: "Morning Ride",
          raw: { activityId: 12345 },
        },
      }),
      mockDb,
    );

    expect(mockReplaceMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      { activityId: "activity-row-1" },
      [],
      "file",
    );
    expect(mockWriteMetricStreamBatchForScope).toHaveBeenCalledTimes(3);
    expect(mockWriteMetricStreamBatchForScope.mock.calls.map(([, , rows]) => rows.length)).toEqual([
      250, 250, 1,
    ]);
  });

  it("uses the supplied metric stream publisher for activity writes", async () => {
    const filePath = await writeTempFit(createActivityFit());
    const activity = defaultFitActivity();
    mockActivityStreamOnce(activity);
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => []),
      replaceRows: vi.fn(async () => {
        throw new Error("replaceRows should be delegated");
      }),
    };

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/activity_12345.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
        activitySummary: {
          externalId: "12345",
          activityType: {
            canonicalType: "cycling",
            providerType: "cycling",
            modality: null,
          },
          startedAtIso: "2026-07-01T12:00:00.000Z",
          endedAtIso: "2026-07-01T12:30:00.000Z",
          name: "Morning Ride",
        },
      }),
      mockDb,
      metricStreamPublisher,
    );

    expect(mockReplaceMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      { activityId: "activity-row-1" },
      [],
      "file",
      metricStreamPublisher,
    );
    expect(mockWriteMetricStreamBatchForScope).toHaveBeenCalledWith(
      mockDb,
      { activityId: "activity-row-1" },
      expect.any(Array),
      "file",
      metricStreamPublisher,
    );
  });

  it("rejects an activity publisher without scoped replacement before mutation", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockActivityStreamOnce(defaultFitActivity());

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: "DI_CONNECT/activity_12345.fit",
          userId: "user-1",
          providerId: "garmin-dump",
          sourceName: "Garmin Dump",
        }),
        mockDb,
        { publishRows: vi.fn(async () => []) },
      ),
    ).rejects.toThrow("FIT activity imports require a scoped replacement publisher");
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockReplaceMetricStreamBatch).not.toHaveBeenCalled();
  });

  it("uses the supplied metric stream publisher for weight writes", async () => {
    const filePath = await writeTempFit(createWeightFit());
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => []),
    };

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/weight.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
      metricStreamPublisher,
    );

    expect(mockWriteMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      expect.any(Array),
      "file",
      undefined,
      metricStreamPublisher,
    );
  });

  it("accepts FIT files with numeric file_id.type from Garmin exports", async () => {
    const filePath = await writeTempFit(createActivityFitWithNumericFileType());

    const result = await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/unknown_filetype.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
        activitySummary: {
          externalId: "12345",
          activityType: {
            canonicalType: "cycling",
            providerType: "cycling",
            modality: null,
          },
          startedAtIso: "2026-07-01T12:00:00.000Z",
          endedAtIso: "2026-07-01T12:30:00.000Z",
          name: "Morning Ride",
          raw: { activityId: 12345 },
        },
      }),
      mockDb,
    );

    expect(result).toEqual({ recordsSynced: 0, errors: [] });
    expect(mockUpsertProviderActivity).toHaveBeenCalledOnce();
  });

  it("accepts monitoring FIT files without importing derived stress data", async () => {
    const filePath = await writeTempFit(createMonitoringFit());

    const result = await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/monitoring.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(result).toEqual({ recordsSynced: 0, errors: [] });
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockWriteMetricStreamBatch).not.toHaveBeenCalled();
    expect(mockFitImportDroppedFieldOccurrencesTotalAdd).toHaveBeenCalledWith(1, {
      provider: "garmin-dump",
      file_type: "monitoringB",
      message_type: "stressLevelMesgs",
      field: "stressLevelValue",
      reason: "derived",
    });
    expect(mockFitImportFilesWithDroppedFieldTotalAdd).toHaveBeenCalledWith(1, {
      provider: "garmin-dump",
      file_type: "monitoringB",
      message_type: "stressLevelMesgs",
      field: "stressLevelValue",
      reason: "derived",
    });
  });

  it("imports a FIT-only activity when no parent summary exists", async () => {
    const filePath = await writeTempFit(createActivityFit());

    const result = await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/asher@example.com_activity.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(result).toEqual({ recordsSynced: 1, errors: [] });
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        externalId: expect.stringMatching(/^fit:[a-f0-9]{32}$/),
        activityType: {
          canonicalType: "cycling",
          providerType: "indoor_cycling",
          modality: "indoor",
        },
        startedAt: new Date("2026-07-01T12:00:00.000Z"),
        endedAt: new Date("2026-07-01T12:30:00.000Z"),
        name: "FIT cycling",
        raw: {
          fitPath: "DI_CONNECT/asher@example.com_activity.fit",
          session: { sport: "cycling", sub_sport: "indoor_cycling" },
        },
      }),
      expect.objectContaining({ name: "FIT cycling" }),
    );
    expect(mockReplaceMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      { activityId: "activity-row-1" },
      [],
      "file",
    );
    expect(mockWriteMetricStreamBatchForScope).toHaveBeenCalledWith(
      mockDb,
      { activityId: "activity-row-1" },
      [
        expect.objectContaining({
          providerId: "garmin-dump",
          activityId: "activity-row-1",
          userId: "user-1",
          heartRate: 130,
          power: 180,
          recordedAt: new Date("2026-07-01T12:01:00.000Z"),
        }),
      ],
      "file",
    );
  });

  it("imports a FIT file from a flow child extraction result", async () => {
    const filePath = await writeTempFit(createActivityFit());
    const getChildrenValues = vi.fn().mockResolvedValue({
      "bull:zip-entry-extract:1": { filePath },
    });

    const result = await processFitFileImportJob(
      {
        data: {
          originalPath: "DI_CONNECT/asher@example.com_activity.fit",
          userId: "user-1",
          providerId: "garmin-dump",
          sourceName: "Garmin Dump",
        },
        getChildrenValues,
        updateProgress: vi.fn().mockResolvedValue(undefined),
      },
      mockDb,
    );

    expect(result).toEqual({ recordsSynced: 1, errors: [] });
    expect(getChildrenValues).toHaveBeenCalledOnce();
    expect(mockUpsertProviderActivity).toHaveBeenCalledOnce();
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("preserves an ignored extraction child's exact failure cause", async () => {
    await expect(
      processFitFileImportJob(
        {
          data: {
            originalPath: "DI_CONNECT/activity.fit",
            userId: "user-1",
            providerId: "garmin-dump",
            sourceName: "Garmin Dump",
          },
          getChildrenValues: async () => ({}),
          getIgnoredChildrenFailures: async () => ({
            "bull:zip-entry-extract:extract-1": "archive CRC mismatch",
          }),
          updateProgress: vi.fn().mockResolvedValue(undefined),
        },
        mockDb,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message:
          "Failed to import FIT file activity.fit: FIT extraction failed: archive CRC mismatch",
      }),
    );
  });

  it("retains parent-owned flow extraction files when job data validation fails", async () => {
    const filePath = await writeTempFit(createActivityFit());

    await expect(
      processFitFileImportJob(
        {
          data: {
            originalPath: "DI_CONNECT/asher@example.com_activity.fit",
            userId: "user-1",
            sourceName: "Garmin Dump",
          },
          getChildrenValues: async () => ({
            "bull:zip-entry-extract:1": { filePath },
          }),
          updateProgress: vi.fn().mockResolvedValue(undefined),
        },
        mockDb,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("fails FIT flow jobs with multiple extraction results without retrying", async () => {
    await expect(
      processFitFileImportJob(
        {
          data: {
            originalPath: "DI_CONNECT/asher@example.com_activity.fit",
            userId: "user-1",
            providerId: "garmin-dump",
            sourceName: "Garmin Dump",
          },
          getChildrenValues: async () => ({
            "bull:zip-entry-extract:1": { filePath: "/tmp/one.fit" },
            "bull:zip-entry-extract:2": { filePath: "/tmp/two.fit" },
          }),
          updateProgress: vi.fn().mockResolvedValue(undefined),
        },
        mockDb,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message:
          "Failed to import FIT file [redacted]_activity.fit: FIT import job expected 1 child extraction result, got 2",
      }),
    );
  });

  it("extracts numeric activity IDs from FIT file names", async () => {
    const filePath = await writeTempFit(createActivityFit());

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/asher@example.com_98765_extra.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        externalId: "98765",
      }),
      expect.objectContaining({
        activityType: {
          canonicalType: "cycling",
          providerType: "indoor_cycling",
          modality: "indoor",
        },
      }),
    );
  });

  it("normalizes FIT sport text and falls back to other for unknown sports", async () => {
    const virtualRideFilePath = await writeTempFit(createActivityFit());
    mockActivityStreamOnce({
      session: {
        sport: "cycling",
        subSport: "virtualActivity",
        startTime: new Date("2026-07-01T11:00:00.000Z"),
        totalElapsedTime: 1200,
        totalTimerTime: 1200,
        totalDistance: 4000,
        raw: { sport: "cycling", sub_sport: "virtualActivity" },
      },
      records: [],
      laps: [],
      events: [],
    });

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath: virtualRideFilePath,
        originalPath: "DI_CONNECT/virtual.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(mockUpsertProviderActivity).toHaveBeenLastCalledWith(
      mockDb,
      expect.objectContaining({
        activityType: {
          canonicalType: "cycling",
          providerType: "virtualActivity",
          modality: "indoor",
        },
        name: "FIT cycling",
      }),
      expect.objectContaining({
        activityType: {
          canonicalType: "cycling",
          providerType: "virtualActivity",
          modality: "indoor",
        },
        name: "FIT cycling",
      }),
    );

    const trailRunFilePath = await writeTempFit(createActivityFit());
    mockActivityStreamOnce({
      session: {
        sport: "Trail  Running",
        startTime: new Date("2026-07-01T12:00:00.000Z"),
        totalElapsedTime: 900,
        totalTimerTime: 900,
        totalDistance: 3000,
        raw: { sport: "Trail  Running" },
      },
      records: [],
      laps: [],
      events: [],
    });

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath: trailRunFilePath,
        originalPath: "DI_CONNECT/trail.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(mockUpsertProviderActivity).toHaveBeenLastCalledWith(
      mockDb,
      expect.objectContaining({
        activityType: {
          canonicalType: "running",
          providerType: "Trail  Running",
          modality: "trail",
        },
        name: "FIT running",
      }),
      expect.objectContaining({
        activityType: {
          canonicalType: "running",
          providerType: "Trail  Running",
          modality: "trail",
        },
        name: "FIT running",
      }),
    );

    const unknownSportFilePath = await writeTempFit(createActivityFit());
    mockActivityStreamOnce({
      session: {
        sport: "pickleball",
        startTime: new Date("2026-07-01T13:00:00.000Z"),
        totalElapsedTime: 600,
        totalTimerTime: 600,
        totalDistance: 0,
        raw: { sport: "pickleball" },
      },
      records: [],
      laps: [],
      events: [],
    });

    await processFitFileImportJob(
      createFitFileImportJob({
        filePath: unknownSportFilePath,
        originalPath: "DI_CONNECT/unknown.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(mockUpsertProviderActivity).toHaveBeenLastCalledWith(
      mockDb,
      expect.objectContaining({
        activityType: {
          canonicalType: "other",
          providerType: "pickleball",
          modality: null,
        },
        name: "FIT other",
      }),
      expect.objectContaining({
        activityType: {
          canonicalType: "other",
          providerType: "pickleball",
          modality: null,
        },
        name: "FIT other",
      }),
    );
  });

  it("fails activity FIT files missing a valid start time without retrying", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockActivityStreamOnce({
      session: {
        sport: "cycling",
        startTime: new Date("invalid"),
        totalElapsedTime: 1800,
        totalTimerTime: 1800,
        totalDistance: 5000,
        raw: { sport: "cycling" },
      },
      records: [],
      laps: [],
      events: [],
    });

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: "DI_CONNECT/missing-start.fit",
          userId: "user-1",
          providerId: "garmin-dump",
          sourceName: "Garmin Dump",
        }),
        mockDb,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message: "Failed to import FIT file missing-start.fit: missing a valid start time",
      }),
    );
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockReplaceMetricStreamBatch).not.toHaveBeenCalled();
  });

  it("skips sensor replacement when the activity upsert returns no row ID", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockUpsertProviderActivity.mockResolvedValueOnce({});

    const result = await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/no-row-id.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(result).toEqual({ recordsSynced: 1, errors: [] });
    expect(mockUpsertProviderActivity).toHaveBeenCalledOnce();
    expect(mockReplaceMetricStreamBatch).not.toHaveBeenCalled();
  });

  it("imports weight FIT files as body measurement metric stream rows", async () => {
    const filePath = await writeTempFit(createWeightFit());
    const job = createFitFileImportJob({
      filePath,
      originalPath: "DI_CONNECT/asher@example.com_20260701_weight.fit",
      userId: "user-1",
      providerId: "garmin-dump",
      sourceName: "Garmin Dump",
    });

    const result = await processFitFileImportJob(job, mockDb);

    expect(result).toEqual({ recordsSynced: 1, errors: [] });
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockWriteMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      [
        expect.objectContaining({
          providerId: "garmin-dump",
          userId: "user-1",
          externalId: expect.stringMatching(/^weight:[a-f0-9]{64}:2026-07-01T12:00:00\.000Z$/),
          recordedAt: new Date("2026-07-01T12:00:00.000Z"),
          sourceName: "Garmin Dump",
          weightKg: 72,
          bodyFatPct: 18.5,
          waterPct: 55.2,
          boneMassKg: 3.1,
          muscleMassKg: 31.2,
          bmi: 24.1,
        }),
      ],
      "file",
    );
    const serializedWrite = JSON.stringify(mockWriteMetricStreamBatch.mock.calls[0]);
    expect(serializedWrite).not.toContain("DI_CONNECT/asher@example.com_20260701_weight.fit");
    expect(serializedWrite).not.toContain("asher@example.com");
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 50,
      message: "Importing FIT weight data...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 80,
      message: "Writing FIT weight data...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "FIT file import complete.",
    });
    expect(mockFitImportDroppedFieldOccurrencesTotalAdd).toHaveBeenCalledWith(1, {
      provider: "garmin-dump",
      file_type: "weight",
      message_type: "fileIdMesgs",
      field: "timeCreated",
      reason: "unsupported",
    });
  });

  it("continues FIT import when progress updates fail", async () => {
    const progressError = new Error("redis down");
    const filePath = await writeTempFit(createWeightFit());
    const job = createFitFileImportJob({
      filePath,
      originalPath: "DI_CONNECT/asher@example.com_20260701_weight.fit",
      userId: "user-1",
      providerId: "garmin-dump",
      sourceName: "Garmin Dump",
    });
    job.updateProgress = vi.fn().mockRejectedValue(progressError);

    const result = await processFitFileImportJob(job, mockDb);

    expect(result).toEqual({ recordsSynced: 1, errors: [] });
    expect(mockWriteMetricStreamBatch).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(progressError, {
      tags: { fitImportStep: "updateProgress" },
    });
  });

  it("returns zero records for weight FIT files without scale rows", async () => {
    const filePath = await writeTempFit(createWeightFileOnlyFit());

    const result = await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/empty_weight.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(result).toEqual({ recordsSynced: 0, errors: [] });
    expect(mockWriteMetricStreamBatch).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
  });

  it("treats FIT files with weight scale data but non-weight file type as weight data", async () => {
    const filePath = await writeTempFit(createNonWeightTypeWithScaleFit());

    const result = await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/mismatched_type.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(result.recordsSynced).toBeGreaterThan(0);
    expect(mockWriteMetricStreamBatch).toHaveBeenCalled();
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
  });

  it("fails invalid FIT files without retrying before attempting activity parsing", async () => {
    const filePath = await writeTempFit(Buffer.from("not a fit file"));

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: "DI_CONNECT/broken.fit",
          userId: "user-1",
          providerId: "garmin-dump",
          sourceName: "Garmin Dump",
        }),
        mockDb,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message: expect.stringContaining(
          "Failed to import FIT file broken.fit: FIT decoder reported",
        ),
      }),
    );
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("fails FIT activity parser errors without retrying", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockStreamFitFile.mockRejectedValueOnce(new FitDecoderError("invalid FIT session"));
    const job = createFitFileImportJob({
      filePath,
      originalPath: "DI_CONNECT/broken-session.fit",
      userId: "user-1",
      providerId: "garmin-dump",
      sourceName: "Garmin Dump",
    });

    await expect(processFitFileImportJob(job, mockDb)).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message: "Failed to import FIT file broken-session.fit: invalid FIT session",
      }),
    );
    expect(job.updateProgress).not.toHaveBeenCalledWith({
      percentage: 100,
      message: "FIT file import complete.",
    });
  });

  it("redacts Garmin paths from telemetry, logs, and persisted failures", async () => {
    const filePath = await writeTempFit(createActivityFit());
    const privatePath = "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_broken-session.fit";
    mockStreamFitFile.mockRejectedValueOnce(
      new FitDecoderError(`FIT parser rejected ${privatePath}`),
    );

    await expect(
      processFitFileImportJob(
        createFitFileImportJob({
          filePath,
          originalPath: privatePath,
          userId: "user-1",
          providerId: "garmin-dump",
          sourceName: "Garmin Dump",
        }),
        mockDb,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "UnrecoverableError",
        message:
          "Failed to import FIT file [redacted]_broken-session.fit: FIT parser rejected [redacted]_broken-session.fit",
      }),
    );
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(privatePath);
    expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain("asher@example.com");
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("propagates transient database failures for BullMQ retries", async () => {
    const filePath = await writeTempFit(createActivityFit());
    const databaseError = new Error("database connection reset");
    mockUpsertProviderActivity.mockRejectedValueOnce(databaseError);

    const job = createFitFileImportJob({
      filePath,
      originalPath: "DI_CONNECT/activity.fit",
      userId: "user-1",
      providerId: "garmin-dump",
      sourceName: "Garmin Dump",
    });

    await expect(processFitFileImportJob(job, mockDb)).rejects.toBe(databaseError);
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);

    await expect(processFitFileImportJob(job, mockDb)).resolves.toEqual({
      recordsSynced: 1,
      errors: [],
    });
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
  });
});
