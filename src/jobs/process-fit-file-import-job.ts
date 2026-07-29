import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  resolveProviderActivityType,
  type LegacyActivityType,
  type ProviderActivityType,
} from "@dofek/training/activity-types";
import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import {
  replaceMetricStreamBatch,
  writeMetricStreamBatch,
  writeMetricStreamBatchForScope,
} from "../db/metric-stream-writer.ts";
import {
  findUniqueProviderActivityByExactIdentity,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { SOURCE_TYPE_FILE } from "../db/sensor-channels.ts";
import { fitExternalIdFromFile } from "../fit/external-id.ts";
import { type ParsedFitRecord, type ParsedFitSession, parseFitRecord } from "../fit/parser.ts";
import { fitRecordsToSensorSamples } from "../fit/records.ts";
import {
  FitDecoderError,
  type FitStreamMetadata,
  type ParsedFitWeight,
  streamFitFile,
} from "../fit/stream-decoder.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import type { MetricStreamEventPublisher } from "../metric-stream/redpanda-producer.ts";
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

type ReplacementCapableMetricStreamPublisher = MetricStreamEventPublisher & {
  replaceRows: NonNullable<MetricStreamEventPublisher["replaceRows"]>;
};

class FitFileImportValidationError extends Error {}

function isReplacementCapableMetricStreamPublisher(
  publisher: MetricStreamEventPublisher,
): publisher is ReplacementCapableMetricStreamPublisher {
  return typeof publisher.replaceRows === "function";
}

function requireActivityMetricStreamPublisher(
  publisher: MetricStreamEventPublisher | undefined,
): ReplacementCapableMetricStreamPublisher | undefined {
  if (publisher && !isReplacementCapableMetricStreamPublisher(publisher)) {
    throw new Error("FIT activity imports require a scoped replacement publisher");
  }
  return publisher;
}

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
    captureException(error, { tags: { fitImportStep: "updateProgress" } });
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

function activityTypeFromFitSession(session: ParsedFitSession): ProviderActivityType {
  const sport = normalizedFitSport(session.sport);
  const subSport = normalizedFitSport(session.subSport);
  const typeBySport: Record<string, LegacyActivityType> = {
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
    if (activityType) {
      return resolveProviderActivityType(
        session.subSport ?? session.sport ?? candidate,
        activityType,
      );
    }
  }
  return resolveProviderActivityType(
    session.subSport ?? session.sport ?? "other",
    "other",
  );
}

const FIT_FILE_TYPE_ACTIVITY = 4;
const stagedRecordBatchSchema = z
  .array(
    z.object({
      recordedAt: z.coerce.date(),
      raw: z.record(z.string(), z.unknown()),
    }),
  )
  .max(250);
const stagedWeightBatchSchema = z
  .array(
    z.object({
      timestamp: z.coerce.date(),
      weight: z.number().finite().optional(),
      percentFat: z.number().finite().optional(),
      percentHydration: z.number().finite().optional(),
      boneMass: z.number().finite().optional(),
      muscleMass: z.number().finite().optional(),
      bmi: z.number().finite().optional(),
      raw: z.record(z.string(), z.unknown()),
    }),
  )
  .max(250);

interface FitImportSpool {
  directory: string;
  recordBatchCount: number;
  weightBatchCount: number;
  weightMessageCount: number;
}

async function createFitImportSpool(): Promise<FitImportSpool> {
  return {
    directory: await mkdtemp(join(tmpdir(), "dofek-fit-import-")),
    recordBatchCount: 0,
    weightBatchCount: 0,
    weightMessageCount: 0,
  };
}

function spoolBatchPath(
  spool: FitImportSpool,
  batchType: "records" | "weights",
  batchIndex: number,
): string {
  return join(spool.directory, `${batchType}-${batchIndex}.json`);
}

async function stageRecordBatch(spool: FitImportSpool, records: ParsedFitRecord[]): Promise<void> {
  await writeFile(
    spoolBatchPath(spool, "records", spool.recordBatchCount),
    JSON.stringify(records.map((record) => ({ recordedAt: record.recordedAt, raw: record.raw }))),
  );
  spool.recordBatchCount++;
}

async function stageWeightBatch(spool: FitImportSpool, weights: ParsedFitWeight[]): Promise<void> {
  await writeFile(
    spoolBatchPath(spool, "weights", spool.weightBatchCount),
    JSON.stringify(weights),
  );
  spool.weightBatchCount++;
  spool.weightMessageCount += weights.length;
}

async function replayRecordBatches(
  spool: FitImportSpool,
  writeBatch: (records: ParsedFitRecord[]) => Promise<void>,
): Promise<void> {
  for (let batchIndex = 0; batchIndex < spool.recordBatchCount; batchIndex++) {
    const decoded: unknown = JSON.parse(
      await readFile(spoolBatchPath(spool, "records", batchIndex), "utf8"),
    );
    const records = stagedRecordBatchSchema.parse(decoded).map((record) =>
      parseFitRecord({
        ...record.raw,
        timestamp: record.raw.timestamp ?? record.recordedAt.toISOString(),
      }),
    );
    await writeBatch(records);
  }
}

async function replayWeightBatches(
  spool: FitImportSpool,
  writeBatch: (weights: ParsedFitWeight[]) => Promise<void>,
): Promise<void> {
  for (let batchIndex = 0; batchIndex < spool.weightBatchCount; batchIndex++) {
    const decoded: unknown = JSON.parse(
      await readFile(spoolBatchPath(spool, "weights", batchIndex), "utf8"),
    );
    await writeBatch(stagedWeightBatchSchema.parse(decoded));
  }
}

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
  metricStreamPublisher?: MetricStreamEventPublisher,
): Promise<void> {
  const originalPathHash = createHash("sha256").update(data.originalPath).digest("hex");
  const rows = weights.map((weight) => ({
    providerId: data.providerId,
    userId: data.userId,
    externalId: `weight:${originalPathHash}:${weight.timestamp.toISOString()}`,
    recordedAt: weight.timestamp,
    sourceName: data.sourceName,
    weightKg: weight.weight,
    bodyFatPct: weight.percentFat,
    waterPct: weight.percentHydration,
    boneMassKg: weight.boneMass,
    muscleMassKg: weight.muscleMass,
    bmi: weight.bmi,
  }));
  if (metricStreamPublisher) {
    await writeMetricStreamBatch(db, rows, SOURCE_TYPE_FILE, undefined, metricStreamPublisher);
    return;
  }
  await writeMetricStreamBatch(db, rows, SOURCE_TYPE_FILE);
}

async function beginActivityImport(
  db: SyncDatabase,
  data: ResolvedFitFileImportJobData,
  metadata: FitStreamMetadata,
  onProgress: (info: FitFileImportProgressInfo) => Promise<void>,
  metricStreamPublisher?: ReplacementCapableMetricStreamPublisher,
): Promise<{ activityId: string | undefined; activityType: ProviderActivityType }> {
  const session = metadata.session;
  const summary = data.activitySummary;
  const externalId =
    summary?.externalId ?? (await fitExternalIdFromFile(data.originalPath, data.filePath));
  const activityType =
    summary?.activityType ??
    (session
      ? activityTypeFromFitSession(session)
      : resolveProviderActivityType("other", "other"));
  const startedAt = summary ? new Date(summary.startedAtIso) : session?.startTime;
  if (!startedAt || Number.isNaN(startedAt.getTime())) {
    throw new FitFileImportValidationError("missing a valid start time");
  }
  const endedAt = summary
    ? summary.endedAtIso
      ? new Date(summary.endedAtIso)
      : new Date(startedAt.getTime() + (session?.totalElapsedTime ?? 0) * 1000)
    : new Date(startedAt.getTime() + (session?.totalElapsedTime ?? 0) * 1000);
  const name =
    summary?.name ??
    `FIT ${activityType.canonicalType.replace(/_/g, " ")}`;
  const raw = summary?.raw ?? { fitPath: data.originalPath, session: session?.raw ?? null };

  await onProgress({ percentage: 80, message: "Writing FIT activity data..." });
  const exactGarminSummary =
    data.providerId === "garmin-dump" && !summary
      ? await findUniqueProviderActivityByExactIdentity(db, {
          providerId: data.providerId,
          userId: data.userId,
          canonicalType: activityType.canonicalType,
          startedAt,
          endedAt,
        })
      : undefined;
  const activity =
    exactGarminSummary ??
    (await upsertProviderActivity(
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
    ));

  if (activity?.id) {
    const scope = { activityId: activity.id };
    if (metricStreamPublisher) {
      await replaceMetricStreamBatch(db, scope, [], SOURCE_TYPE_FILE, metricStreamPublisher);
    } else {
      await replaceMetricStreamBatch(db, scope, [], SOURCE_TYPE_FILE);
    }
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
  metricStreamPublisher?: MetricStreamEventPublisher,
): Promise<FitFileImportJobResult> {
  await onProgress({ percentage: 10, message: "Reading FIT file..." });
  await onProgress({ percentage: 25, message: "Decoding FIT file..." });
  const spool = await createFitImportSpool();
  try {
    let importType: "activity" | "unsupported" | "weight" | undefined;
    let streamMetadata: FitStreamMetadata | undefined;
    try {
      await streamFitFile(data.filePath, {
        onMetadata: async (metadata) => {
          streamMetadata = metadata;
          if (metadata.isWeightFile) {
            importType = "weight";
            await onProgress({ percentage: 50, message: "Importing FIT weight data..." });
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
        },
        onRecordBatch: async (records) => {
          if (importType === "activity") {
            await stageRecordBatch(spool, records);
          }
        },
        onWeightBatch: async (weights) => {
          if (importType === "weight") {
            await stageWeightBatch(spool, weights);
          }
        },
      });
    } catch (error) {
      if (error instanceof FitDecoderError || error instanceof FitFileImportValidationError) {
        return fitFileImportErrorResult(data, error);
      }
      throw error;
    }

    if (!streamMetadata || !importType) {
      return fitFileImportErrorResult(
        data,
        new FitDecoderError("Native FIT decoder returned no file metadata"),
      );
    }

    if (importType === "weight") {
      await onProgress({ percentage: 80, message: "Writing FIT weight data..." });
      await replayWeightBatches(spool, (weights) =>
        writeWeightBatch(db, data, weights, metricStreamPublisher),
      );
      recordDroppedFitFields(data.providerId, streamMetadata, weightConsumedFields);
    } else if (importType === "activity") {
      const activityMetricStreamPublisher =
        requireActivityMetricStreamPublisher(metricStreamPublisher);
      let activityImport: Awaited<ReturnType<typeof beginActivityImport>>;
      try {
        activityImport = await beginActivityImport(
          db,
          data,
          streamMetadata,
          onProgress,
          activityMetricStreamPublisher,
        );
      } catch (error) {
        if (error instanceof FitFileImportValidationError) {
          return fitFileImportErrorResult(data, error);
        }
        throw error;
      }
      const activityId = activityImport.activityId;
      if (activityId) {
        await replayRecordBatches(spool, async (records) => {
          const rows = fitRecordsToSensorSamples(
            records,
            data.providerId,
            activityId,
            activityImport.activityType.modality,
          ).map((row) => ({ ...row, userId: data.userId }));
          const scope = { activityId };
          if (activityMetricStreamPublisher) {
            await writeMetricStreamBatchForScope(
              db,
              scope,
              rows,
              SOURCE_TYPE_FILE,
              activityMetricStreamPublisher,
            );
          } else {
            await writeMetricStreamBatchForScope(db, scope, rows, SOURCE_TYPE_FILE);
          }
        });
      }
    } else {
      recordDroppedFitFields(data.providerId, streamMetadata, routingConsumedFields);
    }

    const result: FitFileImportJobResult = {
      recordsSynced:
        importType === "weight"
          ? spool.weightMessageCount
          : importType === "activity" && data.activitySummary === undefined
            ? 1
            : 0,
      errors: [],
    };
    await onProgress({
      percentage: 100,
      message: "FIT file import complete.",
    });
    return result;
  } finally {
    await rm(spool.directory, { recursive: true });
  }
}

export async function processFitFileImportJob(
  job: FitFileImportJob,
  db: SyncDatabase,
  metricStreamPublisher?: MetricStreamEventPublisher,
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
  const result = await importFitFile(
    db,
    data,
    (info) => updateFitFileImportProgress(job, info),
    metricStreamPublisher,
  );
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
