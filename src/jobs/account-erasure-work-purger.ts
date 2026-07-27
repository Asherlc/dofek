import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import type { JobType, Queue } from "bullmq";
import { purgeAccountRedisStateForSnapshot } from "../account-erasure/redis-erasure-runtime.ts";
import { type ErasureQueue, purgeAccountWork } from "../account-erasure/work-erasure.ts";
import { R2ImportUploadStorage } from "../file-upload-storage.ts";
import { createR2Client, requiredR2EnvironmentVariable } from "../r2-storage.ts";
import type { AccountErasureWorkPurger } from "./account-erasure-runtime.ts";
import { getConfiguredProviderIds } from "./provider-queue-config.ts";
import {
  createActivityDeleteAnalyticsQueue,
  createExportQueue,
  createFitFileImportBatchQueue,
  createFitFileImportQueue,
  createImportQueue,
  createPostSyncQueue,
  createProviderDataDeletionQueue,
  createProviderSyncQueue,
  createScheduledSyncQueue,
  createSyncQueue,
  createZipEntryExtractQueue,
  getRedisConnection,
} from "./queues.ts";

interface OwnedErasureQueue {
  close(): Promise<void>;
  erasureQueue: ErasureQueue;
}

function parseJobType(state: string): JobType {
  switch (state) {
    case "active":
    case "completed":
    case "delayed":
    case "failed":
    case "paused":
    case "prioritized":
    case "repeat":
    case "wait":
    case "waiting":
    case "waiting-children":
      return state;
    default:
      throw new Error(`Account erasure received an unsupported BullMQ job state: ${state}`);
  }
}

function ownErasureQueue<DataType, ResultType, NameType extends string>(
  queue: Queue<DataType, ResultType, NameType>,
): OwnedErasureQueue {
  return {
    close: () => queue.close(),
    erasureQueue: {
      getJobs: async (states, start, end, ascending) => {
        const jobs = await queue.getJobs(states.map(parseJobType), start, end, ascending);
        return jobs.map((job) => ({
          data: job.data,
          getState: () => job.getState(),
          id: job.id,
          remove: (options: { removeChildren: boolean }) => job.remove(options),
        }));
      },
      name: queue.name,
    },
  };
}

async function abortImportMultipartIdempotently(
  storage: R2ImportUploadStorage,
  objectKey: string,
  multipartUploadId: string,
): Promise<void> {
  try {
    await storage.abortMultipartUpload(objectKey, multipartUploadId);
  } catch (error: unknown) {
    if (
      error instanceof S3ServiceException &&
      error.name === "NoSuchUpload" &&
      error.$metadata.httpStatusCode === 404
    ) {
      return;
    }
    throw error;
  }
}

export function createAccountErasureWorkPurgerFromEnv(): AccountErasureWorkPurger {
  const connection = getRedisConnection();
  const ownedQueues: OwnedErasureQueue[] = [];
  const addQueue = <DataType, ResultType, NameType extends string>(
    queue: Queue<DataType, ResultType, NameType>,
  ): void => {
    ownedQueues.push(ownErasureQueue(queue));
  };

  addQueue(createSyncQueue(connection));
  for (const providerId of getConfiguredProviderIds()) {
    addQueue(createProviderSyncQueue(providerId, connection));
  }
  addQueue(createImportQueue(connection));
  addQueue(createFitFileImportQueue(connection));
  addQueue(createFitFileImportBatchQueue(connection));
  addQueue(createZipEntryExtractQueue(connection));
  addQueue(createExportQueue(connection));
  addQueue(createScheduledSyncQueue(connection));
  addQueue(createPostSyncQueue(connection));
  addQueue(createActivityDeleteAnalyticsQueue(connection));
  addQueue(createProviderDataDeletionQueue(connection));

  const r2Client = createR2Client();
  const importStorage = new R2ImportUploadStorage(
    r2Client,
    requiredR2EnvironmentVariable("IMPORT_R2_BUCKET"),
  );
  const exportBucket = requiredR2EnvironmentVariable("EXPORT_R2_BUCKET");
  const jobFilesDirectory = process.env.JOB_FILES_DIR ?? join(tmpdir(), "dofek-job-files");

  return {
    async close(): Promise<void> {
      try {
        await Promise.all(ownedQueues.map((queue) => queue.close()));
      } finally {
        r2Client.destroy();
      }
    },
    purge: (snapshot) =>
      purgeAccountWork(
        {
          exportObjects: snapshot.localIdentifiers.exportObjects,
          fileUploads: snapshot.localIdentifiers.fileUploads,
          userId: snapshot.localIdentifiers.userId,
        },
        {
          abortImportMultipart: (objectKey, multipartUploadId) =>
            abortImportMultipartIdempotently(importStorage, objectKey, multipartUploadId),
          deleteExportObject: async (objectKey) => {
            await r2Client.send(
              new DeleteObjectCommand({
                Bucket: exportBucket,
                Key: objectKey,
              }),
            );
          },
          deleteImportObject: (objectKey) => importStorage.deleteObject(objectKey),
          jobFilesDirectory,
          purgeRedis: async (_userId, bullmqJobIds) => {
            await purgeAccountRedisStateForSnapshot(snapshot, bullmqJobIds);
          },
          queues: ownedQueues.map((queue) => queue.erasureQueue),
          removeLocalPath: (path) => rm(path, { force: true, recursive: true }),
        },
      ),
  };
}
