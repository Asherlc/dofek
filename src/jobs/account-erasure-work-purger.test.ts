import { S3ServiceException } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import type { AccountErasureRemoteSnapshot } from "../account-erasure/remote-snapshot.ts";

const mocks = vi.hoisted(() => {
  const closeByQueue = new Map<string, CallableVitestMock>();
  const queuesByName = new Map<
    string,
    {
      close: CallableVitestMock;
      getJobs: CallableVitestMock;
      name: string;
    }
  >();
  const queue = (name: string) => {
    const close = vi.fn(async () => undefined);
    const value = {
      close,
      getJobs: vi.fn(async () => []),
      name,
    };
    closeByQueue.set(name, close);
    queuesByName.set(name, value);
    return value;
  };

  return {
    abortImportMultipart: vi.fn(async () => undefined),
    closeByQueue,
    createActivityQueue: vi.fn(() => queue("activity-delete-analytics")),
    createExportQueue: vi.fn(() => queue("export")),
    createFitBatchQueue: vi.fn(() => queue("fit-file-import-batch")),
    createFitQueue: vi.fn(() => queue("fit-file-import")),
    createImportQueue: vi.fn(() => queue("import")),
    createPostSyncQueue: vi.fn(() => queue("post-sync")),
    createProviderDeletionQueue: vi.fn(() => queue("provider-data-deletion")),
    createProviderQueue: vi.fn((providerId: string) => queue(`sync-${providerId}`)),
    createScheduledQueue: vi.fn(() => queue("scheduled-sync")),
    createSyncQueue: vi.fn(() => queue("sync")),
    createZipQueue: vi.fn(() => queue("zip-entry-extract")),
    deleteImportObject: vi.fn(async () => undefined),
    queuesByName,
    purgeAccountRedisStateForSnapshot: vi.fn(async () => ({
      aofPersisted: true,
      deletedKeys: 4,
      deletedStreamEntries: 2,
      rdbPersisted: true,
      removedSetMembers: 1,
      scanPasses: 2,
    })),
    purgeAccountWork: vi.fn<typeof import("../account-erasure/work-erasure.ts").purgeAccountWork>(
      async () => undefined,
    ),
    removeLocalPath: vi.fn(async () => undefined),
    r2Client: {
      destroy: vi.fn(),
      send: vi.fn(async () => ({})),
    },
  };
});

vi.mock("node:fs/promises", () => ({
  rm: mocks.removeLocalPath,
}));

vi.mock("node:os", () => ({
  tmpdir: () => "/tmp",
}));

vi.mock("../account-erasure/redis-erasure-runtime.ts", () => ({
  purgeAccountRedisStateForSnapshot: mocks.purgeAccountRedisStateForSnapshot,
}));

vi.mock("../account-erasure/work-erasure.ts", () => ({
  purgeAccountWork: mocks.purgeAccountWork,
}));

vi.mock("../file-upload-storage.ts", () => ({
  R2ImportUploadStorage: class {
    abortMultipartUpload = mocks.abortImportMultipart;
    deleteObject = mocks.deleteImportObject;
  },
}));

vi.mock("../r2-storage.ts", () => ({
  createR2Client: vi.fn(() => mocks.r2Client),
  requiredR2EnvironmentVariable: vi.fn((name: string) => `${name.toLowerCase()}-bucket`),
}));

vi.mock("./provider-queue-config.ts", () => ({
  getConfiguredProviderIds: vi.fn(() => ["strava", "garmin"]),
}));

vi.mock("./queues.ts", () => ({
  createActivityDeleteAnalyticsQueue: mocks.createActivityQueue,
  createExportQueue: mocks.createExportQueue,
  createFitFileImportBatchQueue: mocks.createFitBatchQueue,
  createFitFileImportQueue: mocks.createFitQueue,
  createImportQueue: mocks.createImportQueue,
  createPostSyncQueue: mocks.createPostSyncQueue,
  createProviderDataDeletionQueue: mocks.createProviderDeletionQueue,
  createProviderSyncQueue: mocks.createProviderQueue,
  createScheduledSyncQueue: mocks.createScheduledQueue,
  createSyncQueue: mocks.createSyncQueue,
  createZipEntryExtractQueue: mocks.createZipQueue,
  getRedisConnection: vi.fn(() => ({ host: "redis" })),
}));

import { createAccountErasureWorkPurgerFromEnv } from "./account-erasure-work-purger.ts";

const snapshot: AccountErasureRemoteSnapshot = {
  appleCredentials: [],
  authIdentities: [],
  externalEffects: [],
  localIdentifiers: {
    activityIds: [],
    exportObjects: [
      {
        exportId: "10000000-0000-4000-8000-000000001994",
        objectKey: "exports/user/export/archive.zip",
      },
    ],
    fileUploads: [
      {
        importJobId: "20000000-0000-4000-8000-000000001994",
        multipartUploadId: "multipart-1994",
        objectKey: "imports/user/upload",
        uploadId: "30000000-0000-4000-8000-000000001994",
      },
    ],
    processingOperationIds: [],
    sessionIds: [],
    sleepSessionIds: [],
    userId: "40000000-0000-4000-8000-000000001994",
  },
  posthogDistinctId: "posthog-distinct-1994",
  processorEmails: [],
  providerConnections: [],
  stripe: null,
  webhooks: [],
};

describe("createAccountErasureWorkPurgerFromEnv", () => {
  it("purges every non-coordinator queue plus attributable objects and files", async () => {
    const purger = createAccountErasureWorkPurgerFromEnv();

    await purger.purge(snapshot);

    expect(mocks.purgeAccountWork).toHaveBeenCalledWith(
      {
        exportObjects: snapshot.localIdentifiers.exportObjects,
        fileUploads: snapshot.localIdentifiers.fileUploads,
        userId: snapshot.localIdentifiers.userId,
      },
      expect.objectContaining({
        jobFilesDirectory: "/tmp/dofek-job-files",
      }),
    );
    const dependencies = mocks.purgeAccountWork.mock.calls[0]?.[1];
    if (!dependencies) throw new Error("Work erasure dependencies were not passed");
    expect(dependencies.queues.map((queue) => queue.name)).toEqual([
      "sync",
      "sync-strava",
      "sync-garmin",
      "import",
      "fit-file-import",
      "fit-file-import-batch",
      "zip-entry-extract",
      "export",
      "scheduled-sync",
      "post-sync",
      "activity-delete-analytics",
      "provider-data-deletion",
    ]);
    expect(dependencies.queues.map((queue) => queue.name)).not.toContain("account-erasure");
    const rawQueue = mocks.queuesByName.get("sync");
    if (!rawQueue) throw new Error("Legacy sync queue was not created");
    const removeJob = vi.fn(async () => undefined);
    rawQueue.getJobs.mockResolvedValueOnce([
      {
        data: { userId: snapshot.localIdentifiers.userId },
        getState: vi.fn(async () => "waiting"),
        id: "bullmq-job-1994",
        remove: removeJob,
      },
    ]);
    const discoveredJobs = await dependencies.queues[0]?.getJobs(["waiting"], 0, 99, true);
    expect(discoveredJobs?.[0]?.id).toBe("bullmq-job-1994");
    await discoveredJobs?.[0]?.remove({ removeChildren: true });
    expect(removeJob).toHaveBeenCalledWith({ removeChildren: true });

    await dependencies.purgeRedis(snapshot.localIdentifiers.userId, ["bullmq-job-1994"]);
    await dependencies.abortImportMultipart("imports/user/upload", "multipart-1994");
    await dependencies.deleteImportObject("imports/user/upload");
    await dependencies.deleteExportObject("exports/user/export/archive.zip");
    await dependencies.removeLocalPath("/tmp/dofek-job-files/work");

    expect(mocks.purgeAccountRedisStateForSnapshot).toHaveBeenCalledWith(snapshot, [
      "bullmq-job-1994",
    ]);
    expect(mocks.removeLocalPath).toHaveBeenCalledWith("/tmp/dofek-job-files/work", {
      force: true,
      recursive: true,
    });
    expect(mocks.r2Client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          Bucket: "export_r2_bucket-bucket",
          Key: "exports/user/export/archive.zip",
        },
      }),
    );
  });

  it("closes every owned queue and the R2 client", async () => {
    const purger = createAccountErasureWorkPurgerFromEnv();

    await purger.close();

    expect(mocks.closeByQueue).toHaveLength(12);
    for (const close of mocks.closeByQueue.values()) {
      expect(close).toHaveBeenCalledOnce();
    }
    expect(mocks.r2Client.destroy).toHaveBeenCalledOnce();
  });

  it("rejects unsupported BullMQ states instead of silently skipping them", async () => {
    const purger = createAccountErasureWorkPurgerFromEnv();
    await purger.purge(snapshot);
    const dependencies = mocks.purgeAccountWork.mock.calls.at(-1)?.[1];
    if (!dependencies) throw new Error("Work erasure dependencies were not passed");

    await expect(dependencies.queues[0]?.getJobs(["unsupported"], 0, 99, true)).rejects.toThrow(
      "unsupported BullMQ job state: unsupported",
    );
  });

  it("uses the configured local work directory", async () => {
    process.env.JOB_FILES_DIR = "/var/lib/dofek-job-files";
    const purger = createAccountErasureWorkPurgerFromEnv();

    await purger.purge(snapshot);

    expect(mocks.purgeAccountWork.mock.calls.at(-1)?.[1]).toEqual(
      expect.objectContaining({ jobFilesDirectory: "/var/lib/dofek-job-files" }),
    );
    delete process.env.JOB_FILES_DIR;
  });

  it("destroys the R2 client even when queue shutdown fails", async () => {
    const purger = createAccountErasureWorkPurgerFromEnv();
    const queueClose = mocks.closeByQueue.get("sync");
    if (!queueClose) throw new Error("Sync queue was not created");
    const error = new Error("queue shutdown failed");
    queueClose.mockRejectedValueOnce(error);

    await expect(purger.close()).rejects.toBe(error);
    expect(mocks.r2Client.destroy).toHaveBeenCalled();
  });

  it("converges when a previously aborted multipart upload is already absent", async () => {
    const purger = createAccountErasureWorkPurgerFromEnv();
    await purger.purge(snapshot);
    const dependencies = mocks.purgeAccountWork.mock.calls.at(-1)?.[1];
    if (!dependencies) throw new Error("Work erasure dependencies were not passed");
    mocks.abortImportMultipart.mockRejectedValueOnce(
      new S3ServiceException({
        $fault: "client",
        $metadata: { httpStatusCode: 404 },
        name: "NoSuchUpload",
      }),
    );

    await expect(
      dependencies.abortImportMultipart("imports/user/upload", "multipart-1994"),
    ).resolves.toBeUndefined();
  });

  it("fails loudly for unexpected multipart abort errors", async () => {
    const purger = createAccountErasureWorkPurgerFromEnv();
    await purger.purge(snapshot);
    const dependencies = mocks.purgeAccountWork.mock.calls.at(-1)?.[1];
    if (!dependencies) throw new Error("Work erasure dependencies were not passed");
    const storageError = new S3ServiceException({
      $fault: "server",
      $metadata: { httpStatusCode: 503 },
      name: "ServiceUnavailable",
    });
    mocks.abortImportMultipart.mockRejectedValueOnce(storageError);

    await expect(
      dependencies.abortImportMultipart("imports/user/upload", "multipart-1994"),
    ).rejects.toBe(storageError);
  });

  it("does not treat a 404 from a different error as an absent multipart upload", async () => {
    const purger = createAccountErasureWorkPurgerFromEnv();
    await purger.purge(snapshot);
    const dependencies = mocks.purgeAccountWork.mock.calls.at(-1)?.[1];
    if (!dependencies) throw new Error("Work erasure dependencies were not passed");
    const error = { $metadata: { httpStatusCode: 404 }, name: "NoSuchUpload" };
    mocks.abortImportMultipart.mockRejectedValueOnce(error);

    await expect(
      dependencies.abortImportMultipart("imports/user/upload", "multipart-1994"),
    ).rejects.toBe(error);
  });

  it("does not treat a NoSuchUpload with a non-404 status as absent", async () => {
    const purger = createAccountErasureWorkPurgerFromEnv();
    await purger.purge(snapshot);
    const dependencies = mocks.purgeAccountWork.mock.calls.at(-1)?.[1];
    if (!dependencies) throw new Error("Work erasure dependencies were not passed");
    const error = new S3ServiceException({
      $fault: "client",
      $metadata: { httpStatusCode: 500 },
      name: "NoSuchUpload",
    });
    mocks.abortImportMultipart.mockRejectedValueOnce(error);

    await expect(
      dependencies.abortImportMultipart("imports/user/upload", "multipart-1994"),
    ).rejects.toBe(error);
  });
});
