import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder, Profile, Utils } from "@garmin/fitsdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import { processFitFileImportJob } from "./process-fit-file-import-job.ts";

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
vi.mock("../logger.ts", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
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

  it("rejects invalid queue payloads before reading a file", async () => {
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
    ).rejects.toThrow();

    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
  });

  it("cleans up temp files when queue payload validation fails", async () => {
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
    ).rejects.toThrow();

    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    await expect(readFile(filePath)).rejects.toThrow();
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
    await expect(readFile(filePath)).rejects.toThrow();
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting FIT file import...",
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

  it("reports activity FIT files missing a valid start time", async () => {
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

    const result = await processFitFileImportJob(
      createFitFileImportJob({
        filePath,
        originalPath: "DI_CONNECT/missing-start.fit",
        userId: "user-1",
        providerId: "garmin-dump",
        sourceName: "Garmin Dump",
      }),
      mockDb,
    );

    expect(result).toEqual({
      recordsSynced: 0,
      errors: [{ message: "FIT file DI_CONNECT/missing-start.fit is missing a valid start time" }],
    });
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
    await expect(readFile(filePath)).rejects.toThrow();
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 50,
      message: "Importing FIT weight data...",
    });
    expect(job.updateProgress).toHaveBeenCalledWith({
      percentage: 100,
      message: "FIT file import complete.",
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

  it("fails invalid FIT files before attempting activity parsing", async () => {
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
    ).rejects.toThrow("FIT decoder reported");

    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    await expect(readFile(filePath)).rejects.toThrow();
  });
});
