import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { Encoder, Profile, Utils } from "@garmin/fitsdk";
import { ZipArchive } from "archiver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../db/index.ts";
import {
  cleanupPreparedGarminDumpImport,
  GARMIN_DUMP_PROVIDER_ID,
  GarminDumpProvider,
  mapGarminDumpActivityType,
  parseGarminDumpFile,
  prepareGarminDumpImport,
} from "./garmin-dump.ts";

const mockCaptureException = vi.fn();
vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock("../logger.ts", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
}));

type FileStats = Exclude<Awaited<ReturnType<typeof stat>>, undefined>;

interface FsPromisesMock {
  statOverride: ((filePath: string) => Promise<FileStats>) | null;
  rmOverride:
    | ((
        filePath: string,
        options: { force?: boolean; recursive?: boolean } | undefined,
      ) => Promise<void> | null)
    | null;
}

const fsPromisesMock = vi.hoisted<FsPromisesMock>(() => ({
  statOverride: null,
  rmOverride: null,
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
    rm: (...args: Parameters<typeof actual.rm>) => {
      if (fsPromisesMock.rmOverride) {
        const overrideResult = fsPromisesMock.rmOverride(String(args[0]), args[1]);
        if (overrideResult) {
          return overrideResult;
        }
      }
      return actual.rm(...args);
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

async function createZip(
  entries: Record<string, Buffer | string>,
  options: { store?: boolean } = {},
): Promise<Buffer> {
  const archive = new ZipArchive(options.store ? { store: true } : { zlib: { level: 1 } });
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
    archive.append(data, {
      name: path,
      ...(options.store === undefined ? {} : { store: options.store }),
    });
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

async function parseGarminDumpInChildProcess(filePath: string): Promise<void> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/providers/garmin-dump.ts")).href;
  const source =
    `import { parseGarminDumpFile } from ${JSON.stringify(moduleUrl)};` +
    "const keepAlive = setInterval(() => undefined, 1_000);" +
    `try { await parseGarminDumpFile(${JSON.stringify(filePath)}); } ` +
    "finally { clearInterval(keepAlive); }";

  await new Promise<void>((resolve, reject) => {
    const childProcess = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let standardError = "";
    let timedOut = false;
    childProcess.stderr.setEncoding("utf8");
    childProcess.stderr.on("data", (chunk: string) => {
      standardError += chunk;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      childProcess.kill("SIGKILL");
    }, 10_000);

    childProcess.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    childProcess.once("exit", (exitCode) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error("Garmin dump parser did not finish streaming the nested ZIP within 10s"));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(standardError.trim() || `Garmin dump parser exited with ${exitCode}`));
        return;
      }
      resolve();
    });
  });
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
    fsPromisesMock.rmOverride = null;
    mockUpsertProviderActivity.mockResolvedValue({ id: "activity-row-1" });
    mockEnsureProvider.mockResolvedValue(undefined);
    mockCaptureException.mockClear();
    mockLoggerInfo.mockClear();
    mockLoggerWarn.mockClear();
  });

  afterEach(async () => {
    fsPromisesMock.statOverride = null;
    fsPromisesMock.rmOverride = null;
    await Promise.all(
      createdDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("is an import-only provider", () => {
    const provider = new GarminDumpProvider();

    expect(provider.id).toBe(GARMIN_DUMP_PROVIDER_ID);
    expect(provider.name).toBe("Garmin Dump");
    expect(provider.importOnly).toBe(true);
    expect(provider.validate()).toBeNull();
  });

  it("maps Garmin activity names to canonical activity types", () => {
    expect(mapGarminDumpActivityType("cycling")).toEqual({
      canonicalType: "cycling",
      providerType: "cycling",
      modality: null,
    });
    expect(mapGarminDumpActivityType("virtual_ride")).toEqual({
      canonicalType: "cycling",
      providerType: "virtual_ride",
      modality: "indoor",
    });
    expect(mapGarminDumpActivityType(undefined, "HIKING")).toEqual({
      canonicalType: "hiking",
      providerType: "HIKING",
      modality: null,
    });
    expect(mapGarminDumpActivityType("Trail  Running")).toEqual({
      canonicalType: "running",
      providerType: "Trail  Running",
      modality: "trail",
    });
    expect(mapGarminDumpActivityType("mountain-biking")).toEqual({
      canonicalType: "cycling",
      providerType: "mountain-biking",
      modality: null,
    });
    expect(mapGarminDumpActivityType(undefined, undefined)).toEqual({
      canonicalType: "other",
      providerType: "other",
      modality: null,
    });
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
      outputDirectory: parsed.tempDirectories[0],
      maxBytes: 128 * 1024 * 1024,
      nestedArchiveMaxBytes: 1024 * 1024 * 1024,
    });
    expect(parsed.weightFitFiles[0]).toEqual({
      path: "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip/asher@example.com_999_weight.fit",
      archivePath: filePath,
      entryPath: [
        "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip",
        "asher@example.com_999_weight.fit",
      ],
      outputDirectory: parsed.tempDirectories[0],
      maxBytes: 128 * 1024 * 1024,
      nestedArchiveMaxBytes: 1024 * 1024 * 1024,
    });
  });

  it("finishes streaming a multi-chunk nested Garmin ZIP", async () => {
    const incompressiblePayload = Buffer.concat(
      Array.from({ length: 8_192 }, (_, chunkIndex) =>
        createHash("sha256").update(String(chunkIndex)).digest(),
      ),
    );
    const nestedZip = await createZip({ "padding.bin": incompressiblePayload }, { store: true });
    const zip = await createZip(
      {
        "DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip": nestedZip,
      },
      { store: false },
    );
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    await expect(parseGarminDumpInChildProcess(filePath)).resolves.toBeUndefined();
  }, 15_000);

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
        outputDirectory: parsed.tempDirectories[0],
        maxBytes: 128 * 1024 * 1024,
        nestedArchiveMaxBytes: 1024 * 1024 * 1024,
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
    if (!actualStats) {
      throw new Error("Expected the written Garmin dump fixture to have file stats");
    }
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

  it("prepares activity summaries and matching FIT jobs", async () => {
    const filePath = await createGarminDumpZip();

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    expect(preparedImport.baseResult).toEqual({ recordsSynced: 1, errors: [] });
    expect(preparedImport.batchId).toMatch(/^garmin-dump-fit-batch-[a-f0-9]{64}$/);
    expect(preparedImport.fitJobEntries).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({
          path: expect.stringContaining("asher@example.com_999_weight.fit"),
        }),
        data: expect.objectContaining({
          userId: "user-1",
          providerId: GARMIN_DUMP_PROVIDER_ID,
          sourceName: "Garmin Dump",
        }),
      }),
      expect.objectContaining({
        entry: expect.objectContaining({
          path: expect.stringContaining("asher@example.com_12345.fit"),
        }),
        data: expect.objectContaining({
          activitySummary: expect.objectContaining({
            externalId: "12345",
            activityType: {
              canonicalType: "cycling",
              providerType: "cycling",
              modality: null,
            },
            name: "Morning Ride",
          }),
        }),
      }),
    ]);
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
        externalId: "12345",
        endedAt: new Date("2026-07-01T12:30:00.000Z"),
        raw: expect.objectContaining({ activityId: 12345 }),
      }),
      expect.objectContaining({
        activityType: {
          canonicalType: "cycling",
          providerType: "cycling",
          modality: null,
        },
        name: "Morning Ride",
      }),
    );
  });

  it("prepares extracted directory FIT files with their direct paths", async () => {
    const directory = await createTempDirectory();
    const nestedDirectory = join(directory, "DI_CONNECT", "DI-Connect-Uploaded-Files");
    await mkdir(nestedDirectory, { recursive: true });
    const extractedFitPath = join(nestedDirectory, "asher@example.com_20260701_weight.fit");
    await writeFile(extractedFitPath, createWeightFit());

    const preparedImport = await prepareGarminDumpImport(mockDb, directory, "user-1");

    expect(preparedImport.fitJobEntries).toEqual([
      expect.objectContaining({
        entry: {
          path: "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_20260701_weight.fit",
          filePath: extractedFitPath,
        },
      }),
    ]);
  });

  it("extends the active import lock during preparation", async () => {
    const filePath = await createGarminDumpZip();
    const extendLock = vi.fn().mockResolvedValue(undefined);

    await prepareGarminDumpImport(mockDb, filePath, "user-1", { extendLock });

    expect(extendLock).toHaveBeenCalledTimes(2);
    expect(extendLock).toHaveBeenNthCalledWith(1, 600_000);
    expect(extendLock).toHaveBeenNthCalledWith(2, 600_000);
  });

  it("reports preparation progress", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_67890.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);
    const onProgress = vi.fn();

    await prepareGarminDumpImport(mockDb, filePath, "user-1", { onProgress });

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { percentage: 0, message: "Starting Garmin dump import..." },
      { percentage: 0, message: "Reading Garmin dump..." },
      { percentage: 0, message: "Found 0 activity summaries and 2 FIT files." },
      { percentage: 0, message: "Importing Garmin FIT files (0/2)..." },
    ]);
  });

  it("continues preparation when progress callbacks fail", async () => {
    const progressError = new Error("redis down");
    const filePath = await createGarminDumpZip();
    const onProgress = vi.fn().mockRejectedValue(progressError);

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1", {
      onProgress,
    });

    expect(preparedImport.baseResult.recordsSynced).toBe(1);
    expect(preparedImport.fitJobEntries).toHaveLength(2);
    expect(mockCaptureException).toHaveBeenCalledWith(progressError, {
      tags: { garminDumpStep: "progress" },
    });
  });

  it("keeps parse errors while preparing FIT-only activities", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": "{broken",
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_activity.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    expect(preparedImport.baseResult.recordsSynced).toBe(0);
    expect(preparedImport.baseResult.errors[0]?.message).toContain(
      "Failed to parse Garmin summarized activities",
    );
    expect(preparedImport.fitJobEntries[0]?.data.originalPath).toBe(
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_activity.fit",
    );
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
  });

  it("imports unmatched FIT files even when summaries exist", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": JSON.stringify([
        { summarizedActivitiesExport: [{ activityId: 12345, activityType: "cycling" }] },
      ]),
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_99999.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    expect(preparedImport.baseResult).toEqual({
      recordsSynced: 0,
      errors: [{ message: "Garmin activity 12345 is missing a valid start time" }],
    });
    expect(preparedImport.fitJobEntries).toHaveLength(1);
    expect(preparedImport.fitJobEntries[0]?.data.originalPath).toBe(
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_99999.fit",
    );
    expect(preparedImport.fitJobEntries[0]?.data.activitySummary).toBeUndefined();
    expect(mockUpsertProviderActivity).not.toHaveBeenCalled();
  });

  it("records invalid matching activity summaries before skipping their FIT files", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Fitness/asher_0_summarizedActivities.json": JSON.stringify([
        { summarizedActivitiesExport: [{ activityId: 12345, activityType: "cycling" }] },
      ]),
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    expect(preparedImport.baseResult.errors).toEqual([
      { message: "Garmin activity 12345 is missing a valid start time" },
      { message: "Garmin activity 12345 is missing a valid start time" },
    ]);
    expect(preparedImport.fitJobEntries).toEqual([]);
  });

  it("matches summarized activities to FIT files with Garmin suffixes", async () => {
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

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    expect(preparedImport.baseResult.recordsSynced).toBe(1);
    expect(preparedImport.fitJobEntries[0]?.data).toEqual(
      expect.objectContaining({
        originalPath: "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345_extra.fit",
        activitySummary: expect.objectContaining({ externalId: "12345", name: "Suffix Ride" }),
      }),
    );
  });

  it("prepares every repeated FIT file without deduplicating", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
      "DI_CONNECT/DI-Connect-Uploaded-Files/copy/asher@example.com_12345_extra.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    expect(preparedImport.fitJobEntries.map(({ data }) => data.originalPath)).toEqual([
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit",
      "DI_CONNECT/DI-Connect-Uploaded-Files/copy/asher@example.com_12345_extra.fit",
    ]);
  });

  it("prepares every FIT file in one import plan", async () => {
    const fitEntries = Object.fromEntries(
      Array.from({ length: 17 }, (_, activityIndex) => [
        `DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_${activityIndex + 1}.fit`,
        "fit-bytes",
      ]),
    );
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, await createZip(fitEntries));

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    expect(preparedImport.fitJobEntries).toHaveLength(17);
    expect(preparedImport.totalFitFiles).toBe(17);
  });

  it("cleans up prepared ZIP extraction directories", async () => {
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(
      filePath,
      await createZip({
        "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
      }),
    );
    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");
    const extractionDirectory = preparedImport.tempDirectories[0];
    if (!extractionDirectory) {
      throw new Error("Expected ZIP preparation to create an extraction directory");
    }

    await expect(stat(extractionDirectory)).resolves.toBeDefined();

    await cleanupPreparedGarminDumpImport(preparedImport.tempDirectories);

    const remainingEntries = await readdir(directory);
    expect(
      remainingEntries.filter((entryName) => entryName.startsWith("garmin-export.zip-extract-")),
    ).toEqual([]);
  });

  it("cleans up extraction directories when preparation fails after parsing", async () => {
    const filePath = await createGarminDumpZip();
    const parentDirectory = join(filePath, "..");
    mockEnsureProvider.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(prepareGarminDumpImport(mockDb, filePath, "user-1")).rejects.toThrow(
      "database unavailable",
    );

    const remainingEntries = await readdir(parentDirectory);
    expect(
      remainingEntries.filter((entryName) => entryName.startsWith("garmin-export.zip-extract-")),
    ).toEqual([]);
  });

  it("makes prepared-directory cleanup idempotent", async () => {
    const directory = await createTempDirectory();
    const extractionDirectory = join(directory, "extracted");
    await mkdir(extractionDirectory);

    await cleanupPreparedGarminDumpImport([extractionDirectory]);
    await expect(cleanupPreparedGarminDumpImport([extractionDirectory])).resolves.toBeUndefined();
  });

  it("does not clean upload-like siblings when importing an extracted directory", async () => {
    const directory = await createTempDirectory();
    await writeFile(join(directory, "activity.fit"), "fit-bytes");
    const siblingDirectory = `${directory}-extract-stale`;
    createdDirectories.push(siblingDirectory);
    await mkdir(siblingDirectory);

    await prepareGarminDumpImport(mockDb, directory, "user-1");

    await expect(stat(siblingDirectory)).resolves.toBeDefined();
  });

  it("does not remove ordinary files that share the extraction prefix", async () => {
    const filePath = await createGarminDumpZip();
    const ordinaryFile = `${filePath}-extract-note`;
    await writeFile(ordinaryFile, "keep me");

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    await expect(stat(ordinaryFile)).resolves.toBeDefined();
    await cleanupPreparedGarminDumpImport(preparedImport.tempDirectories);
  });

  it("removes extraction directories absent from the checkpoint before retrying preparation", async () => {
    const filePath = await createGarminDumpZip();
    const staleDirectory = `${filePath}-extract-stale`;
    await mkdir(staleDirectory);
    await writeFile(join(staleDirectory, "partial.fit"), "partial");

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    await expect(stat(staleDirectory)).rejects.toThrow();
    await cleanupPreparedGarminDumpImport(preparedImport.tempDirectories);
  });

  it("force-removes an extraction directory absent from the checkpoint", async () => {
    const filePath = await createGarminDumpZip();
    const staleDirectory = `${filePath}-extract-stale`;
    await mkdir(staleDirectory);
    const removeOverride = vi.fn(
      (directoryPath: string, options: { force?: boolean; recursive?: boolean } | undefined) => {
        if (directoryPath !== staleDirectory) {
          return null;
        }
        expect(options).toEqual(expect.objectContaining({ recursive: true, force: true }));
        return Promise.resolve();
      },
    );
    fsPromisesMock.rmOverride = removeOverride;

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1");

    expect(removeOverride).toHaveBeenCalledWith(
      staleDirectory,
      expect.objectContaining({ recursive: true, force: true }),
    );
    fsPromisesMock.rmOverride = null;
    await cleanupPreparedGarminDumpImport([staleDirectory, ...preparedImport.tempDirectories]);
  });

  it("preserves extraction directories recorded in the checkpoint while rebuilding", async () => {
    const filePath = await createGarminDumpZip();
    const preservedDirectory = `${filePath}-extract-preserved`;
    await mkdir(preservedDirectory);

    const preparedImport = await prepareGarminDumpImport(mockDb, filePath, "user-1", {
      preserveTempDirectories: [preservedDirectory],
    });

    await expect(stat(preservedDirectory)).resolves.toBeDefined();
    await cleanupPreparedGarminDumpImport([preservedDirectory, ...preparedImport.tempDirectories]);
  });
});
