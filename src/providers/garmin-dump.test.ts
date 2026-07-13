import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Encoder, Profile, Utils } from "@garmin/fitsdk";
import archiver from "archiver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import {
  GARMIN_DUMP_PROVIDER_ID,
  GarminDumpProvider,
  importGarminDumpFile,
  mapGarminDumpActivityType,
  parseGarminDumpFile,
} from "./garmin-dump.ts";

type FileStats = Awaited<ReturnType<typeof stat>>;

interface FsPromisesMock {
  statOverride: ((filePath: string) => Promise<FileStats>) | null;
}

const fsPromisesMock = vi.hoisted<FsPromisesMock>(() => ({
  statOverride: null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      if (fsPromisesMock.statOverride) {
        return fsPromisesMock.statOverride(String(args[0]));
      }
      return actual.stat(...args);
    },
  };
});

const mockEnsureProvider = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: (...args: unknown[]) => mockEnsureProvider(...args),
}));

const mockUpsertProviderActivity = vi.fn().mockResolvedValue({ id: "activity-row-1" });
vi.mock("../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: (...args: unknown[]) => mockUpsertProviderActivity(...args),
}));

interface FlowJobForTest {
  name: string;
  queueName: string;
  data: unknown;
  opts?: unknown;
  children?: FlowJobForTest[];
}

const flowMock = vi.hoisted(() => {
  const waitUntilFinished = vi.fn();
  const queueEvents = {};
  const add = vi.fn(async (flow: FlowJobForTest) => ({
    job: {
      waitUntilFinished: () => waitUntilFinished(flow),
    },
  }));
  return { add, queueEvents, waitUntilFinished };
});

vi.mock("../jobs/queues.ts", () => ({
  FIT_FILE_IMPORT_BATCH_QUEUE: "fit-file-import-batch",
  FIT_FILE_IMPORT_QUEUE: "fit-file-import",
  ZIP_ENTRY_EXTRACT_QUEUE: "zip-entry-extract",
  getFitFileImportBatchQueueEvents: () => flowMock.queueEvents,
  getFlowProducer: () => ({ add: flowMock.add }),
}));

const mockReplaceMetricStreamBatch = vi.fn().mockResolvedValue(undefined);
const mockWriteMetricStreamBatch = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/metric-stream-writer.ts", () => ({
  replaceMetricStreamBatch: (...args: unknown[]) => mockReplaceMetricStreamBatch(...args),
  writeMetricStreamBatch: (...args: unknown[]) => mockWriteMetricStreamBatch(...args),
}));

const mockParseFitFile = vi.fn().mockResolvedValue({
  session: {
    sport: "cycling",
    startTime: new Date("2026-07-01T12:00:00.000Z"),
    totalElapsedTime: 1800,
    totalTimerTime: 1800,
    totalDistance: 5000,
    totalCalories: 200,
    raw: { sport: "cycling" },
  },
  records: [
    {
      recordedAt: new Date("2026-07-01T12:01:00.000Z"),
      heartRate: 130,
      power: 180,
      raw: { heart_rate: 130, power: 180 },
    },
  ],
  laps: [],
  events: [],
});
vi.mock("../fit/parser.ts", () => ({
  parseFitFile: (...args: unknown[]) => mockParseFitFile(...args),
}));

const mockParseFitFileInWorkerThread = vi.fn().mockResolvedValue({
  session: {
    sport: "cycling",
    startTime: new Date("2026-07-01T12:00:00.000Z"),
    totalElapsedTime: 1800,
    totalTimerTime: 1800,
    totalDistance: 5000,
    totalCalories: 200,
    raw: { sport: "cycling" },
  },
  records: [
    {
      recordedAt: new Date("2026-07-01T12:01:00.000Z"),
      heartRate: 130,
      power: 180,
      raw: { heart_rate: 130, power: 180 },
    },
  ],
  laps: [],
  events: [],
});
vi.mock("../fit/parser-worker.ts", () => ({
  parseFitFileInWorkerThread: (...args: unknown[]) => mockParseFitFileInWorkerThread(...args),
}));

const mockDb: SyncDatabase = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

const createdDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "garmin-dump-test-"));
  createdDirectories.push(directory);
  return directory;
}

async function createZip(entries: Record<string, Buffer | string>): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 1 } });
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const finished = new Promise<Buffer>((resolve, reject) => {
    stream.on("close", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(stream);
  for (const [path, data] of Object.entries(entries)) {
    archive.append(data, { name: path });
  }
  await archive.finalize();
  return finished;
}

async function createGarminDumpZip(): Promise<string> {
  const nestedFitZip = await createZip({
    "asher@example.com_12345.fit": Buffer.from("fit-bytes"),
    "asher@example.com_999_weight.fit": createWeightFit(),
  });
  const topLevelZip = await createZip({
    "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": JSON.stringify([
      {
        summarizedActivitiesExport: [
          {
            activityId: 12345,
            name: "Morning Ride",
            activityType: "cycling",
            sportType: "CYCLING",
            startTimeGmt: Date.parse("2026-07-01T12:00:00.000Z"),
            duration: 1800000,
            locationName: "Oakland",
          },
        ],
      },
    ]),
    "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip": nestedFitZip,
  });

  const directory = await createTempDirectory();
  const filePath = join(directory, "garmin-export.zip");
  await writeFile(filePath, topLevelZip);
  return filePath;
}

async function waitUntil(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < 50; attemptIndex++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
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

describe("Garmin dump provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsPromisesMock.statOverride = null;
    mockUpsertProviderActivity.mockResolvedValue({ id: "activity-row-1" });
    mockReplaceMetricStreamBatch.mockResolvedValue(undefined);
    mockWriteMetricStreamBatch.mockResolvedValue(undefined);
    mockEnsureProvider.mockResolvedValue(undefined);
    flowMock.add.mockImplementation(async (flow: FlowJobForTest) => ({
      job: {
        waitUntilFinished: () => flowMock.waitUntilFinished(flow),
      },
    }));
    flowMock.waitUntilFinished.mockResolvedValue({ recordsSynced: 0, errors: [] });
    mockParseFitFile.mockResolvedValue({
      session: {
        sport: "cycling",
        startTime: new Date("2026-07-01T12:00:00.000Z"),
        totalElapsedTime: 1800,
        totalTimerTime: 1800,
        totalDistance: 5000,
        totalCalories: 200,
        raw: { sport: "cycling" },
      },
      records: [
        {
          recordedAt: new Date("2026-07-01T12:01:00.000Z"),
          heartRate: 130,
          power: 180,
          raw: { heart_rate: 130, power: 180 },
        },
      ],
      laps: [],
      events: [],
    });
    mockParseFitFileInWorkerThread.mockResolvedValue({
      session: {
        sport: "cycling",
        startTime: new Date("2026-07-01T12:00:00.000Z"),
        totalElapsedTime: 1800,
        totalTimerTime: 1800,
        totalDistance: 5000,
        totalCalories: 200,
        raw: { sport: "cycling" },
      },
      records: [
        {
          recordedAt: new Date("2026-07-01T12:01:00.000Z"),
          heartRate: 130,
          power: 180,
          raw: { heart_rate: 130, power: 180 },
        },
      ],
      laps: [],
      events: [],
    });
  });

  afterEach(async () => {
    fsPromisesMock.statOverride = null;
    await Promise.all(
      createdDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  function latestFlow(): FlowJobForTest {
    const flow = flowMock.add.mock.calls.at(-1)?.[0];
    if (!flow) {
      throw new Error("Expected a BullMQ flow to be created");
    }
    return flow;
  }

  function latestFitFlowChildren(): FlowJobForTest[] {
    return latestFlow().children ?? [];
  }

  it("is an import-only provider", () => {
    const provider = new GarminDumpProvider();

    expect(provider.id).toBe(GARMIN_DUMP_PROVIDER_ID);
    expect(provider.name).toBe("Garmin Dump");
    expect(provider.importOnly).toBe(true);
    expect(provider.validate()).toBeNull();
  });

  it("maps Garmin activity names to canonical activity types", () => {
    expect(mapGarminDumpActivityType("cycling")).toBe("cycling");
    expect(mapGarminDumpActivityType("virtual_ride")).toBe("indoor_cycling");
    expect(mapGarminDumpActivityType(undefined, "HIKING")).toBe("hiking");
    expect(mapGarminDumpActivityType("Trail  Running")).toBe("trail_running");
    expect(mapGarminDumpActivityType("mountain-biking")).toBe("cycling");
    expect(mapGarminDumpActivityType(undefined, undefined)).toBe("other");
  });

  it("parses summarized activities and nested uploaded FIT zip entries", async () => {
    const filePath = await createGarminDumpZip();

    const parsed = await parseGarminDumpFile(filePath);

    expect(parsed.errors).toEqual([]);
    expect(parsed.summaries).toHaveLength(1);
    expect(parsed.summaries[0]?.activityId).toBe(12345);
    expect(parsed.fitFiles.map((entry) => entry.path)).toEqual([
      "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_12345.fit",
    ]);
    expect(parsed.weightFitFiles.map((entry) => entry.path)).toEqual([
      "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_999_weight.fit",
    ]);
  });

  it("parses extracted Garmin dump directories recursively", async () => {
    const directory = await createTempDirectory();
    const nestedDirectory = join(directory, "DI_CONNECT", "DI-Connect-Fitness");
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(
      join(nestedDirectory, "asher_0_summarizedActivities.json"),
      JSON.stringify([
        {
          summarizedActivitiesExport: [
            {
              activityId: "dir-activity",
              activityType: "running",
              beginTimestamp: Date.parse("2026-07-02T12:00:00.000Z"),
              elapsedDuration: 1200000,
            },
          ],
        },
      ]),
    );
    await writeFile(join(nestedDirectory, "asher@example.com_dir-activity.fit"), "fit-bytes");

    const parsed = await parseGarminDumpFile(directory);

    expect(parsed.errors).toEqual([]);
    expect(parsed.summaries[0]?.activityId).toBe("dir-activity");
    expect(parsed.fitFiles.map((entry) => entry.path)).toEqual([
      "DI_CONNECT/DI-Connect-Fitness/asher@example.com_dir-activity.fit",
    ]);
  });

  it("reports malformed summarized activity files without dropping valid FIT files", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": "{broken",
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const parsed = await parseGarminDumpFile(filePath);

    expect(parsed.summaries).toEqual([]);
    expect(parsed.fitFiles.map((entry) => entry.path)).toEqual([
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit",
    ]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.message).toContain("Failed to parse Garmin summarized activities");
  });

  it("skips irrelevant nested zip entries instead of buffering them", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": JSON.stringify([
        {
          summarizedActivitiesExport: [
            {
              activityId: 12345,
              activityType: "cycling",
              startTimeGmt: Date.parse("2026-07-01T12:00:00.000Z"),
              duration: 1800000,
            },
          ],
        },
      ]),
      "DI_CONNECT/DI-Connect-Routing/courses.zip": "not a zip",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const parsed = await parseGarminDumpFile(filePath);

    expect(parsed.errors).toEqual([]);
    expect(parsed.summaries.map((summary) => summary.activityId)).toEqual([12345]);
    expect(parsed.fitFiles).toEqual([]);
    expect(parsed.weightFitFiles).toEqual([]);
  });

  it("rejects oversized Garmin dump files before reading them", async () => {
    const directory = await createTempDirectory();
    const filePath = join(directory, "too-large.zip");
    await writeFile(filePath, "");
    const actualStats = await stat(filePath);
    fsPromisesMock.statOverride = async () =>
      new Proxy<FileStats>(actualStats, {
        get(target, property, receiver) {
          if (property === "size") return 2 * 1024 * 1024 * 1024 + 1;
          return Reflect.get(target, property, receiver);
        },
      });

    await expect(parseGarminDumpFile(filePath)).rejects.toThrow(
      "Garmin dump upload exceeds maximum size",
    );
  });

  it("rejects non-zip file paths with a clear message", async () => {
    const directory = await createTempDirectory();
    const filePath = join(directory, "activity.fit");
    await writeFile(filePath, "fit-bytes");

    await expect(parseGarminDumpFile(filePath)).rejects.toThrow(
      "Garmin dump import expects a .zip file or extracted export directory",
    );
  });

  it("imports summaries and fans out matching FIT files", async () => {
    const filePath = await createGarminDumpZip();

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([]);
    expect(mockEnsureProvider).toHaveBeenCalledWith(
      mockDb,
      GARMIN_DUMP_PROVIDER_ID,
      "Garmin Dump",
      undefined,
      "user-1",
    );
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        providerId: GARMIN_DUMP_PROVIDER_ID,
        userId: "user-1",
        externalId: "12345",
        activityType: "cycling",
        name: "Morning Ride",
        sourceName: "Garmin Dump",
      }),
      expect.objectContaining({
        activityType: "cycling",
        name: "Morning Ride",
      }),
    );
    expect(flowMock.add).toHaveBeenCalledOnce();
    expect(latestFlow()).toEqual(
      expect.objectContaining({
        name: "fit-file-import-batch",
        queueName: "fit-file-import-batch",
      }),
    );
    const fitChildren = latestFitFlowChildren();
    expect(fitChildren).toHaveLength(2);
    expect(fitChildren[0]).toEqual(
      expect.objectContaining({
        name: "fit-file-import",
        queueName: "fit-file-import",
        data: expect.objectContaining({
          originalPath:
            "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_999_weight.fit",
          userId: "user-1",
          providerId: GARMIN_DUMP_PROVIDER_ID,
          sourceName: "Garmin Dump",
        }),
        opts: expect.objectContaining({
          removeOnComplete: { age: 86_400, count: 1_000 },
          removeOnFail: { age: 604_800, count: 1_000 },
        }),
        children: [
          expect.objectContaining({
            name: "zip-entry-extract",
            queueName: "zip-entry-extract",
            data: expect.objectContaining({
              archivePath: filePath,
              entryPath: [
                "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip",
                "asher@example.com_999_weight.fit",
              ],
            }),
          }),
        ],
      }),
    );
    expect(fitChildren[1]).toEqual(
      expect.objectContaining({
        name: "fit-file-import",
        queueName: "fit-file-import",
        data: expect.objectContaining({
          originalPath:
            "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_12345.fit",
          userId: "user-1",
          providerId: GARMIN_DUMP_PROVIDER_ID,
          sourceName: "Garmin Dump",
          activitySummary: expect.objectContaining({
            externalId: "12345",
            activityType: "cycling",
            name: "Morning Ride",
            raw: expect.objectContaining({ activityId: 12345 }),
          }),
        }),
      }),
    );
    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    expect(mockParseFitFile).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        endedAt: new Date("2026-07-01T12:30:00.000Z"),
        raw: expect.objectContaining({ activityId: 12345 }),
      }),
    );
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("fans out Garmin weight FIT files to child FIT import jobs", async () => {
    flowMock.waitUntilFinished.mockResolvedValue({ recordsSynced: 1, errors: [] });
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_20260701_weight.fit":
        createWeightFit(),
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([]);
    expect(latestFitFlowChildren()).toEqual([
      expect.objectContaining({
        name: "fit-file-import",
        queueName: "fit-file-import",
        data: expect.objectContaining({
          originalPath:
            "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_20260701_weight.fit",
          userId: "user-1",
          providerId: GARMIN_DUMP_PROVIDER_ID,
          sourceName: "Garmin Dump",
        }),
        children: [
          expect.objectContaining({
            queueName: "zip-entry-extract",
            data: expect.objectContaining({
              archivePath: filePath,
              entryPath: [
                "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_20260701_weight.fit",
              ],
            }),
          }),
        ],
      }),
    ]);
    expect(mockWriteMetricStreamBatch).not.toHaveBeenCalled();
    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
  });

  it("passes extracted directory FIT files directly to child FIT import jobs", async () => {
    flowMock.waitUntilFinished.mockResolvedValue({ recordsSynced: 1, errors: [] });
    const directory = await createTempDirectory();
    const nestedDirectory = join(directory, "DI_CONNECT", "DI-Connect-Uploaded-Files");
    await mkdir(nestedDirectory, { recursive: true });
    const extractedFitPath = join(nestedDirectory, "asher@example.com_20260701_weight.fit");
    await writeFile(extractedFitPath, createWeightFit());

    await importGarminDumpFile(mockDb, directory, "user-1");

    expect(latestFitFlowChildren()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          filePath: extractedFitPath,
          originalPath:
            "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_20260701_weight.fit",
        }),
      }),
    ]);
    expect(latestFitFlowChildren()[0]?.children).toBeUndefined();
  });

  it("extends the import job lock before creating the FIT import flow", async () => {
    const filePath = await createGarminDumpZip();
    const extendLock = vi.fn().mockResolvedValue(undefined);

    await importGarminDumpFile(mockDb, filePath, "user-1", { extendLock });

    expect(extendLock).toHaveBeenCalledWith(600_000);
    expect(extendLock.mock.invocationCallOrder[0]).toBeLessThan(
      flowMock.add.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("keeps parse errors in import results and imports FIT-only activities", async () => {
    flowMock.waitUntilFinished.mockResolvedValue({ recordsSynced: 1, errors: [] });
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": "{broken",
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_activity.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(1);
    expect(result.errors[0]?.message).toContain("Failed to parse Garmin summarized activities");
    expect(latestFitFlowChildren()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          originalPath: "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_activity.fit",
        }),
      }),
    ]);
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
  });

  it("records summary validation errors and skips unmatched FIT files when summaries exist", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": JSON.stringify([
        {
          summarizedActivitiesExport: [
            {
              activityId: 12345,
              activityType: "cycling",
            },
          ],
        },
      ]),
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_99999.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual([
      { message: "Garmin activity 12345 is missing a valid start time" },
    ]);
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
    expect(flowMock.add).not.toHaveBeenCalled();
    expect(mockParseFitFile).not.toHaveBeenCalled();
  });

  it("fans out repeated FIT files to one child job per file", async () => {
    flowMock.waitUntilFinished.mockResolvedValue({ recordsSynced: 2, errors: [] });
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
      "DI_CONNECT/DI-Connect-Uploaded-Files/copy/asher@example.com_12345_extra.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(2);
    expect(flowMock.add).toHaveBeenCalledOnce();
    expect(latestFitFlowChildren().map((child) => child.data)).toEqual([
      expect.objectContaining({
        originalPath: "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit",
      }),
      expect.objectContaining({
        originalPath: "DI_CONNECT/DI-Connect-Uploaded-Files/copy/asher@example.com_12345_extra.fit",
      }),
    ]);
    expect(mockParseFitFileInWorkerThread).not.toHaveBeenCalled();
    expect(mockParseFitFile).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
  });

  it("creates one flow containing every child FIT job before waiting for batch completion", async () => {
    const fitEntries = Object.fromEntries(
      Array.from({ length: 17 }, (_, activityIndex) => [
        `DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_${activityIndex + 1}.fit`,
        "fit-bytes",
      ]),
    );
    const zip = await createZip(fitEntries);
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);
    let resolveBatch:
      | ((result: { recordsSynced: number; errors: Array<{ message: string }> }) => void)
      | undefined;
    flowMock.waitUntilFinished.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBatch = resolve;
        }),
    );

    const importPromise = importGarminDumpFile(mockDb, filePath, "user-1");

    await waitUntil(() => expect(flowMock.add).toHaveBeenCalledOnce());
    expect(latestFitFlowChildren()).toHaveLength(17);
    expect(resolveBatch).toBeDefined();
    resolveBatch?.({ recordsSynced: 17, errors: [] });

    const result = await importPromise;

    expect(result.recordsSynced).toBe(17);
    expect(result.errors).toEqual([]);
  });

  it("aggregates child FIT errors from the batch parent result", async () => {
    flowMock.waitUntilFinished.mockResolvedValue({
      recordsSynced: 1,
      errors: [{ message: "Failed to import Garmin FIT file copy: bad first copy" }],
    });
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
      "DI_CONNECT/DI-Connect-Uploaded-Files/copy/asher@example.com_12345_extra.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: "Failed to import Garmin FIT file copy: bad first copy",
      }),
    ]);
    expect(latestFitFlowChildren()).toHaveLength(2);
  });

  it("reports FIT flow failures", async () => {
    flowMock.waitUntilFinished.mockRejectedValue(new Error("bad fit"));
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: "Failed to process Garmin FIT import jobs: bad fit",
      }),
    ]);
  });
});
