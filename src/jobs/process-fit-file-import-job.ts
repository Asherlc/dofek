/// <reference path="../activity-export/garmin-fitsdk.d.ts" />

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CanonicalActivityType } from "@dofek/training/training";
import { Decoder, Stream } from "@garmin/fitsdk";
import * as Sentry from "@sentry/node";
import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { replaceMetricStreamBatch, writeMetricStreamBatch } from "../db/metric-stream-writer.ts";
import { upsertProviderActivity } from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_FILE } from "../db/sensor-channels.ts";
import { fitExternalId } from "../fit/external-id.ts";
import { parseFitFileInWorkerThread } from "../fit/parser-worker.ts";
import { fitRecordsToSensorSamples } from "../fit/records.ts";
import { logger } from "../logger.ts";
import { type FitFileImportJobData, fitFileImportJobDataSchema } from "./queues.ts";

interface FitFileImportJob {
  data: unknown;
  getChildrenValues?: () => Promise<Record<string, unknown>>;
  getIgnoredChildrenFailures?: () => Promise<Record<string, string>>;
  updateProgress: (data: FitFileImportProgressInfo) => Promise<void>;
}

export interface FitFileImportJobResult {
  recordsSynced: number;
  errors: Array<{ message: string }>;
}

export interface FitFileImportProgressInfo {
  percentage: number;
  message: string;
}

const fitDateSchema = z.union([z.string(), z.date()]).transform((value, context) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a valid FIT timestamp",
    });
    return z.NEVER;
  }
  return date;
});

const weightScaleMessageSchema = z
  .object({
    timestamp: fitDateSchema,
    weight: z.number().optional(),
    percentFat: z.number().optional(),
    percentHydration: z.number().optional(),
    boneMass: z.number().optional(),
    muscleMass: z.number().optional(),
    bmi: z.number().optional(),
  })
  .passthrough();

const fitMessagesSchema = z.object({
  fileIdMesgs: z
    .array(
      z
        .object({
          type: z.union([z.string(), z.number()]).optional(),
        })
        .passthrough(),
    )
    .optional(),
  weightScaleMesgs: z.array(weightScaleMessageSchema).optional(),
});

const decodedFitSchema = z.object({
  errors: z.array(z.unknown()).optional(),
  messages: fitMessagesSchema.optional(),
});

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
  const fitFileId = createHash("sha256").update(originalPath).digest("hex");
  const fileName = sanitizedFitFileName(originalPath);
  const sanitizedError = sanitizedFitImportError(error, originalPath);
  Sentry.captureException(sanitizedError, {
    tags: { fitImportStep: "process" },
    extra: { fitFileId },
  });
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

function activityTypeFromFitSession(
  session: Awaited<ReturnType<typeof parseFitFileInWorkerThread>>["session"],
): CanonicalActivityType {
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

function decodeFitMessages(buffer: Buffer) {
  const decoder = new Decoder(Stream.fromBuffer(buffer));
  const decoded: unknown = decoder.read();
  const parsed = decodedFitSchema.parse(decoded);
  const decodedErrors = parsed.errors ?? [];
  if (decodedErrors.length > 0) {
    throw new Error(`FIT decoder reported ${decodedErrors.length} errors`);
  }
  return parsed.messages ?? {};
}

const FIT_FILE_TYPE_WEIGHT = 9;

function isWeightFit(messages: z.infer<typeof fitMessagesSchema>): boolean {
  const fileType = messages.fileIdMesgs?.find((message) => message.type)?.type;
  return (
    fileType === "weight" || fileType === FIT_FILE_TYPE_WEIGHT || (messages.weightScaleMesgs?.length ?? 0) > 0
  );
}

async function importWeightFit(
  db: SyncDatabase,
  data: ResolvedFitFileImportJobData,
  messages: z.infer<typeof fitMessagesSchema>,
): Promise<FitFileImportJobResult> {
  const rows = messages.weightScaleMesgs ?? [];
  if (rows.length === 0) {
    return { recordsSynced: 0, errors: [] };
  }

  await writeMetricStreamBatch(
    db,
    rows.map((row) => ({
      providerId: data.providerId,
      userId: data.userId,
      externalId: `weight:${data.originalPath}:${row.timestamp.toISOString()}`,
      recordedAt: row.timestamp,
      sourceName: data.sourceName,
      weightKg: row.weight,
      bodyFatPct: row.percentFat,
      waterPct: row.percentHydration,
      boneMassKg: row.boneMass,
      muscleMassKg: row.muscleMass,
      bmi: row.bmi,
    })),
    SOURCE_TYPE_FILE,
  );

  return { recordsSynced: rows.length, errors: [] };
}

async function importActivityFit(
  db: SyncDatabase,
  data: ResolvedFitFileImportJobData,
  buffer: Buffer,
  onProgress: (info: FitFileImportProgressInfo) => Promise<void>,
): Promise<FitFileImportJobResult> {
  let fitActivity: Awaited<ReturnType<typeof parseFitFileInWorkerThread>>;
  try {
    fitActivity = await parseFitFileInWorkerThread(buffer);
  } catch (error) {
    return fitFileImportErrorResult(data, error);
  }
  const summary = data.activitySummary;
  const externalId = summary?.externalId ?? fitExternalId(data.originalPath, buffer);
  const activityType = summary?.activityType ?? activityTypeFromFitSession(fitActivity.session);
  const startedAt = summary ? new Date(summary.startedAtIso) : fitActivity.session.startTime;
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    return fitFileImportErrorResult(
      data,
      new FitFileImportValidationError("missing a valid start time"),
    );
  }
  const endedAt = summary
    ? new Date(summary.endedAtIso)
    : new Date(startedAt.getTime() + fitActivity.session.totalElapsedTime * 1000);
  const name = summary?.name ?? `FIT ${activityType.replace(/_/g, " ")}`;

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
      raw: summary?.raw ?? { fitPath: data.originalPath, session: fitActivity.session.raw },
    },
    {
      activityType,
      startedAt,
      endedAt,
      name,
      sourceName: data.sourceName,
      raw: summary?.raw ?? { fitPath: data.originalPath, session: fitActivity.session.raw },
    },
  );

  if (activity?.id) {
    const rows = fitRecordsToSensorSamples(
      fitActivity.records,
      data.providerId,
      activity.id,
      activityType,
    ).map((row) => ({ ...row, userId: data.userId }));
    await replaceMetricStreamBatch(db, { activityId: activity.id }, rows, SOURCE_TYPE_FILE);
  }

  return { recordsSynced: summary ? 0 : 1, errors: [] };
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
  const buffer = await readFile(data.filePath);
  await onProgress({ percentage: 25, message: "Decoding FIT file..." });
  let messages: z.infer<typeof fitMessagesSchema>;
  try {
    messages = decodeFitMessages(buffer);
  } catch (error) {
    return fitFileImportErrorResult(data, error);
  }
  let result: FitFileImportJobResult;
  if (isWeightFit(messages)) {
    await onProgress({
      percentage: 50,
      message: "Importing FIT weight data...",
    });
    await onProgress({
      percentage: 80,
      message: "Writing FIT weight data...",
    });
    result = await importWeightFit(db, data, messages);
  } else {
    await onProgress({
      percentage: 50,
      message: "Importing FIT activity...",
    });
    result = await importActivityFit(db, data, buffer, onProgress);
  }
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
    throw unrecoverableErrorFromResult(result);
  }
  return result;
}
