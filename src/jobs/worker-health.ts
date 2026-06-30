import * as Sentry from "@sentry/node";
import {
  createActivityDeleteAnalyticsQueue,
  createExportQueue,
  createImportQueue,
  createPostSyncQueue,
  createScheduledSyncQueue,
  createSyncQueue,
} from "./queues.ts";

interface HealthQueue {
  waitUntilReady(): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface WorkerQueueHealthResult {
  status: "ok";
  queues: "ok";
}

function createWorkerHealthQueues(): HealthQueue[] {
  return [
    createSyncQueue(),
    createImportQueue(),
    createExportQueue(),
    createScheduledSyncQueue(),
    createPostSyncQueue(),
    createActivityDeleteAnalyticsQueue(),
  ];
}

function initWorkerHealthSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }
}

function firstRejectedReason(results: PromiseSettledResult<unknown>[]): unknown {
  return results.find((result) => result.status === "rejected")?.reason;
}

export async function checkWorkerQueues(): Promise<WorkerQueueHealthResult> {
  const queues = createWorkerHealthQueues();
  const checkResults = await Promise.allSettled(
    queues.map(async (queue) => {
      await queue.waitUntilReady();
      await queue.getJobCounts("waiting");
    }),
  );
  const closeResults = await Promise.allSettled(queues.map((queue) => queue.close()));

  const checkError = firstRejectedReason(checkResults);
  if (checkError) {
    throw checkError;
  }
  const closeError = firstRejectedReason(closeResults);
  if (closeError) {
    throw closeError;
  }

  return { status: "ok", queues: "ok" };
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectRun) {
  initWorkerHealthSentry();
  checkWorkerQueues()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch((error: unknown) => {
      Sentry.captureException(error);
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`worker healthcheck failed: ${message}\n`);
      process.exit(1);
    });
}
