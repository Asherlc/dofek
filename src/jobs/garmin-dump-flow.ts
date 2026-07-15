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
