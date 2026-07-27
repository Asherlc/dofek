import { resolve, sep } from "node:path";
import { z } from "zod";
import { buildExportObjectKey } from "../export-storage.ts";

const JOB_STATES = [
  "active",
  "completed",
  "delayed",
  "failed",
  "paused",
  "prioritized",
  "wait",
  "waiting",
  "waiting-children",
] as const;
const JOB_SCAN_PAGE_SIZE = 100;
const JOB_DISCOVERY_PASS_LIMIT = 10;

interface ErasureJob {
  data: unknown;
  getState(): Promise<string>;
  id?: string;
  remove(options: { removeChildren: boolean }): Promise<void>;
}

export interface ErasureQueue {
  getJobs(
    states: readonly string[],
    start: number,
    end: number,
    ascending: boolean,
  ): Promise<ErasureJob[]>;
  name: string;
}

export interface AccountWorkIdentifiers {
  exportObjects: readonly {
    exportId: string;
    objectKey: string | null;
  }[];
  fileUploads: readonly {
    importJobId: string | null;
    multipartUploadId: string | null;
    objectKey: string;
    uploadId: string;
  }[];
  userId: string;
}

export interface AccountWorkDependencies {
  abortImportMultipart(objectKey: string, multipartUploadId: string): Promise<void>;
  deleteExportObject(objectKey: string): Promise<void>;
  deleteImportObject(objectKey: string): Promise<void>;
  jobFilesDirectory: string;
  purgeRedis(userId: string, bullmqJobIds: readonly string[]): Promise<void>;
  queues: readonly ErasureQueue[];
  removeLocalPath(path: string): Promise<void>;
}

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

function belongsToUser(data: JsonValue, userId: string): boolean {
  if (Array.isArray(data)) {
    return data.some((item) => belongsToUser(item, userId));
  }
  if (data === null || typeof data !== "object") return false;
  if (data.userId === userId) return true;
  return Object.values(data).some((value) => belongsToUser(value, userId));
}

function collectJobPaths(value: JsonValue, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJobPaths(item, paths);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      (key === "archivePath" ||
        key === "filePath" ||
        key === "originalPath" ||
        key === "outputDirectory") &&
      typeof nestedValue === "string"
    ) {
      paths.add(nestedValue);
    } else {
      collectJobPaths(nestedValue, paths);
    }
  }
}

function assertPathWithinDirectory(path: string, directory: string): string {
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(path);
  if (
    resolvedPath !== resolvedDirectory &&
    !resolvedPath.startsWith(`${resolvedDirectory}${sep}`)
  ) {
    throw new Error("Account erasure refused job path outside JOB_FILES_DIR");
  }
  return resolvedPath;
}

export async function purgeAccountWork(
  identifiers: AccountWorkIdentifiers,
  dependencies: AccountWorkDependencies,
): Promise<void> {
  const jobPaths = new Set<string>();
  const bullmqJobIds = new Set<string>();
  const removedJobs = new WeakSet<ErasureJob>();
  for (let discoveryPass = 1; discoveryPass <= JOB_DISCOVERY_PASS_LIMIT; discoveryPass += 1) {
    const attributableJobs: ErasureJob[] = [];
    for (const queue of dependencies.queues) {
      let start = 0;
      while (true) {
        const jobs = await queue.getJobs(JOB_STATES, start, start + JOB_SCAN_PAGE_SIZE - 1, true);
        for (const job of jobs) {
          if (removedJobs.has(job)) continue;
          const parsedData = jsonValueSchema.safeParse(job.data);
          if (!parsedData.success) {
            throw new Error(
              `Account erasure cannot prove ownership of malformed BullMQ job data in ${queue.name}`,
            );
          }
          if (!belongsToUser(parsedData.data, identifiers.userId)) continue;
          if ((await job.getState()) === "active") {
            throw new Error(
              `Account erasure is waiting for an active account job in ${queue.name}`,
            );
          }
          attributableJobs.push(job);
          if (job.id) bullmqJobIds.add(job.id);
          collectJobPaths(parsedData.data, jobPaths);
        }
        if (jobs.length < JOB_SCAN_PAGE_SIZE) break;
        start += jobs.length;
      }
    }

    if (attributableJobs.length === 0) break;
    for (const job of attributableJobs) {
      await job.remove({ removeChildren: true });
      removedJobs.add(job);
    }
    if (discoveryPass === JOB_DISCOVERY_PASS_LIMIT) {
      throw new Error(
        "Account erasure BullMQ state continued changing after the bounded cleanup passes",
      );
    }
  }
  await dependencies.purgeRedis(identifiers.userId, [...bullmqJobIds]);

  for (const upload of identifiers.fileUploads) {
    if (upload.multipartUploadId) {
      await dependencies.abortImportMultipart(upload.objectKey, upload.multipartUploadId);
    }
    await dependencies.deleteImportObject(upload.objectKey);
    jobPaths.add(resolve(dependencies.jobFilesDirectory, `file-upload-${upload.uploadId}`));
  }
  for (const exported of identifiers.exportObjects) {
    await dependencies.deleteExportObject(
      exported.objectKey ?? buildExportObjectKey(identifiers.userId, exported.exportId),
    );
    jobPaths.add(resolve(dependencies.jobFilesDirectory, `dofek-export-${exported.exportId}.zip`));
  }
  for (const path of jobPaths) {
    await dependencies.removeLocalPath(
      assertPathWithinDirectory(path, dependencies.jobFilesDirectory),
    );
  }
}
