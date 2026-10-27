import { constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SyncDatabase } from "../db/index.ts";
import { getTokenUserId } from "../db/token-user-context.ts";
import type { MetricStreamEventPublisher } from "../metric-stream/redpanda-producer.ts";
import { createProviderArtifactStorageFromEnv } from "../provider-artifact-storage.ts";
import { processFitFileImportJob } from "./process-fit-file-import-job.ts";
import { deleteRetainedProviderFitSource, stageProviderFitFile } from "./provider-fit-staging.ts";
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
  const userId = requiredUserId(options.userId);
  const originalPath = logicalFitPath(options.providerId, options.activitySummary.externalId);
  const { directory: stagingDirectory, filePath } = await stageProviderFitFile({
    fitBuffer: options.fitBuffer,
    userId,
    providerId: options.providerId,
    filename: originalPath,
  });
  const data = {
    filePath,
    originalPath,
    userId,
    providerId: options.providerId,
    sourceName: options.sourceName,
    activitySummary: options.activitySummary,
    deleteFileAfterImport: true,
  };
  await writeFile(join(stagingDirectory, "import.json"), JSON.stringify(data), {
    flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
  });
  const artifacts = createProviderArtifactStorageFromEnv();
  const retainedArtifactKey = await artifacts.retainFile({
    userId,
    providerId: options.providerId,
    filePath,
  });
  const retainedData = { ...data, retainedArtifactKey };

  try {
    if (options.metricStreamPublisher) {
      if (!options.db) {
        throw new Error("In-process FIT file import requires db");
      }
      return await processFitFileImportJob(
        {
          data: retainedData,
          updateData: (nextData) =>
            writeFile(join(stagingDirectory, "import.json"), JSON.stringify(nextData), {
              flag:
                constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
            }),
          updateProgress: async () => undefined,
        },
        options.db,
        options.metricStreamPublisher,
        artifacts,
      );
    }
    const job = await getFitFileImportQueue().add(
      "fit-file-import",
      {
        ...retainedData,
      },
      {
        removeOnComplete: { age: 86_400 },
        removeOnFail: { age: 604_800 },
      },
    );
    const result = await job.waitUntilFinished(getFitFileImportQueueEvents());
    return fitFileImportJobResultSchema.parse(result);
  } finally {
    await deleteRetainedProviderFitSource(retainedData);
  }
}
