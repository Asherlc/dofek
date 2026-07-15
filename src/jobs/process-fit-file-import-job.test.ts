import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder, Profile, Utils } from "@garmin/fitsdk";
import { UnrecoverableError } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { processFitFileImportJob } from "./process-fit-file-import-job.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockReplaceMetricStreamBatch = vi.fn().mockResolvedValue(undefined);
const mockWriteMetricStreamBatch = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/metric-stream-writer.ts", () => ({
  replaceMetricStreamBatch: (...args: unknown[]) => mockReplaceMetricStreamBatch(...args),
  writeMetricStreamBatch: (...args: unknown[]) => mockWriteMetricStreamBatch(...args),
}));

const mockUpsertProviderActivity = vi.fn().mockResolvedValue({ id: "activity-row-1" });
vi.mock("../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: (...args: unknown[]) => mockUpsertProviderActivity(...args),
}));

const mockParseFitFileInWorkerThread = vi.fn().mockResolvedValue({
  session: {
    sport: "cycling",
    subSport: "indoor_cycling",
    startTime: new Date("2026-07-01T12:00:00.000Z"),
    totalElapsedTime: 1800,
    totalTimerTime: 1800,
    totalDistance: 5000,
    totalCalories: 200,
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
});
vi.mock("../fit/parser-worker.ts", () => ({
  parseFitFileInWorkerThread: (...args: unknown[]) => mockParseFitFileInWorkerThread(...args),
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

describe("processFitFileImportJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureException.mockClear();
    mockUpsertProviderActivity.mockResolvedValue({ id: "activity-row-1" });
    mockReplaceMetricStreamBatch.mockResolvedValue(undefined);
    mockWriteMetricStreamBatch.mockResolvedValue(undefined);
    mockParseFitFileInWorkerThread.mockResolvedValue({
      session: {
        sport: "cycling",
        subSport: "indoor_cycling",
        startTime: new Date("2026-07-01T12:00:00.000Z"),
        totalElapsedTime: 1800,
        totalTimerTime: 1800,
        totalDistance: 5000,
        totalCalories: 200,
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
    });
  });

  afterEach(async () => {
    await Promise.all(
      createdDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("fails jobs without a file path or extraction child non-retryably", async () => {
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
          "Failed to import FIT file DI_CONNECT/activity.fit: FIT import job is missing filePath and has no child extraction result",
      }),
    );
    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { fitImportStep: "process" },
      extra: { originalPath: "DI_CONNECT/activity.fit" },
    });
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

    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
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
      "DI_CONNECT/activity.fit",
      expect.any(String),
    );
    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("keeps originalPath for error messages when job data has extra fields", async () => {
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
        message: expect.stringContaining("Failed to import FIT file DI_CONNECT/activity.fit:"),
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
        activityType: "cycling",
        startedAtIso: "2026-07-01T12:00:00.000Z",
        endedAtIso: "2026-07-01T12:30:00.000Z",
        name: "Morning Ride",
        raw: { activityId: 12345 },
      },
    });
    const result = await processFitFileImportJob(job, mockDb);

    expect(result).toEqual({ recordsSynced: 0, errors: [] });
    expect(mockParseFitFileInWorkerThread).toHaveBeenCalledWith(createActivityFit());
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        externalId: "12345",
        activityType: "cycling",
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
        activityType: "indoor_cycling",
        startedAt: new Date("2026-07-01T12:00:00.000Z"),
        endedAt: new Date("2026-07-01T12:30:00.000Z"),
        name: "FIT indoor cycling",
        raw: {
          fitPath: "DI_CONNECT/asher@example.com_activity.fit",
          session: { sport: "cycling", sub_sport: "indoor_cycling" },
        },
      }),
      expect.objectContaining({ name: "FIT indoor cycling" }),
    );
    expect(mockReplaceMetricStreamBatch).toHaveBeenCalledWith(
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
          "Failed to import FIT file DI_CONNECT/activity.fit: FIT extraction failed: archive CRC mismatch",
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

  it("fails FIT flow jobs with multiple extraction results non-retryably", async () => {
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
          "Failed to import FIT file DI_CONNECT/asher@example.com_activity.fit: FIT import job expected 1 child extraction result, got 2",
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
        activityType: "indoor_cycling",
      }),
    );
  });

  it("normalizes FIT sport text and falls back to other for unknown sports", async () => {
    const virtualRideFilePath = await writeTempFit(createActivityFit());
    mockParseFitFileInWorkerThread.mockResolvedValueOnce({
      session: {
        sport: "cycling",
        subSport: "virtualActivity",
        startTime: new Date("2026-07-01T11:00:00.000Z"),
        totalElapsedTime: 1200,
        totalTimerTime: 1200,
        totalDistance: 4000,
        totalCalories: 150,
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
        activityType: "indoor_cycling",
        name: "FIT indoor cycling",
      }),
      expect.objectContaining({
        activityType: "indoor_cycling",
        name: "FIT indoor cycling",
      }),
    );

    const trailRunFilePath = await writeTempFit(createActivityFit());
    mockParseFitFileInWorkerThread.mockResolvedValueOnce({
      session: {
        sport: "Trail  Running",
        startTime: new Date("2026-07-01T12:00:00.000Z"),
        totalElapsedTime: 900,
        totalTimerTime: 900,
        totalDistance: 3000,
        totalCalories: 100,
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
        activityType: "trail_running",
        name: "FIT trail running",
      }),
      expect.objectContaining({
        activityType: "trail_running",
        name: "FIT trail running",
      }),
    );

    const unknownSportFilePath = await writeTempFit(createActivityFit());
    mockParseFitFileInWorkerThread.mockResolvedValueOnce({
      session: {
        sport: "pickleball",
        startTime: new Date("2026-07-01T13:00:00.000Z"),
        totalElapsedTime: 600,
        totalTimerTime: 600,
        totalDistance: 0,
        totalCalories: 50,
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
        activityType: "other",
        name: "FIT other",
      }),
      expect.objectContaining({
        activityType: "other",
        name: "FIT other",
      }),
    );
  });

  it("fails activity FIT files missing a valid start time non-retryably", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockParseFitFileInWorkerThread.mockResolvedValueOnce({
      session: {
        sport: "cycling",
        startTime: new Date("invalid"),
        totalElapsedTime: 1800,
        totalTimerTime: 1800,
        totalDistance: 5000,
        totalCalories: 200,
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
        message:
          "Failed to import FIT file DI_CONNECT/missing-start.fit: missing a valid start time",
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

  it("imports Garmin weight FIT files as body measurement metric stream rows", async () => {
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
    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    expect(mockWriteMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      [
        expect.objectContaining({
          providerId: "garmin-dump",
          userId: "user-1",
          externalId:
            "weight:DI_CONNECT/asher@example.com_20260701_weight.fit:2026-07-01T12:00:00.000Z",
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
    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
  });

  it("fails invalid FIT files non-retryably before attempting activity parsing", async () => {
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
          "Failed to import FIT file DI_CONNECT/broken.fit: FIT decoder reported",
        ),
      }),
    );
    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    await expect(readFile(filePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("fails FIT activity parser errors non-retryably", async () => {
    const filePath = await writeTempFit(createActivityFit());
    mockParseFitFileInWorkerThread.mockRejectedValueOnce(new Error("invalid FIT session"));
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
        message: "Failed to import FIT file DI_CONNECT/broken-session.fit: invalid FIT session",
      }),
    );
    expect(job.updateProgress).not.toHaveBeenCalledWith({
      percentage: 100,
      message: "FIT file import complete.",
    });
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
