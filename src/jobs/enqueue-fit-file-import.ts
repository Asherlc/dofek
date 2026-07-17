import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncDatabase } from "../db/index.ts";
import { getTokenUserId } from "../db/token-user-context.ts";
import type { MetricStreamEventPublisher } from "../metric-stream/redpanda-producer.ts";
import { processFitFileImportJob } from "./process-fit-file-import-job.ts";
import {
  type FitFileImportActivitySummary,
  type FitFileImportJobResult,
  fitFileImportJobResultSchema,
  getFitFileImportQueue,
  getFitFileImportQueueEvents,
} from "./queues.ts";

interface EnqueueFitFileImportOptions {
  fitBuffer: Buffer;
  providerId: string;
  sourceName: string;
  userId?: string;
  activitySummary: FitFileImportActivitySummary;
  db?: SyncDatabase;
  metricStreamPublisher?: MetricStreamEventPublisher;
}

function fitJobFilesDirectory(): string {
  return process.env.JOB_FILES_DIR ?? join(tmpdir(), "dofek-job-files");
}

function requiredUserId(userId: string | undefined): string {
  const resolvedUserId = userId ?? getTokenUserId();
  if (!resolvedUserId) {
    throw new Error("FIT file import requires userId");
  }
  return resolvedUserId;
}

function logicalFitPath(providerId: string, externalId: string): string {
  const safeExternalId = externalId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${providerId}_${safeExternalId}.fit`;
}

export async function enqueueFitFileImportAndWait(
  options: EnqueueFitFileImportOptions,
): Promise<FitFileImportJobResult> {
  const jobFilesDirectory = fitJobFilesDirectory();
  await mkdir(jobFilesDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(jobFilesDirectory, "provider-fit-"));
  const filePath = join(stagingDirectory, "input.fit");

  try {
    await writeFile(filePath, options.fitBuffer);
    const data = {
      filePath,
      originalPath: logicalFitPath(options.providerId, options.activitySummary.externalId),
      userId: requiredUserId(options.userId),
      providerId: options.providerId,
      sourceName: options.sourceName,
      activitySummary: options.activitySummary,
    };
    if (options.metricStreamPublisher) {
      if (!options.db) {
        throw new Error("In-process FIT file import requires db");
      }
      return await processFitFileImportJob(
        { data, updateProgress: async () => undefined },
        options.db,
        options.metricStreamPublisher,
      );
    }
    const job = await getFitFileImportQueue().add(
      "fit-file-import",
      {
        ...data,
        deleteFileAfterImport: true,
      },
      {
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );
    const result = await job.waitUntilFinished(getFitFileImportQueueEvents());
    return fitFileImportJobResultSchema.parse(result);
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
