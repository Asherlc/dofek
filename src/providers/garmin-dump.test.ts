import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockLoggerWarn = vi.fn();
vi.mock("../logger.ts", () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args) },
}));

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
    mockCaptureException.mockClear();
    mockLoggerWarn.mockClear();
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

  function expectedFlowHash(input: string): string {
    return createHash("sha256").update(input).digest("hex");
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
    expect(parsed.fitFiles[0]).toEqual({
      path: "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_12345.fit",
      archivePath: filePath,
      entryPath: [
        "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip",
        "asher@example.com_12345.fit",
      ],
    });
    expect(parsed.weightFitFiles[0]).toEqual({
      path: "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_999_weight.fit",
      archivePath: filePath,
      entryPath: [
        "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip",
        "asher@example.com_999_weight.fit",
      ],
    });
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

  it("parses nested uploaded ZIP files inside extracted Garmin dump directories", async () => {
    const directory = await createTempDirectory();
    const nestedDirectory = join(directory, "DI_CONNECT", "DI-Connect-Uploaded-Files");
    await mkdir(nestedDirectory, { recursive: true });
    const nestedZipPath = join(nestedDirectory, "UploadedFiles_0-_Part1.zip");
    await writeFile(
      nestedZipPath,
      await createZip({
        "asher@example.com_12345.fit": "fit-bytes",
        "ignored.txt": "ignored",
      }),
    );

    const parsed = await parseGarminDumpFile(directory);

    expect(parsed.errors).toEqual([]);
    expect(parsed.fitFiles).toEqual([
      {
        path: "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_12345.fit",
        archivePath: nestedZipPath,
        entryPath: ["asher@example.com_12345.fit"],
      },
    ]);
    expect(parsed.weightFitFiles).toEqual([]);
    expect(parsed.tempDirectories).toHaveLength(1);
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

  it("removes temporary extraction directories when ZIP parsing fails", async () => {
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, "not a zip");

    await expect(parseGarminDumpFile(filePath)).rejects.toThrow();

    const remainingEntries = await readdir(directory);
    expect(
      remainingEntries.filter((entryName) => entryName.startsWith("garmin-export.zip-extract-")),
    ).toEqual([]);
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
        data: { type: "fit-file-import-batch" },
        opts: {
          jobId: `garmin-dump-fit-batch:garmin-export.zip:${expectedFlowHash(
            [
              "user-1",
              filePath,
              [
                "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_999_weight.fit",
                "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_12345.fit",
              ].join("\n"),
            ].join("\n"),
          )}`,
          removeOnComplete: { age: 86_400, count: 1_000 },
          removeOnFail: { age: 604_800, count: 1_000 },
        },
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
          jobId: `garmin-dump-fit:${expectedFlowHash(
            [
              "user-1",
              filePath,
              "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_999_weight.fit",
            ].join("\n"),
          )}`,
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
              outputExtension: "fit",
              maxBytes: 128 * 1024 * 1024,
              nestedArchiveMaxBytes: 1024 * 1024 * 1024,
            }),
            opts: {
              ignoreDependencyOnFailure: true,
              removeOnComplete: { age: 86_400, count: 1_000 },
              removeOnFail: { age: 604_800, count: 1_000 },
            },
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
        opts: expect.objectContaining({
          jobId: `garmin-dump-fit:${expectedFlowHash(
            [
              "user-1",
              filePath,
              "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_12345.fit",
            ].join("\n"),
          )}`,
          removeOnComplete: { age: 86_400, count: 1_000 },
          removeOnFail: { age: 604_800, count: 1_000 },
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

  it("uses distinct flow job IDs for uploads with the same archive basename", async () => {
    const firstDirectory = await createTempDirectory();
    const secondDirectory = await createTempDirectory();
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
    });
    const firstFilePath = join(firstDirectory, "garmin-export.zip");
    const secondFilePath = join(secondDirectory, "garmin-export.zip");
    await writeFile(firstFilePath, zip);
    await writeFile(secondFilePath, zip);

    await importGarminDumpFile(mockDb, firstFilePath, "user-1");
    const firstFlow = latestFlow();
    await importGarminDumpFile(mockDb, secondFilePath, "user-1");
    const secondFlow = latestFlow();

    expect(firstFlow.opts).not.toEqual(secondFlow.opts);
    expect(firstFlow.children?.[0]?.opts).not.toEqual(secondFlow.children?.[0]?.opts);
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

  it("reports progress while importing Garmin dump FIT flow jobs", async () => {
    flowMock.waitUntilFinished.mockResolvedValue({ recordsSynced: 2, errors: [] });
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_67890.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);
    const onProgress = vi.fn();

    await importGarminDumpFile(mockDb, filePath, "user-1", { onProgress });

    expect(onProgress).toHaveBeenCalledWith({
      percentage: 0,
      message: "Starting Garmin dump import...",
    });
    expect(onProgress).toHaveBeenCalledWith({
      percentage: 5,
      message: "Reading Garmin dump...",
    });
    expect(onProgress).toHaveBeenCalledWith({
      percentage: 25,
      message: "Found 0 activity summaries and 2 FIT files.",
    });
    expect(onProgress).toHaveBeenCalledWith({
      percentage: 45,
      message: "Importing Garmin FIT files (0/2)...",
    });
    expect(onProgress).toHaveBeenCalledWith({
      percentage: 95,
      message: "Garmin dump import complete.",
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("continues Garmin dump import when progress callbacks fail", async () => {
    flowMock.waitUntilFinished.mockResolvedValue({ recordsSynced: 2, errors: [] });
    const progressError = new Error("redis down");
    const filePath = await createGarminDumpZip();
    const onProgress = vi.fn().mockRejectedValue(progressError);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1", { onProgress });

    expect(result.recordsSynced).toBe(3);
    expect(flowMock.add).toHaveBeenCalledOnce();
    expect(mockCaptureException).toHaveBeenCalledWith(progressError, {
      tags: { garminDumpStep: "progress" },
    });
  });

  it("reports a lock renewal failure that happens while waiting for the FIT flow", async () => {
    const filePath = await createGarminDumpZip();
    let rejectRenewal: (error: Error) => void = () => undefined;
    const deferredRenewal = new Promise<void>((_, reject) => {
      rejectRenewal = reject;
    });
    const extendLock = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(deferredRenewal);
    let renewalCallback: (() => void) | undefined;
    const intervalHandle = setInterval(() => undefined, 60_000);
    intervalHandle.unref?.();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
      if (typeof callback !== "function") {
        throw new Error("Expected lock renewal interval callback to be a function");
      }
      renewalCallback = () => callback();
      return intervalHandle;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    flowMock.waitUntilFinished.mockImplementation(async () => {
      renewalCallback?.();
      setTimeout(() => rejectRenewal(new Error("lost lock")), 0);
      return { recordsSynced: 1, errors: [] };
    });

    try {
      const result = await importGarminDumpFile(mockDb, filePath, "user-1", { extendLock });

      expect(result.recordsSynced).toBe(1);
      expect(result.errors).toEqual([
        expect.objectContaining({
          message: "Failed to process Garmin FIT import jobs: lost lock",
        }),
      ]);
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      clearInterval(intervalHandle);
    }
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

  it("records invalid activity summaries again when matching FIT files cannot receive metadata", async () => {
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
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual([
      { message: "Garmin activity 12345 is missing a valid start time" },
      { message: "Garmin activity 12345 is missing a valid start time" },
    ]);
    expect(flowMock.add).not.toHaveBeenCalled();
  });

  it("matches summarized activities to FIT files with Garmin suffixes after the activity ID", async () => {
    flowMock.waitUntilFinished.mockResolvedValue({ recordsSynced: 1, errors: [] });
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": JSON.stringify([
        {
          summarizedActivitiesExport: [
            {
              activityId: 12345,
              name: "Suffix Ride",
              activityType: "cycling",
              startTimeGmt: Date.parse("2026-07-01T12:00:00.000Z"),
              duration: 1800000,
            },
          ],
        },
      ]),
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345_extra.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(2);
    expect(latestFitFlowChildren()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          originalPath: "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345_extra.fit",
          activitySummary: expect.objectContaining({
            externalId: "12345",
            name: "Suffix Ride",
          }),
        }),
      }),
    ]);
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
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { garminDumpStep: "fit-flow" },
    });
    expect(mockCaptureException.mock.calls[0]?.[0]).toEqual(new Error("bad fit"));
  });

  it("removes temporary extraction directories after importing a ZIP dump", async () => {
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(
      filePath,
      await createZip({
        "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
      }),
    );

    await importGarminDumpFile(mockDb, filePath, "user-1");

    const remainingEntries = await readdir(directory);
    expect(
      remainingEntries.filter((entryName) => entryName.startsWith("garmin-export.zip-extract-")),
    ).toEqual([]);
  });
});
