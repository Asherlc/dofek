import { createHash } from "node:crypto";
import type { FlowChildJob } from "bullmq";
import {
  FIT_FILE_IMPORT_BATCH_QUEUE,
  FIT_FILE_IMPORT_QUEUE,
  type FitFileImportJobData,
  getFlowProducer,
  ZIP_ENTRY_EXTRACT_QUEUE,
} from "./queues.ts";

const FIT_FILE_IMPORT_JOB_NAME = "fit-file-import";
const FIT_FILE_IMPORT_BATCH_JOB_NAME = "fit-file-import-batch";
const ZIP_ENTRY_EXTRACT_JOB_NAME = "zip-entry-extract";
export const MAX_GARMIN_DUMP_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_GARMIN_DUMP_NESTED_ZIP_BYTES = 1024 * 1024 * 1024;

export type GarminDumpFlowEntry =
  | {
      path: string;
      filePath: string;
      archivePath?: string;
      entryPath?: string[];
      outputDirectory?: string;
    }
  | {
      path: string;
      filePath?: never;
      archivePath: string;
      entryPath: string[];
      outputDirectory: string;
    };

export interface GarminFitJobEntry {
  entry: GarminDumpFlowEntry;
  data: Omit<FitFileImportJobData, "filePath">;
}

export interface PreparedGarminDumpImport {
  uploadPath: string;
  userId: string;
  batchId: string;
  baseResult: {
    recordsSynced: number;
    errors: Array<{ message: string }>;
  };
  fitJobEntries: GarminFitJobEntry[];
  tempDirectories: string[];
  totalFitFiles: number;
}

export interface GarminImportParent {
  id: string;
  queue: string;
}

export function createGarminFitBatchId(
  uploadPath: string,
  userId: string,
  fitJobEntries: readonly GarminFitJobEntry[],
): string {
  return `garmin-dump-fit-batch-${createHash("sha256")
    .update(`${userId}\n${uploadPath}\n${fitJobEntries.map(({ entry }) => entry.path).join("\n")}`)
    .digest("hex")}`;
}

function stableFitJobHash(preparedImport: PreparedGarminDumpImport, entryPath: string): string {
  return createHash("sha256")
    .update(`${preparedImport.userId}\n${preparedImport.uploadPath}\n${entryPath}`)
    .digest("hex");
}

function fitFileImportFlowChild(
  preparedImport: PreparedGarminDumpImport,
  fitJobEntry: GarminFitJobEntry,
): FlowChildJob {
  const { data, entry } = fitJobEntry;
  const jobHash = stableFitJobHash(preparedImport, entry.path);
  const fitImportData: FitFileImportJobData = entry.filePath
    ? { ...data, filePath: entry.filePath }
    : data;
  const children = entry.filePath
    ? undefined
    : [
        {
          name: ZIP_ENTRY_EXTRACT_JOB_NAME,
          queueName: ZIP_ENTRY_EXTRACT_QUEUE,
          data: {
            archivePath: entry.archivePath,
            entryPath: entry.entryPath,
            outputDirectory: entry.outputDirectory,
            outputExtension: "fit",
            maxBytes: MAX_GARMIN_DUMP_ENTRY_BYTES,
            nestedArchiveMaxBytes: MAX_GARMIN_DUMP_NESTED_ZIP_BYTES,
          },
          opts: {
            jobId: `garmin-dump-fit-extract-${jobHash}`,
            ignoreDependencyOnFailure: true,
            removeOnComplete: { age: 86_400 },
            removeOnFail: { age: 604_800 },
          },
        },
      ];

  return {
    name: FIT_FILE_IMPORT_JOB_NAME,
    queueName: FIT_FILE_IMPORT_QUEUE,
    data: fitImportData,
    opts: {
      jobId: `garmin-dump-fit-${jobHash}`,
      ignoreDependencyOnFailure: true,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
    ...(children ? { children } : {}),
  };
}

async function addGarminFitImportFlow(
  preparedImport: PreparedGarminDumpImport,
  parent?: GarminImportParent,
) {
  return getFlowProducer().add({
    name: FIT_FILE_IMPORT_BATCH_JOB_NAME,
    queueName: FIT_FILE_IMPORT_BATCH_QUEUE,
    data: { type: "fit-file-import-batch" },
    opts: {
      jobId: preparedImport.batchId,
      ...(parent ? { parent } : {}),
      ignoreDependencyOnFailure: true,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
    children: preparedImport.fitJobEntries.map((fitJobEntry) =>
      fitFileImportFlowChild(preparedImport, fitJobEntry),
    ),
  });
}

export async function attachGarminFitImportFlow(
  preparedImport: PreparedGarminDumpImport,
  parent: GarminImportParent,
): Promise<void> {
  await addGarminFitImportFlow(preparedImport, parent);
}
