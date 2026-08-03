import { createHash } from "node:crypto";
import type { FlowChildJob } from "bullmq";
import type { GarminFitJobEntry, PreparedGarminDumpImport } from "../providers/garmin-dump.ts";
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

export const FLOW_BATCH_SIZE = 500;

export interface GarminImportParent {
  id: string;
  queue: string;
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
  let fitImportData: FitFileImportJobData = data;
  let children: FlowChildJob[] | undefined;
  if (entry.filePath === undefined) {
    children = [
      {
        name: ZIP_ENTRY_EXTRACT_JOB_NAME,
        queueName: ZIP_ENTRY_EXTRACT_QUEUE,
        data: {
          archivePath: entry.archivePath,
          entryPath: entry.entryPath,
          outputDirectory: entry.outputDirectory,
          outputExtension: "fit",
          maxBytes: entry.maxBytes,
          nestedArchiveMaxBytes: entry.nestedArchiveMaxBytes,
          userId: preparedImport.userId,
        },
        opts: {
          jobId: `garmin-dump-fit-extract-${jobHash}`,
          ignoreDependencyOnFailure: true,
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 604_800 },
        },
      },
    ];
  } else {
    fitImportData = { ...data, filePath: entry.filePath };
  }

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

async function addBatchFlow(
  batchId: string,
  entries: GarminFitJobEntry[],
  preparedImport: PreparedGarminDumpImport,
  parent?: GarminImportParent,
) {
  return getFlowProducer().add({
    name: FIT_FILE_IMPORT_BATCH_JOB_NAME,
    queueName: FIT_FILE_IMPORT_BATCH_QUEUE,
    data: { type: "fit-file-import-batch", userId: preparedImport.userId },
    opts: {
      jobId: batchId,
      ...(parent ? { parent } : {}),
      ignoreDependencyOnFailure: true,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 604_800 },
    },
    children: entries.map((fitJobEntry) => fitFileImportFlowChild(preparedImport, fitJobEntry)),
  });
}

export function createBatchId(
  preparedImport: PreparedGarminDumpImport,
  batchIndex: number,
): string {
  if (batchIndex === 0) {
    return preparedImport.batchId;
  }
  return `${preparedImport.batchId}-batch-${batchIndex}`;
}

export async function attachGarminFitImportFlow(
  preparedImport: PreparedGarminDumpImport,
  parent: GarminImportParent,
): Promise<void> {
  const allEntries = preparedImport.fitJobEntries;
  const batchCount = Math.ceil(allEntries.length / FLOW_BATCH_SIZE);

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const start = batchIndex * FLOW_BATCH_SIZE;
    const batchEntries = allEntries.slice(start, start + FLOW_BATCH_SIZE);
    const batchId = createBatchId(preparedImport, batchIndex);
    await addBatchFlow(batchId, batchEntries, preparedImport, parent);
  }
}
