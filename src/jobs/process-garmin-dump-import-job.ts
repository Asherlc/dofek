import * as Sentry from "@sentry/node";
import { WaitingChildrenError } from "bullmq";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { logger } from "../logger.ts";
import {
  cleanupPreparedGarminDumpImport,
  prepareGarminDumpImport,
} from "../providers/garmin-dump.ts";
import type { SyncResult } from "../providers/types.ts";
import { attachGarminFitImportFlow } from "./garmin-dump-flow.ts";
import type { ImportJobData } from "./queues.ts";

const importResultSchema = z.object({
  recordsSynced: z.number().int().nonnegative(),
  errors: z.array(z.object({ message: z.string() })),
});

const MAX_GARMIN_IMPORT_ERRORS = 10;

export const garminImportCheckpointSchema = z.object({
  version: z.literal(1),
  phase: z.enum(["prepared", "waiting-children"]),
  startedAtMs: z.number().int().nonnegative(),
  batchId: z.string().min(1),
  baseResult: importResultSchema,
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
  data: ImportJobData;
  updateData(data: ImportJobData): Promise<void>;
  moveToWaitingChildren(): Promise<boolean>;
  getChildrenValues(): Promise<Record<string, unknown>>;
  getIgnoredChildrenFailures(): Promise<Record<string, string>>;
  extendLock(durationMs: number): Promise<void>;
  updateProgress(data: object): Promise<void>;
  log(message: string): Promise<void>;
}

async function logGarminImportPhase(job: GarminDumpImportJob, message: string): Promise<void> {
  await job.log(message).catch((error: unknown) => {
    Sentry.captureException(error, { tags: { garminDumpStep: "job-log" } });
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
): z.infer<typeof importResultSchema> | null {
  const batchEntry = Object.entries(childValues).find(([jobKey]) =>
    jobKey.endsWith(`:${checkpoint.batchId}`),
  );
  return batchEntry ? importResultSchema.parse(batchEntry[1]) : null;
}

function batchFailureFromChildren(
  checkpoint: GarminImportCheckpoint,
  ignoredFailures: Record<string, string>,
): string | null {
  const batchEntry = Object.entries(ignoredFailures).find(([jobKey]) =>
    jobKey.endsWith(`:${checkpoint.batchId}`),
  );
  return batchEntry?.[1] ?? null;
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
    await attachGarminFitImportFlow(
      { ...preparedImport, tempDirectories },
      { id: job.id, queue: job.queueQualifiedName },
    );
    checkpoint = { ...checkpoint, phase: "waiting-children" };
    await persistCheckpoint(job, checkpoint);
    await logGarminImportPhase(
      job,
      `[phase] Attached Garmin FIT flow for batch ${checkpoint.batchId}`,
    );
  }

  if (await job.moveToWaitingChildren()) {
    await logGarminImportPhase(
      job,
      `[phase] Waiting for ${checkpoint.totalFitFiles} Garmin FIT ${checkpoint.totalFitFiles === 1 ? "file" : "files"} in batch ${checkpoint.batchId}`,
    );
    throw new WaitingChildrenError();
  }

  const [childValues, ignoredFailures] = await Promise.all([
    job.getChildrenValues(),
    job.getIgnoredChildrenFailures(),
  ]);
  const batchResult = batchResultFromChildren(checkpoint, childValues);
  const batchFailure = batchFailureFromChildren(checkpoint, ignoredFailures);
  if (!batchResult && !batchFailure) {
    throw new Error(`Garmin FIT batch result is missing: ${checkpoint.batchId}`);
  }

  const fitResult = batchResult ?? {
    recordsSynced: 0,
    errors: [{ message: `Garmin FIT batch failed: ${batchFailure}` }],
  };
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
  return result;
}
