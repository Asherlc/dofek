import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type LegacyActivityType,
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";
import yauzl from "yauzl";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { upsertProviderActivity } from "../db/provider-activity-sync.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { ParsedFitSession } from "../fit/parser.ts";
import type { FitFileImportJobData } from "../jobs/queues.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import type { ImportProvider, SyncError } from "./types.ts";

export const GARMIN_DUMP_PROVIDER_ID = "garmin-dump";
const GARMIN_DUMP_PROVIDER_NAME = "Garmin Dump";
const MAX_GARMIN_DUMP_INPUT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_GARMIN_DUMP_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_GARMIN_DUMP_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_GARMIN_DUMP_NESTED_ZIP_BYTES = 1024 * 1024 * 1024;
const GARMIN_DUMP_IMPORT_LOCK_EXTENSION_MS = 10 * 60 * 1000;

type GarminDumpEntry =
  | {
      path: string;
      filePath: string;
      archivePath?: string;
      entryPath?: string[];
      outputDirectory?: string;
    }
  | {
      path: string;
      filePath?: never;
      archivePath: string;
      entryPath: string[];
      outputDirectory: string;
      maxBytes: number;
      nestedArchiveMaxBytes: number;
    };

export interface GarminFitJobEntry {
  entry: GarminDumpEntry;
  data: Omit<FitFileImportJobData, "filePath">;
}

export interface PreparedGarminDumpImport {
  uploadPath: string;
  userId: string;
  batchId: string;
  baseResult: {
    recordsSynced: number;
    errors: Array<{ message: string }>;
  };
  fitJobEntries: GarminFitJobEntry[];
  tempDirectories: string[];
  totalFitFiles: number;
}

export function createGarminFitBatchId(
  uploadPath: string,
  userId: string,
  fitJobEntries: readonly GarminFitJobEntry[],
): string {
  return `garmin-dump-fit-batch-${createHash("sha256")
    .update(`${userId}\n${uploadPath}\n${fitJobEntries.map(({ entry }) => entry.path).join("\n")}`)
    .digest("hex")}`;
}

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

interface ParsedGarminDump {
  summaries: GarminSummarizedActivity[];
  fitFiles: GarminDumpEntry[];
  weightFitFiles: GarminDumpEntry[];
  errors: SyncError[];
  tempDirectories: string[];
}

interface GarminDumpExtractionState {
  extractedBytes: number;
}

export interface GarminDumpImportOptions {
  extendLock?: (durationMs: number) => Promise<void>;
  onProgress?: (progress: GarminDumpProgress) => void | Promise<void>;
  preserveTempDirectories?: readonly string[];
}

interface GarminDumpProgress {
  percentage: number;
  message: string;
}

const GARMIN_ACTIVITY_TYPE_MAP: Readonly<Record<string, LegacyActivityType>> = {
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
): ProviderActivityType {
  const normalizedActivityType = normalizeGarminType(activityType);
  const normalizedSportType = normalizeGarminType(sportType);
  const normalizedType =
    GARMIN_ACTIVITY_TYPE_MAP[normalizedActivityType] ??
    GARMIN_ACTIVITY_TYPE_MAP[normalizedSportType] ??
    "other";
  return resolveProviderActivityType(activityType ?? sportType ?? "other", normalizedType);
}

export function mapFitSportToGarminDumpActivityType(
  session: ParsedFitSession,
): ProviderActivityType {
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

function fitExternalIdFromPath(path: string): string | null {
  const fileName = path.split("/").pop() ?? path;
  const match = fileName.match(/_(\d+)(?:_[^/]*)?\.fit$/i);
  return match?.[1] ?? null;
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
  logger.info(`[garmin-dump] ${percentage}% ${message}`);
  if (!options.onProgress) return;
  try {
    await options.onProgress({ percentage, message });
  } catch (error) {
    logger.warn("Failed to report Garmin dump progress: %s", error);
    captureException(error, { tags: { garminDumpStep: "progress" } });
  }
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

async function streamToFile(
  stream: Readable,
  filePath: string,
  maxBytes: number,
  description: string,
): Promise<number> {
  let bytesRead = 0;
  await pipeline(
    stream,
    async function* limitBytes(source) {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buffer.length;
        if (bytesRead > maxBytes) {
          throw new Error(`${description} exceeds maximum size of ${maxBytes} bytes`);
        }
        yield buffer;
      }
    },
    createWriteStream(filePath, { flags: "wx" }),
  );
  return bytesRead;
}

function openZipFromPath(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zipFile) => {
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

function shouldReadGarminDumpEntry(lowerPath: string): boolean {
  if (lowerPath.endsWith(".fit")) return true;
  if (lowerPath.endsWith(summarizedActivitiesSuffix)) return true;
  return lowerPath.endsWith(".zip") && lowerPath.includes("/di-connect-uploaded-files/");
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
  rootArchivePath: string,
  zipPath: string,
  extractionDirectory: string,
  prefix = "",
  entryPathPrefix: string[] = [],
  state: GarminDumpExtractionState = { extractedBytes: 0 },
): Promise<GarminDumpEntry[]> {
  const zipFile = await openZipFromPath(zipPath);
  const entries: GarminDumpEntry[] = [];

  try {
    while (true) {
      const entry = await readNextZipEntry(zipFile);
      if (!entry) return entries;
      if (/\/$/.test(entry.fileName)) continue;

      const path = `${prefix}${entry.fileName}`;
      const lowerPath = path.toLowerCase();
      if (!shouldReadGarminDumpEntry(lowerPath)) continue;

      const maxEntryBytes = lowerPath.endsWith(".zip")
        ? MAX_GARMIN_DUMP_NESTED_ZIP_BYTES
        : MAX_GARMIN_DUMP_ENTRY_BYTES;
      assertGarminDumpSize(entry.uncompressedSize, maxEntryBytes, `Garmin dump entry ${path}`);
      if (lowerPath.endsWith(".zip")) {
        const nestedEntryPath = [...entryPathPrefix, entry.fileName];
        const stream = await openReadStream(zipFile, entry);
        const nestedZipPath = join(
          extractionDirectory,
          `${createHash("sha256").update(path).digest("hex")}.zip`,
        );
        const bytesRead = await streamToFile(
          stream,
          nestedZipPath,
          maxEntryBytes,
          `Garmin dump entry ${path}`,
        );
        countExtractedBytes(state, bytesRead, path);
        entries.push(
          ...(await collectZipEntries(
            rootArchivePath,
            nestedZipPath,
            extractionDirectory,
            `${path}/`,
            nestedEntryPath,
            state,
          )),
        );
        await rm(nestedZipPath, { force: true });
        continue;
      }

      if (lowerPath.endsWith(summarizedActivitiesSuffix)) {
        const filePath = join(
          extractionDirectory,
          `${createHash("sha256").update(path).digest("hex")}.json`,
        );
        const stream = await openReadStream(zipFile, entry);
        const bytesRead = await streamToFile(
          stream,
          filePath,
          maxEntryBytes,
          `Garmin dump entry ${path}`,
        );
        countExtractedBytes(state, bytesRead, path);
        entries.push({
          path,
          filePath,
          archivePath: rootArchivePath,
          entryPath: [...entryPathPrefix, entry.fileName],
          outputDirectory: extractionDirectory,
        });
        continue;
      }

      countExtractedBytes(state, entry.uncompressedSize, path);
      entries.push({
        path,
        archivePath: rootArchivePath,
        entryPath: [...entryPathPrefix, entry.fileName],
        outputDirectory: extractionDirectory,
        maxBytes: MAX_GARMIN_DUMP_ENTRY_BYTES,
        nestedArchiveMaxBytes: MAX_GARMIN_DUMP_NESTED_ZIP_BYTES,
      });
    }
  } finally {
    zipFile.close();
  }
}

async function collectDirectoryEntries(rootPath: string): Promise<{
  entries: GarminDumpEntry[];
  tempDirectories: string[];
}> {
  const entries: GarminDumpEntry[] = [];
  const tempDirectories: string[] = [];
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
      if (!shouldReadGarminDumpEntry(lowerPath)) continue;

      const maxEntryBytes = lowerPath.endsWith(".zip")
        ? MAX_GARMIN_DUMP_NESTED_ZIP_BYTES
        : MAX_GARMIN_DUMP_ENTRY_BYTES;
      assertGarminDumpSize(childStats.size, maxEntryBytes, `Garmin dump file ${relativePath}`);
      countExtractedBytes(state, childStats.size, relativePath);
      if (lowerPath.endsWith(".zip")) {
        const extractionDirectory = await mkdtemp(join(rootPath, ".garmin-dump-extract-"));
        tempDirectories.push(extractionDirectory);
        entries.push(
          ...(await collectZipEntries(
            childPath,
            childPath,
            extractionDirectory,
            `${relativePath}/`,
            [],
            state,
          )),
        );
      } else {
        entries.push({ path: relativePath, filePath: childPath });
      }
    }
  }

  await visit(rootPath);
  return { entries, tempDirectories };
}

export async function parseGarminDumpFile(filePath: string): Promise<ParsedGarminDump> {
  const fileStats = await stat(filePath);
  if (fileStats.isFile()) {
    if (!filePath.toLowerCase().endsWith(".zip")) {
      throw new Error("Garmin dump import expects a .zip file or extracted export directory");
    }
    assertGarminDumpSize(fileStats.size, MAX_GARMIN_DUMP_INPUT_BYTES, "Garmin dump upload");
  }
  const tempDirectories: string[] = [];
  let entries: GarminDumpEntry[];
  try {
    if (fileStats.isDirectory()) {
      const directoryResult = await collectDirectoryEntries(filePath);
      tempDirectories.push(...directoryResult.tempDirectories);
      entries = directoryResult.entries;
    } else {
      const extractionDirectory = await mkdtemp(
        join(dirname(filePath), `${basename(filePath)}-extract-`),
      );
      tempDirectories.push(extractionDirectory);
      entries = await collectZipEntries(filePath, filePath, extractionDirectory);
    }
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
        if (!entry.filePath) {
          throw new Error(`Garmin summarized activities ${entry.path} was not extracted`);
        }
        const parsedJson: unknown = JSON.parse(await readFile(entry.filePath, "utf8"));
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

    return { summaries, fitFiles, weightFitFiles, errors, tempDirectories };
  } catch (error) {
    await Promise.all(
      tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    throw error;
  }
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
    name: summary.name ?? `Garmin ${activityType.canonicalType.replace(/_/g, " ")}`,
  };
}

async function cleanupUnrecordedGarminDumpDirectories(
  filePath: string,
  preserveTempDirectories: readonly string[] | undefined,
): Promise<void> {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    return;
  }

  const parentDirectory = dirname(filePath);
  const extractionPrefix = `${basename(filePath)}-extract-`;
  const preservedDirectories = new Set(preserveTempDirectories);
  const directoryEntries = await readdir(parentDirectory, { withFileTypes: true });
  const staleDirectories = directoryEntries
    .filter(
      (directoryEntry) =>
        directoryEntry.isDirectory() &&
        directoryEntry.name.startsWith(extractionPrefix) &&
        !preservedDirectories.has(join(parentDirectory, directoryEntry.name)),
    )
    .map((directoryEntry) => join(parentDirectory, directoryEntry.name));
  await Promise.all(
    staleDirectories.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
  );
}

export async function prepareGarminDumpImport(
  db: SyncDatabase,
  filePath: string,
  userId: string,
  options: GarminDumpImportOptions = {},
): Promise<PreparedGarminDumpImport> {
  await reportGarminDumpProgress(options, 0, "Starting Garmin dump import...");
  await extendGarminDumpImportLock(options);
  const errors: SyncError[] = [];
  let recordsSynced = 0;
  let parsedDump: ParsedGarminDump | null = null;
  let preparationComplete = false;
  const summaryByExternalId = new Map<string, GarminSummarizedActivity>();

  try {
    await reportGarminDumpProgress(options, 0, "Reading Garmin dump...");
    await cleanupUnrecordedGarminDumpDirectories(filePath, options.preserveTempDirectories);
    parsedDump = await parseGarminDumpFile(filePath);
    errors.push(...parsedDump.errors);
    const totalFitFileCount = parsedDump.fitFiles.length + parsedDump.weightFitFiles.length;
    await reportGarminDumpProgress(
      options,
      0,
      `Found ${parsedDump.summaries.length} activity summaries and ${totalFitFileCount} FIT files.`,
    );

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
      const name = summary.name ?? `Garmin ${activityType.canonicalType.replace(/_/g, " ")}`;
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

    const fitJobEntries: GarminFitJobEntry[] = parsedDump.weightFitFiles.map((entry) => ({
      entry,
      data: {
        originalPath: entry.path,
        userId,
        providerId: GARMIN_DUMP_PROVIDER_ID,
        sourceName: GARMIN_DUMP_PROVIDER_NAME,
      },
    }));

    for (const fitFile of parsedDump.fitFiles) {
      const externalId = fitExternalIdFromPath(fitFile.path);
      const summary = externalId ? summaryByExternalId.get(externalId) : undefined;
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

    await extendGarminDumpImportLock(options);
    await reportGarminDumpProgress(
      options,
      0,
      `Importing Garmin FIT files (0/${fitJobEntries.length})...`,
    );

    const preparedImport: PreparedGarminDumpImport = {
      uploadPath: filePath,
      userId,
      batchId: createGarminFitBatchId(filePath, userId, fitJobEntries),
      baseResult: {
        recordsSynced,
        errors: errors.map((error) => ({ message: error.message })),
      },
      fitJobEntries,
      tempDirectories: [...parsedDump.tempDirectories],
      totalFitFiles: fitJobEntries.length,
    };
    preparationComplete = true;
    return preparedImport;
  } finally {
    if (!preparationComplete && parsedDump) {
      await cleanupPreparedGarminDumpImport(parsedDump.tempDirectories);
    }
  }
}

export async function cleanupPreparedGarminDumpImport(
  tempDirectories: readonly string[],
): Promise<void> {
  await Promise.all(
    tempDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export class GarminDumpProvider implements ImportProvider {
  readonly id = GARMIN_DUMP_PROVIDER_ID;
  readonly name = GARMIN_DUMP_PROVIDER_NAME;
  readonly importOnly = true as const;

  validate(): string | null {
    return null;
  }
}
