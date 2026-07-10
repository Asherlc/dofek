import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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

const mockReplaceMetricStreamBatch = vi.fn().mockResolvedValue(undefined);
vi.mock("../db/metric-stream-writer.ts", () => ({
  replaceMetricStreamBatch: (...args: unknown[]) => mockReplaceMetricStreamBatch(...args),
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
    "asher@example.com_999_weight.fit": Buffer.from("weight-fit"),
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

describe("Garmin dump provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsPromisesMock.statOverride = null;
    mockUpsertProviderActivity.mockResolvedValue({ id: "activity-row-1" });
    mockReplaceMetricStreamBatch.mockResolvedValue(undefined);
    mockEnsureProvider.mockResolvedValue(undefined);
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

  it("imports summaries and replaces metric stream samples from matching FIT files", async () => {
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
    expect(mockParseFitFileInWorkerThread).toHaveBeenCalledWith(Buffer.from("fit-bytes"));
    expect(mockParseFitFile).not.toHaveBeenCalled();
    expect(mockReplaceMetricStreamBatch).toHaveBeenCalledWith(
      mockDb,
      { activityId: "activity-row-1" },
      [
        expect.objectContaining({
          providerId: GARMIN_DUMP_PROVIDER_ID,
          activityId: "activity-row-1",
          userId: "user-1",
          heartRate: 130,
          power: 180,
        }),
      ],
      "file",
    );
    expect(mockUpsertProviderActivity.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        endedAt: new Date("2026-07-01T12:30:00.000Z"),
        raw: expect.objectContaining({ activityId: 12345 }),
      }),
    );
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("keeps parse errors in import results and imports FIT-only activities", async () => {
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
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        externalId: expect.stringMatching(/^fit:[a-f0-9]{32}$/),
        activityType: "cycling",
        name: "Garmin cycling",
        raw: {
          fitPath: "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_activity.fit",
          session: { sport: "cycling" },
        },
      }),
      expect.objectContaining({
        name: "Garmin cycling",
        raw: {
          fitPath: "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_activity.fit",
          session: { sport: "cycling" },
        },
      }),
    );
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
    expect(mockParseFitFile).not.toHaveBeenCalled();
  });

  it("deduplicates repeated FIT files by extracted Garmin activity id", async () => {
    const zip = await createZip({
      "DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit": "fit-bytes",
      "DI_CONNECT/DI-Connect-Uploaded-Files/copy/asher@example.com_12345_extra.fit": "fit-bytes",
    });
    const directory = await createTempDirectory();
    const filePath = join(directory, "garmin-export.zip");
    await writeFile(filePath, zip);

    const result = await importGarminDumpFile(mockDb, filePath, "user-1");

    expect(result.recordsSynced).toBe(1);
    expect(mockParseFitFileInWorkerThread).toHaveBeenCalledTimes(1);
    expect(mockParseFitFile).not.toHaveBeenCalled();
    expect(mockUpsertProviderActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({ externalId: "12345" }),
      expect.any(Object),
    );
  });

  it("reports FIT parse failures with the extracted external id", async () => {
    mockParseFitFileInWorkerThread.mockRejectedValue(new Error("bad fit"));
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
        externalId: "12345",
        message:
          "Failed to import Garmin FIT file DI_CONNECT/DI-Connect-Uploaded-Files/asher@example.com_12345.fit: bad fit",
      }),
    ]);
  });
});
