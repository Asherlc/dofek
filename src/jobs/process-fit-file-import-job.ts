import { rm } from "node:fs/promises";
import { basename } from "node:path";
import type { CanonicalActivityType } from "@dofek/training/training";
import * as Sentry from "@sentry/node";
import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import {
  replaceMetricStreamBatch,
  writeMetricStreamBatch,
  writeMetricStreamBatchForScope,
} from "../db/metric-stream-writer.ts";
import { upsertProviderActivity } from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_FILE } from "../db/sensor-channels.ts";
import { fitExternalIdFromFile } from "../fit/external-id.ts";
import type { ParsedFitSession } from "../fit/parser.ts";
import { fitRecordsToSensorSamples } from "../fit/records.ts";
import {
  FitDecoderError,
  type FitStreamMetadata,
  type ParsedFitWeight,
  streamFitFile,
} from "../fit/stream-decoder.ts";
import { logger } from "../logger.ts";
import {
  fitImportDroppedFieldOccurrencesTotal,
  fitImportFilesWithDroppedFieldTotal,
} from "../sync-metrics.ts";
import {
  type FitFileImportJobData,
  type FitFileImportJobResult,
  fitFileImportJobDataSchema,
} from "./queues.ts";

interface FitFileImportJob {
  data: unknown;
  getChildrenValues?: () => Promise<Record<string, unknown>>;
  getIgnoredChildrenFailures?: () => Promise<Record<string, string>>;
  updateProgress: (data: FitFileImportProgressInfo) => Promise<void>;
}

export interface FitFileImportProgressInfo {
  percentage: number;
  message: string;
}

const zipEntryExtractJobResultSchema = z.object({
  filePath: z.string(),
});

const fitFileImportErrorPathSchema = z.looseObject({
  originalPath: z.string().optional(),
});

type ResolvedFitFileImportJobData = FitFileImportJobData & { filePath: string };

class FitFileImportValidationError extends Error {}

function originalPathFromJobData(data: unknown): string {
  const parsed = fitFileImportErrorPathSchema.safeParse(data);
  return parsed.success ? (parsed.data.originalPath ?? "unknown FIT file") : "unknown FIT file";
}

function sanitizedFitFileName(originalPath: string): string {
  return basename(originalPath).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted]");
}

function sanitizedFitImportError(error: unknown, originalPath: string): Error {
  const sanitizedFileName = sanitizedFitFileName(originalPath);
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage
    .replaceAll(originalPath, sanitizedFileName)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted]");
  const sanitizedError = new Error(message);
  sanitizedError.name = error instanceof Error ? error.name : "Error";
  return sanitizedError;
}

function fitFileImportErrorResult(data: unknown, error: unknown): FitFileImportJobResult {
  const originalPath = originalPathFromJobData(data);
  const fileName = sanitizedFitFileName(originalPath);
  const sanitizedError = sanitizedFitImportError(error, originalPath);
  logger.error("Failed to import FIT file %s: %s", fileName, sanitizedError.message);
  return {
    recordsSynced: 0,
    errors: [
      {
        message: `Failed to import FIT file ${fileName}: ${sanitizedError.message}`,
      },
    ],
  };
}

function unrecoverableErrorFromResult(result: FitFileImportJobResult): UnrecoverableError {
  return new UnrecoverableError(result.errors.map((error) => error.message).join("; "));
}

async function updateFitFileImportProgress(
  job: FitFileImportJob,
  info: FitFileImportProgressInfo,
): Promise<void> {
  await job.updateProgress(info).catch((error: unknown) => {
    logger.warn("Failed to update FIT import progress: %s", error);
    Sentry.captureException(error, { tags: { fitImportStep: "updateProgress" } });
  });
}

function normalizedFitSport(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[\s-]+/g, "_") ?? ""
  );
}

function activityTypeFromFitSession(session: ParsedFitSession): CanonicalActivityType {
  const sport = normalizedFitSport(session.sport);
  const subSport = normalizedFitSport(session.subSport);
  const typeBySport: Record<string, CanonicalActivityType> = {
    cycling: "cycling",
    road: "cycling",
    road_biking: "cycling",
    mountain: "cycling",
    mountain_biking: "cycling",
    virtual_activity: "indoor_cycling",
    virtual_ride: "indoor_cycling",
    indoor_cycling: "indoor_cycling",
    running: "running",
    treadmill: "running",
    treadmill_running: "running",
    trail: "trail_running",
    trail_running: "trail_running",
    walking: "walking",
    hiking: "hiking",
    swimming: "swimming",
    lap_swimming: "swimming",
    strength_training: "strength",
    training: "strength",
    rowing: "rowing",
    yoga: "yoga",
    skiing: "skiing",
  };
  for (const candidate of [subSport, sport]) {
    const activityType = typeBySport[candidate];
    if (activityType) return activityType;
  }
  return "other";
}

const FIT_FILE_TYPE_ACTIVITY = 4;
const routingConsumedFields = new Map<string, ReadonlySet<string>>([
  ["fileIdMesgs", new Set(["type"])],
]);
const weightConsumedFields = new Map<string, ReadonlySet<string>>([
  ...routingConsumedFields,
  [
    "weightScaleMesgs",
    new Set([
      "timestamp",
      "weight",
      "percentFat",
      "percentHydration",
      "boneMass",
      "muscleMass",
      "bmi",
    ]),
  ],
]);

function fitNameToCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function fitFileTypeLabel(metadata: FitStreamMetadata): string {
  if (metadata.fileTypeName !== null) {
    return fitNameToCamelCase(metadata.fileTypeName);
  }
  return metadata.fileType === null ? "unknown" : String(metadata.fileType);
}

function droppedFitFieldReason(messageType: string): "derived" | "unsupported" {
  return messageType === "stressLevelMesgs" ? "derived" : "unsupported";
}

function recordDroppedFitFields(
  providerId: string,
  metadata: FitStreamMetadata,
  consumedFields: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const fileType = fitFileTypeLabel(metadata);
  for (const occurrence of metadata.fieldOccurrences) {
    const messageType = `${fitNameToCamelCase(occurrence.messageType)}Mesgs`;
    const field = fitNameToCamelCase(occurrence.field);
    if (consumedFields.get(messageType)?.has(field)) {
      continue;
    }
    const attributes = {
      provider: providerId,
      file_type: fileType,
      message_type: messageType,
      field,
      reason: droppedFitFieldReason(messageType),
    };
    fitImportDroppedFieldOccurrencesTotal.add(occurrence.occurrences, attributes);
    fitImportFilesWithDroppedFieldTotal.add(1, attributes);
  }
}

async function writeWeightBatch(
  db: SyncDatabase,
  data: ResolvedFitFileImportJobData,
  weights: ParsedFitWeight[],
): Promise<void> {
  await writeMetricStreamBatch(
    db,
    weights.map((weight) => ({
      providerId: data.providerId,
      userId: data.userId,
      externalId: `weight:${data.originalPath}:${weight.timestamp.toISOString()}`,
      recordedAt: weight.timestamp,
      sourceName: data.sourceName,
      weightKg: weight.weight,
      bodyFatPct: weight.percentFat,
      waterPct: weight.percentHydration,
      boneMassKg: weight.boneMass,
      muscleMassKg: weight.muscleMass,
      bmi: weight.bmi,
    })),
    SOURCE_TYPE_FILE,
  );
}

async function beginActivityImport(
  db: SyncDatabase,
  data: ResolvedFitFileImportJobData,
  metadata: FitStreamMetadata,
  onProgress: (info: FitFileImportProgressInfo) => Promise<void>,
): Promise<{ activityId: string | undefined; activityType: CanonicalActivityType }> {
  const session = metadata.session;
  const summary = data.activitySummary;
  const externalId =
    summary?.externalId ?? (await fitExternalIdFromFile(data.originalPath, data.filePath));
  const activityType =
    summary?.activityType ?? (session ? activityTypeFromFitSession(session) : "other");
  const startedAt = summary ? new Date(summary.startedAtIso) : session?.startTime;
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    throw new FitFileImportValidationError("missing a valid start time");
  }
  const endedAt = summary
    ? summary.endedAtIso
      ? new Date(summary.endedAtIso)
      : new Date(startedAt.getTime() + (session?.totalElapsedTime ?? 0) * 1000)
    : new Date(startedAt.getTime() + (session?.totalElapsedTime ?? 0) * 1000);
  const name = summary?.name ?? `FIT ${activityType.replace(/_/g, " ")}`;
  const raw = summary?.raw ?? { fitPath: data.originalPath, session: session?.raw ?? null };

  await onProgress({ percentage: 80, message: "Writing FIT activity data..." });
  const activity = await upsertProviderActivity(
    db,
    {
      providerId: data.providerId,
      userId: data.userId,
      externalId,
      activityType,
      startedAt,
      endedAt,
      name,
      sourceName: data.sourceName,
      raw,
    },
    {
      activityType,
      startedAt,
      endedAt,
      name,
      sourceName: data.sourceName,
      raw,
    },
  );

  if (activity?.id) {
    await replaceMetricStreamBatch(db, { activityId: activity.id }, [], SOURCE_TYPE_FILE);
  }
  return { activityId: activity?.id, activityType };
}

async function resolveFlowChildFilePath(job: FitFileImportJob): Promise<string> {
  if (!job.getChildrenValues) {
    throw new FitFileImportValidationError(
      "FIT import job is missing filePath and has no child extraction result",
    );
  }
  const [childrenValues, ignoredChildFailures] = await Promise.all([
    job.getChildrenValues(),
    job.getIgnoredChildrenFailures?.() ?? Promise.resolve({}),
  ]);
  const extractionFailures = Object.values(ignoredChildFailures);
  if (extractionFailures.length > 0) {
    throw new FitFileImportValidationError(
      `FIT extraction failed: ${extractionFailures.join("; ")}`,
    );
  }
  const extractResults = Object.values(childrenValues).map((value) =>
    zipEntryExtractJobResultSchema.parse(value),
  );
  const [extractResult] = extractResults;
  if (!extractResult || extractResults.length !== 1) {
    throw new FitFileImportValidationError(
      `FIT import job expected 1 child extraction result, got ${extractResults.length}`,
    );
  }
  return extractResult.filePath;
}

async function resolveFitFileImportJobData(
  job: FitFileImportJob,
): Promise<ResolvedFitFileImportJobData> {
  const data = fitFileImportJobDataSchema.parse(job.data);
  return { ...data, filePath: data.filePath ?? (await resolveFlowChildFilePath(job)) };
}

export async function importFitFile(
  db: SyncDatabase,
  data: FitFileImportJobData & { filePath: string },
  onProgress: (info: FitFileImportProgressInfo) => Promise<void>,
): Promise<FitFileImportJobResult> {
  await onProgress({ percentage: 10, message: "Reading FIT file..." });
  await onProgress({ percentage: 25, message: "Decoding FIT file..." });
  let importType: "activity" | "unsupported" | "weight" | undefined;
  let streamMetadata: FitStreamMetadata | undefined;
  let activityId: string | undefined;
  let activityType: CanonicalActivityType | undefined;
  let weightCount = 0;
  try {
    await streamFitFile(data.filePath, {
      onMetadata: async (metadata) => {
        streamMetadata = metadata;
        if (metadata.isWeightFile) {
          importType = "weight";
          await onProgress({ percentage: 50, message: "Importing FIT weight data..." });
          await onProgress({ percentage: 80, message: "Writing FIT weight data..." });
          return;
        }
        if (data.activitySummary === undefined && metadata.fileType !== null) {
          if (metadata.fileType !== FIT_FILE_TYPE_ACTIVITY) {
            importType = "unsupported";
            await onProgress({ percentage: 50, message: "Inspecting FIT data..." });
            return;
          }
        }
        importType = "activity";
        await onProgress({ percentage: 50, message: "Importing FIT activity..." });
        const activityImport = await beginActivityImport(db, data, metadata, onProgress);
        activityId = activityImport.activityId;
        activityType = activityImport.activityType;
      },
      onRecordBatch: async (records) => {
        if (importType !== "activity" || !activityId || !activityType) return;
        const rows = fitRecordsToSensorSamples(
          records,
          data.providerId,
          activityId,
          activityType,
        ).map((row) => ({ ...row, userId: data.userId }));
        await writeMetricStreamBatchForScope(db, { activityId }, rows, SOURCE_TYPE_FILE);
      },
      onWeightBatch: async (weights) => {
        if (importType !== "weight") return;
        await writeWeightBatch(db, data, weights);
        weightCount += weights.length;
      },
    });
  } catch (error) {
    if (error instanceof FitDecoderError || error instanceof FitFileImportValidationError) {
      return fitFileImportErrorResult(data, error);
    }
    throw error;
  }
  if (streamMetadata && importType === "weight") {
    recordDroppedFitFields(data.providerId, streamMetadata, weightConsumedFields);
  } else if (streamMetadata && importType === "unsupported") {
    recordDroppedFitFields(data.providerId, streamMetadata, routingConsumedFields);
  }
  const result: FitFileImportJobResult = {
    recordsSynced:
      importType === "weight"
        ? weightCount
        : importType === "activity" && data.activitySummary === undefined
          ? 1
          : 0,
    errors: [],
  };
  if (result.errors.length === 0) {
    await onProgress({
      percentage: 100,
      message: "FIT file import complete.",
    });
  }
  return result;
}

export async function processFitFileImportJob(
  job: FitFileImportJob,
  db: SyncDatabase,
): Promise<FitFileImportJobResult> {
  await updateFitFileImportProgress(job, {
    percentage: 0,
    message: "Starting FIT file import...",
  });
  let data: ResolvedFitFileImportJobData;
  try {
    data = await resolveFitFileImportJobData(job);
  } catch (error) {
    if (!(error instanceof z.ZodError || error instanceof FitFileImportValidationError)) {
      throw error;
    }
    throw unrecoverableErrorFromResult(fitFileImportErrorResult(job.data, error));
  }
  const result = await importFitFile(db, data, (info) => updateFitFileImportProgress(job, info));
  if (result.errors.length > 0) {
    if (data.deleteFileAfterImport) {
      await rm(data.filePath, { force: true });
    }
    throw unrecoverableErrorFromResult(result);
  }
  if (data.deleteFileAfterImport) {
    await rm(data.filePath, { force: true });
  }
  return result;
}
