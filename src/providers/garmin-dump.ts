import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { Readable } from "node:stream";
import type { CanonicalActivityType } from "@dofek/training/training";
import yauzl from "yauzl";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { upsertProviderActivity } from "../db/provider-activity-sync.ts";
import { ensureProvider } from "../db/tokens.ts";
import { fitExternalId } from "../fit/external-id.ts";
import type { ParsedFitSession } from "../fit/parser.ts";
import type { FitFileImportJobResult } from "../jobs/process-fit-file-import-job.ts";
import {
  type FitFileImportJobData,
  getFitFileImportQueue,
  getFitFileImportQueueEvents,
} from "../jobs/queues.ts";
import type { ImportProvider, SyncError, SyncResult } from "./types.ts";

export const GARMIN_DUMP_PROVIDER_ID = "garmin-dump";
const GARMIN_DUMP_PROVIDER_NAME = "Garmin Dump";
const MAX_GARMIN_DUMP_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_GARMIN_DUMP_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_GARMIN_DUMP_NESTED_ZIP_BYTES = 1024 * 1024 * 1024;
const MAX_GARMIN_DUMP_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024;
const GARMIN_DUMP_IMPORT_LOCK_EXTENSION_MS = 10 * 60 * 1000;
const FIT_FILE_IMPORT_BATCH_SIZE = 16;

const summarizedActivitySchema = z
  .object({
    activityId: z.union([z.number(), z.string()]),
    name: z.string().optional(),
    activityType: z.string().optional(),
    sportType: z.string().optional(),
    startTimeGmt: z.number().optional(),
    beginTimestamp: z.number().optional(),
    duration: z.number().optional(),
    elapsedDuration: z.number().optional(),
    locationName: z.string().optional(),
    manufacturer: z.string().optional(),
  })
  .passthrough();

const summarizedActivitiesFileSchema = z.array(
  z.object({
    summarizedActivitiesExport: z.array(summarizedActivitySchema).optional(),
  }),
);

type GarminSummarizedActivity = z.infer<typeof summarizedActivitySchema>;
const summarizedActivitiesSuffix = `_${"summarized"}${"activities"}.json`;

interface GarminDumpEntry {
  path: string;
  data: Buffer;
}

interface ParsedGarminDump {
  summaries: GarminSummarizedActivity[];
  fitFiles: GarminDumpEntry[];
  weightFitFiles: GarminDumpEntry[];
  errors: SyncError[];
}

interface GarminDumpExtractionState {
  extractedBytes: number;
}

interface GarminDumpImportOptions {
  extendLock?: (durationMs: number) => Promise<void>;
  onProgress?: (progress: GarminDumpProgress) => void | Promise<void>;
}

interface GarminDumpProgress {
  percentage: number;
  message: string;
}

const fitFileImportJobResultSchema = z.object({
  recordsSynced: z.number(),
  errors: z.array(z.object({ message: z.string() })),
});

const GARMIN_ACTIVITY_TYPE_MAP: Readonly<Record<string, CanonicalActivityType>> = {
  cycling: "cycling",
  road_biking: "cycling",
  mountain_biking: "cycling",
  virtual_ride: "indoor_cycling",
  indoor_cycling: "indoor_cycling",
  running: "running",
  trail_running: "trail_running",
  treadmill_running: "running",
  walking: "walking",
  hiking: "hiking",
  swimming: "swimming",
  lap_swimming: "swimming",
  strength_training: "strength",
  cardio: "cardio",
  rowing: "rowing",
  yoga: "yoga",
  skiing: "skiing",
};

function normalizeGarminType(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_") ?? ""
  );
}

export function mapGarminDumpActivityType(
  activityType: string | undefined,
  sportType?: string,
): CanonicalActivityType {
  const normalizedActivityType = normalizeGarminType(activityType);
  const normalizedSportType = normalizeGarminType(sportType);
  return (
    GARMIN_ACTIVITY_TYPE_MAP[normalizedActivityType] ??
    GARMIN_ACTIVITY_TYPE_MAP[normalizedSportType] ??
    "other"
  );
}

export function mapFitSportToGarminDumpActivityType(
  session: ParsedFitSession,
): CanonicalActivityType {
  if (session.subSport === "indoor_cycling") return "indoor_cycling";
  return mapGarminDumpActivityType(session.sport, session.subSport);
}

function timestampFromSummary(summary: GarminSummarizedActivity): Date | null {
  const timestamp = summary.startTimeGmt ?? summary.beginTimestamp;
  if (timestamp === undefined) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

function durationMilliseconds(summary: GarminSummarizedActivity): number {
  return summary.elapsedDuration ?? summary.duration ?? 0;
}

function isGarminWeightFitPath(path: string): boolean {
  return /_weights?\.fit$/i.test(path);
}

function assertGarminDumpSize(byteCount: number, maxBytes: number, description: string): void {
  if (byteCount > maxBytes) {
    throw new Error(`${description} exceeds maximum size of ${maxBytes} bytes`);
  }
}

async function extendGarminDumpImportLock(options: GarminDumpImportOptions): Promise<void> {
  await options.extendLock?.(GARMIN_DUMP_IMPORT_LOCK_EXTENSION_MS);
}

async function reportGarminDumpProgress(
  options: GarminDumpImportOptions,
  percentage: number,
  message: string,
): Promise<void> {
  await options.onProgress?.({ percentage, message });
}

function countExtractedBytes(
  state: GarminDumpExtractionState,
  byteCount: number,
  description: string,
): void {
  state.extractedBytes += byteCount;
  assertGarminDumpSize(
    state.extractedBytes,
    MAX_GARMIN_DUMP_EXTRACTED_BYTES,
    `Garmin dump extracted data after ${description}`,
  );
}

async function streamToBuffer(
  stream: Readable,
  maxBytes: number,
  description: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    if (bytesRead > maxBytes) {
      stream.destroy(new Error(`${description} exceeds maximum size of ${maxBytes} bytes`));
      throw new Error(`${description} exceeds maximum size of ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function openZipFromBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      if (!zipFile) {
        reject(new Error("Garmin dump zip could not be opened"));
        return;
      }
      resolve(zipFile);
    });
  });
}

function openReadStream(zipFile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      if (!stream) {
        reject(new Error(`Garmin dump zip entry could not be read: ${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

function readNextZipEntry(zipFile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      zipFile.off("entry", onEntry);
      zipFile.off("end", onEnd);
      zipFile.off("error", onError);
    };

    zipFile.once("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

async function collectZipEntries(
  buffer: Buffer,
  prefix = "",
  state: GarminDumpExtractionState = { extractedBytes: 0 },
): Promise<GarminDumpEntry[]> {
  const zipFile = await openZipFromBuffer(buffer);
  const entries: GarminDumpEntry[] = [];

  try {
    while (true) {
      const entry = await readNextZipEntry(zipFile);
      if (!entry) return entries;
      if (/\/$/.test(entry.fileName)) continue;

      const path = `${prefix}${entry.fileName}`;
      const lowerPath = path.toLowerCase();
      const maxEntryBytes = lowerPath.endsWith(".zip")
        ? MAX_GARMIN_DUMP_NESTED_ZIP_BYTES
        : MAX_GARMIN_DUMP_ENTRY_BYTES;
      assertGarminDumpSize(entry.uncompressedSize, maxEntryBytes, `Garmin dump entry ${path}`);
      const stream = await openReadStream(zipFile, entry);
      const data = await streamToBuffer(stream, maxEntryBytes, `Garmin dump entry ${path}`);
      countExtractedBytes(state, data.length, path);
      if (lowerPath.endsWith(".zip")) {
        entries.push(...(await collectZipEntries(data, `${path}/`, state)));
      } else {
        entries.push({ path, data });
      }
    }
  } finally {
    zipFile.close();
  }
}

async function collectDirectoryEntries(rootPath: string): Promise<GarminDumpEntry[]> {
  const entries: GarminDumpEntry[] = [];
  const state: GarminDumpExtractionState = { extractedBytes: 0 };

  async function visit(directoryPath: string): Promise<void> {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    for (const directoryEntry of directoryEntries) {
      const childPath = join(directoryPath, directoryEntry.name);
      if (directoryEntry.isDirectory()) {
        await visit(childPath);
        continue;
      }
      if (!directoryEntry.isFile()) continue;

      const relativePath = relative(rootPath, childPath);
      const childStats = await stat(childPath);
      const lowerPath = relativePath.toLowerCase();
      const maxEntryBytes = lowerPath.endsWith(".zip")
        ? MAX_GARMIN_DUMP_NESTED_ZIP_BYTES
        : MAX_GARMIN_DUMP_ENTRY_BYTES;
      assertGarminDumpSize(childStats.size, maxEntryBytes, `Garmin dump file ${relativePath}`);
      const data = await readFile(childPath);
      countExtractedBytes(state, data.length, relativePath);
      if (relativePath.toLowerCase().endsWith(".zip")) {
        entries.push(...(await collectZipEntries(data, `${relativePath}/`, state)));
      } else {
        entries.push({ path: relativePath, data });
      }
    }
  }

  await visit(rootPath);
  return entries;
}

export async function parseGarminDumpFile(filePath: string): Promise<ParsedGarminDump> {
  const fileStats = await stat(filePath);
  if (fileStats.isFile()) {
    if (!filePath.toLowerCase().endsWith(".zip")) {
      throw new Error("Garmin dump import expects a .zip file or extracted export directory");
    }
    assertGarminDumpSize(fileStats.size, MAX_GARMIN_DUMP_INPUT_BYTES, "Garmin dump upload");
  }
  const entries = fileStats.isDirectory()
    ? await collectDirectoryEntries(filePath)
    : await collectZipEntries(await readFile(filePath));
  const errors: SyncError[] = [];
  const summaries: GarminSummarizedActivity[] = [];
  const fitFiles: GarminDumpEntry[] = [];
  const weightFitFiles: GarminDumpEntry[] = [];

  for (const entry of entries) {
    const lowerPath = entry.path.toLowerCase();
    if (lowerPath.endsWith(".fit")) {
      // Garmin account exports store scale/body composition readings in FIT weight files.
      if (isGarminWeightFitPath(entry.path)) {
        weightFitFiles.push(entry);
      } else {
        fitFiles.push(entry);
      }
      continue;
    }

    if (!lowerPath.endsWith(summarizedActivitiesSuffix)) continue;

    try {
      const parsedJson: unknown = JSON.parse(entry.data.toString("utf8"));
      const parsedFile = summarizedActivitiesFileSchema.parse(parsedJson);
      for (const group of parsedFile) {
        summaries.push(...(group.summarizedActivitiesExport ?? []));
      }
    } catch (error) {
      errors.push({
        message: `Failed to parse Garmin summarized activities ${entry.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        cause: error,
      });
    }
  }

  return { summaries, fitFiles, weightFitFiles, errors };
}

function garminSummaryToFitJobSummary(
  summary: GarminSummarizedActivity,
): FitFileImportJobData["activitySummary"] | null {
  const externalId = String(summary.activityId);
  const startedAt = timestampFromSummary(summary);
  if (!startedAt) return null;
  const activityType = mapGarminDumpActivityType(summary.activityType, summary.sportType);
  const endedAt = new Date(startedAt.getTime() + durationMilliseconds(summary));
  return {
    externalId,
    activityType,
    startedAtIso: startedAt.toISOString(),
    endedAtIso: endedAt.toISOString(),
    name: summary.name ?? `Garmin ${activityType.replace(/_/g, " ")}`,
    raw: summary,
  };
}

async function enqueueFitFileImportJobs(
  entries: Array<{ entry: GarminDumpEntry; data: Omit<FitFileImportJobData, "filePath"> }>,
  uploadPath: string,
  onJobFinished: (completedCount: number, totalCount: number) => void | Promise<void>,
): Promise<FitFileImportJobResult[]> {
  if (entries.length === 0) return [];

  const tempDirectory = await mkdtemp(join(dirname(uploadPath), `${basename(uploadPath)}-fit-`));
  const queue = getFitFileImportQueue();
  const queueEvents = getFitFileImportQueueEvents();

  try {
    const jobs: Array<{
      entry: GarminDumpEntry;
      job: Awaited<ReturnType<typeof queue.add>>;
    }> = [];
    for (
      let startIndex = 0;
      startIndex < entries.length;
      startIndex += FIT_FILE_IMPORT_BATCH_SIZE
    ) {
      const batch = entries.slice(startIndex, startIndex + FIT_FILE_IMPORT_BATCH_SIZE);
      jobs.push(
        ...(await Promise.all(
          batch.map(async ({ entry, data }, entryIndex) => {
            const absoluteEntryIndex = startIndex + entryIndex;
            const filePath = join(
              tempDirectory,
              `${absoluteEntryIndex}-${createHash("sha256").update(entry.path).digest("hex")}.fit`,
            );
            await writeFile(filePath, entry.data);
            const job = await queue.add(
              "fit-file-import",
              { ...data, filePath },
              {
                removeOnComplete: { age: 86_400, count: 1_000 },
                removeOnFail: { age: 604_800, count: 1_000 },
              },
            );
            return { entry, job };
          }),
        )),
      );
    }

    const results: FitFileImportJobResult[] = [];
    let completedCount = 0;
    for (let startIndex = 0; startIndex < jobs.length; startIndex += FIT_FILE_IMPORT_BATCH_SIZE) {
      const batch = jobs.slice(startIndex, startIndex + FIT_FILE_IMPORT_BATCH_SIZE);
      results.push(
        ...(await Promise.all(
          batch.map(async ({ entry, job }) => {
            try {
              const result = fitFileImportJobResultSchema.parse(
                await job.waitUntilFinished(queueEvents),
              );
              completedCount++;
              await onJobFinished(completedCount, jobs.length);
              return result;
            } catch (error) {
              completedCount++;
              await onJobFinished(completedCount, jobs.length);
              return {
                recordsSynced: 0,
                errors: [
                  {
                    message: `Failed to import Garmin FIT file ${entry.path}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  },
                ],
              };
            }
          }),
        )),
      );
    }
    return results;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function importGarminDumpFile(
  db: SyncDatabase,
  filePath: string,
  userId: string,
  options: GarminDumpImportOptions = {},
): Promise<SyncResult> {
  const start = Date.now();
  await reportGarminDumpProgress(options, 0, "Starting Garmin dump import...");
  await extendGarminDumpImportLock(options);
  await reportGarminDumpProgress(options, 5, "Reading Garmin dump...");
  const parsedDump = await parseGarminDumpFile(filePath);
  const totalFitFileCount = parsedDump.fitFiles.length + parsedDump.weightFitFiles.length;
  await reportGarminDumpProgress(
    options,
    25,
    `Found ${parsedDump.summaries.length} activity summaries and ${totalFitFileCount} FIT files.`,
  );
  const errors: SyncError[] = [...parsedDump.errors];
  let recordsSynced = 0;
  const summaryByExternalId = new Map<string, GarminSummarizedActivity>();

  await ensureProvider(db, GARMIN_DUMP_PROVIDER_ID, GARMIN_DUMP_PROVIDER_NAME, undefined, userId);

  for (const summary of parsedDump.summaries) {
    const externalId = String(summary.activityId);
    summaryByExternalId.set(externalId, summary);
    const startedAt = timestampFromSummary(summary);
    if (!startedAt) {
      errors.push({ message: `Garmin activity ${externalId} is missing a valid start time` });
      continue;
    }

    const activityType = mapGarminDumpActivityType(summary.activityType, summary.sportType);
    const name = summary.name ?? `Garmin ${activityType.replace(/_/g, " ")}`;
    const endedAt = new Date(startedAt.getTime() + durationMilliseconds(summary));
    await upsertProviderActivity(
      db,
      {
        providerId: GARMIN_DUMP_PROVIDER_ID,
        userId,
        externalId,
        activityType,
        startedAt,
        endedAt,
        name,
        sourceName: GARMIN_DUMP_PROVIDER_NAME,
        raw: summary,
      },
      {
        activityType,
        startedAt,
        endedAt,
        name,
        sourceName: GARMIN_DUMP_PROVIDER_NAME,
        raw: summary,
      },
    );
    recordsSynced++;
  }

  const fitJobEntries: Array<{
    entry: GarminDumpEntry;
    data: Omit<FitFileImportJobData, "filePath">;
  }> = parsedDump.weightFitFiles.map((entry) => ({
    entry,
    data: {
      originalPath: entry.path,
      userId,
      providerId: GARMIN_DUMP_PROVIDER_ID,
      sourceName: GARMIN_DUMP_PROVIDER_NAME,
    },
  }));

  for (const fitFile of parsedDump.fitFiles) {
    const externalId = fitExternalId(fitFile.path, fitFile.data);
    if (summaryByExternalId.size > 0 && !summaryByExternalId.has(externalId)) {
      continue;
    }
    const summary = summaryByExternalId.get(externalId);
    const activitySummary = summary ? garminSummaryToFitJobSummary(summary) : undefined;
    if (summary && !activitySummary) {
      errors.push({ message: `Garmin activity ${externalId} is missing a valid start time` });
      continue;
    }
    const jobData: Omit<FitFileImportJobData, "filePath"> = {
      originalPath: fitFile.path,
      userId,
      providerId: GARMIN_DUMP_PROVIDER_ID,
      sourceName: GARMIN_DUMP_PROVIDER_NAME,
    };
    if (activitySummary) {
      jobData.activitySummary = activitySummary;
    }
    fitJobEntries.push({
      entry: fitFile,
      data: jobData,
    });
  }

  try {
    await extendGarminDumpImportLock(options);
    await reportGarminDumpProgress(
      options,
      45,
      `Importing Garmin FIT files (0/${fitJobEntries.length})...`,
    );
    const fitResults = await enqueueFitFileImportJobs(
      fitJobEntries,
      filePath,
      async (completedCount, totalCount) => {
        await reportGarminDumpProgress(
          options,
          Math.floor(45 + (completedCount / totalCount) * 50),
          `Importing Garmin FIT files (${completedCount}/${totalCount})...`,
        );
      },
    );
    for (const result of fitResults) {
      recordsSynced += result.recordsSynced;
      for (const error of result.errors) {
        errors.push(error);
      }
    }
  } catch (error) {
    errors.push({
      message: `Failed to process Garmin FIT import jobs: ${
        error instanceof Error ? error.message : String(error)
      }`,
      cause: error,
    });
  }

  await reportGarminDumpProgress(options, 95, "Garmin dump import complete.");

  return {
    provider: GARMIN_DUMP_PROVIDER_ID,
    recordsSynced,
    errors,
    duration: Date.now() - start,
  };
}

export async function importGarminDumpZip(
  db: SyncDatabase,
  zipPath: string,
  userId: string,
): Promise<SyncResult> {
  return importGarminDumpFile(db, zipPath, userId);
}

export class GarminDumpProvider implements ImportProvider {
  readonly id = GARMIN_DUMP_PROVIDER_ID;
  readonly name = GARMIN_DUMP_PROVIDER_NAME;
  readonly importOnly = true as const;

  validate(): string | null {
    return null;
  }
}
