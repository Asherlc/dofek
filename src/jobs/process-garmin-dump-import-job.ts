import { WaitingChildrenError } from "bullmq";
import { z } from "zod";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { Database, SyncDatabase } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import {
  cleanupPreparedGarminDumpImport,
  prepareGarminDumpImport,
} from "../providers/garmin-dump.ts";
import type { SyncResult } from "../providers/types.ts";
import { attachGarminFitImportFlow, createBatchId, FLOW_BATCH_SIZE } from "./garmin-dump-flow.ts";
import type { LocalImportJobData } from "./local-import-job-data.ts";
import { fitFileImportJobResultSchema } from "./queues.ts";

const MAX_GARMIN_IMPORT_ERRORS = 10;

export const garminImportCheckpointSchema = z.object({
  version: z.literal(1),
  phase: z.enum(["prepared", "waiting-children"]),
  startedAtMs: z.number().int().nonnegative(),
  batchId: z.string().min(1),
  batchIds: z.array(z.string().min(1)).optional(),
  baseResult: fitFileImportJobResultSchema,
  tempDirectories: z.array(z.string()),
  totalFitFiles: z.number().int().nonnegative(),
});

export type GarminImportCheckpoint = z.infer<typeof garminImportCheckpointSchema>;

export interface GarminDumpImportResult extends SyncResult {
  batchId: string;
  totalFitFiles: number;
}

export interface GarminDumpImportJob {
  id: string;
  queueQualifiedName: string;
  data: LocalImportJobData;
  updateData(data: LocalImportJobData): Promise<void>;
  moveToWaitingChildren(): Promise<boolean>;
  getChildrenValues(): Promise<Record<string, unknown>>;
  getIgnoredChildrenFailures(): Promise<Record<string, string>>;
  extendLock(durationMs: number): Promise<void>;
  updateProgress(data: object): Promise<void>;
  log(message: string): Promise<void>;
}

function hasTransaction(
  database: SyncDatabase,
): database is SyncDatabase & Pick<Database, "transaction"> {
  return "transaction" in database && typeof database.transaction === "function";
}

function requireTransactionalDatabase(
  database: SyncDatabase,
): SyncDatabase & Pick<Database, "transaction"> {
  if (!hasTransaction(database)) {
    throw new Error("Garmin import flow dispatch requires a transactional database");
  }
  return database;
}

async function logGarminImportPhase(job: GarminDumpImportJob, message: string): Promise<void> {
  await job.log(message).catch((error: unknown) => {
    captureException(error, { tags: { garminDumpStep: "job-log" } });
    logger.warn("Failed to append Garmin import job log: %s", error);
  });
}

function fitFileLabel(count: number): string {
  return `${count} FIT ${count === 1 ? "file" : "files"}`;
}

async function persistCheckpoint(
  job: GarminDumpImportJob,
  checkpoint: GarminImportCheckpoint,
): Promise<void> {
  await job.updateData({ ...job.data, checkpoint });
}

function batchResultFromChildren(
  checkpoint: GarminImportCheckpoint,
  childValues: Record<string, unknown>,
): z.infer<typeof fitFileImportJobResultSchema> | null {
  const batchIds = checkpoint.batchIds ?? [checkpoint.batchId];
  const batchEntries = Object.entries(childValues).filter(([jobKey]) =>
    batchIds.some((id) => jobKey.endsWith(`:${id}`)),
  );
  if (batchEntries.length === 0) return null;

  let totalRecordsSynced = 0;
  const allErrors: Array<{ message: string }> = [];
  for (const [, value] of batchEntries) {
    const parsed = fitFileImportJobResultSchema.parse(value);
    totalRecordsSynced += parsed.recordsSynced;
    allErrors.push(...parsed.errors);
  }
  return { recordsSynced: totalRecordsSynced, errors: allErrors };
}

function batchFailureFromChildren(
  checkpoint: GarminImportCheckpoint,
  ignoredFailures: Record<string, string>,
): string[] {
  const batchIds = checkpoint.batchIds ?? [checkpoint.batchId];
  return Object.entries(ignoredFailures)
    .filter(([jobKey]) => batchIds.some((id) => jobKey.endsWith(`:${id}`)))
    .map(([, message]) => message);
}

function uniqueDirectories(...directoryGroups: readonly string[][]): string[] {
  return [...new Set(directoryGroups.flat())];
}

function boundedGarminImportErrors(
  baseErrors: readonly { message: string }[],
  fitErrors: readonly { message: string }[],
): Array<{ message: string }> {
  const combinedErrors = [...baseErrors, ...fitErrors];
  if (combinedErrors.length <= MAX_GARMIN_IMPORT_ERRORS) {
    return combinedErrors;
  }

  const prioritizedErrors = [...fitErrors, ...baseErrors];
  const visibleErrors = prioritizedErrors.slice(0, MAX_GARMIN_IMPORT_ERRORS - 1);
  const omittedErrorCount = prioritizedErrors.length - visibleErrors.length;
  return [
    ...visibleErrors,
    {
      message: `${omittedErrorCount} additional Garmin import error groups omitted`,
    },
  ];
}

export async function processGarminDumpImportJob(
  job: GarminDumpImportJob,
  db: SyncDatabase,
): Promise<GarminDumpImportResult> {
  const persistedCheckpoint =
    job.data.checkpoint === undefined
      ? null
      : garminImportCheckpointSchema.parse(job.data.checkpoint);
  let checkpoint = persistedCheckpoint;

  if (!checkpoint || checkpoint.phase === "prepared") {
    const preparedImport = await prepareGarminDumpImport(db, job.data.filePath, job.data.userId, {
      extendLock: job.extendLock,
      onProgress: (progress) => job.updateProgress(progress),
      preserveTempDirectories: checkpoint?.tempDirectories ?? [],
    });
    const startedAtMs = checkpoint?.startedAtMs ?? Date.now();
    const tempDirectories = uniqueDirectories(
      checkpoint?.tempDirectories ?? [],
      preparedImport.tempDirectories,
    );
    checkpoint = {
      version: 1,
      phase: "prepared",
      startedAtMs,
      batchId: preparedImport.batchId,
      baseResult: preparedImport.baseResult,
      tempDirectories,
      totalFitFiles: preparedImport.totalFitFiles,
    };
    await persistCheckpoint(job, checkpoint);
    await logGarminImportPhase(
      job,
      `[phase] Prepared Garmin dump batch ${checkpoint.batchId} with ${fitFileLabel(checkpoint.totalFitFiles)}`,
    );
    await withAccountErasureUserWriteFence(
      requireTransactionalDatabase(db),
      job.data.userId,
      async () => {
        await attachGarminFitImportFlow(
          { ...preparedImport, tempDirectories },
          { id: job.id, queue: job.queueQualifiedName },
        );
      },
    );
    const batchCount = Math.ceil(preparedImport.totalFitFiles / FLOW_BATCH_SIZE);
    const batchIds = Array.from({ length: batchCount }, (_, i) => createBatchId(preparedImport, i));
    checkpoint = { ...checkpoint, phase: "waiting-children", batchIds };
    await persistCheckpoint(job, checkpoint);
    await logGarminImportPhase(
      job,
      `[phase] Attached Garmin FIT flow for batch ${checkpoint.batchId}`,
    );
  }

  if (await job.moveToWaitingChildren()) {
    const batchCount = checkpoint.batchIds?.length ?? 1;
    const batchLabel = batchCount > 1 ? ` across ${batchCount} batches` : "";
    await logGarminImportPhase(
      job,
      `[phase] Waiting for ${checkpoint.totalFitFiles} Garmin FIT ${checkpoint.totalFitFiles === 1 ? "file" : "files"} in batch ${checkpoint.batchId}${batchLabel}`,
    );
    throw new WaitingChildrenError();
  }

  const [childValues, ignoredFailures] = await Promise.all([
    job.getChildrenValues(),
    job.getIgnoredChildrenFailures(),
  ]);
  const batchResult = batchResultFromChildren(checkpoint, childValues);
  const batchFailures = batchFailureFromChildren(checkpoint, ignoredFailures);
  if (!batchResult && batchFailures.length === 0 && checkpoint.totalFitFiles > 0) {
    throw new Error(`Garmin FIT batch result is missing: ${checkpoint.batchId}`);
  }

  const fitResult = batchResult ?? { recordsSynced: 0, errors: [] };
  for (const message of batchFailures) {
    fitResult.errors.push({ message: `Garmin FIT batch failed: ${message}` });
  }
  await cleanupPreparedGarminDumpImport(checkpoint.tempDirectories);
  const result: GarminDumpImportResult = {
    provider: "garmin-dump",
    batchId: checkpoint.batchId,
    totalFitFiles: checkpoint.totalFitFiles,
    recordsSynced: checkpoint.baseResult.recordsSynced + fitResult.recordsSynced,
    errors: boundedGarminImportErrors(checkpoint.baseResult.errors, fitResult.errors),
    duration: Date.now() - checkpoint.startedAtMs,
  };
  await logGarminImportPhase(
    job,
    `[phase] Finalized Garmin dump batch ${checkpoint.batchId}: ${result.recordsSynced} activities, ${result.errors.length} error groups`,
  );
  // Report one event per unique error cause from the finalized result so
  // operators can observe failures without flooding telemetry per file.
  for (const error of result.errors) {
    captureException(
      new Error(`Garmin dump import batch ${checkpoint.batchId}: ${error.message}`),
      { tags: { garminDumpStep: "import-summary" } },
    );
  }
  return result;
}
