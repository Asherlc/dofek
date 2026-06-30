import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

export interface WorkerQueueHealthOptions {
  timeoutMs?: number;
  requireWorkerProcess?: boolean;
  processArgumentsProvider?: () => Promise<string[]>;
}

export interface WorkerQueueHealthResult {
  status: "ok";
  queues: "ok";
}

const execFileAsync = promisify(execFile);
const DEFAULT_QUEUE_CHECK_TIMEOUT_MS = 2_500;
const WORKER_PROCESS_COMMAND = "src/jobs/worker.ts";

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

async function defaultProcessArgumentsProvider(): Promise<string[]> {
  if (process.env.WORKER_HEALTH_PROCESS_ARGS) {
    return process.env.WORKER_HEALTH_PROCESS_ARGS.split("\n")
      .map((processArguments) => processArguments.trim())
      .filter((processArguments) => processArguments.length > 0);
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "args="], { encoding: "utf8" });
  return String(stdout)
    .split("\n")
    .map((processArguments) => processArguments.trim())
    .filter((processArguments) => processArguments.length > 0);
}

async function checkWorkerProcessRunning(
  processArgumentsProvider: () => Promise<string[]>,
): Promise<void> {
  const processArguments = await processArgumentsProvider();
  const workerProcessRunning = processArguments.some((processCommand) =>
    processCommand.includes(WORKER_PROCESS_COMMAND),
  );
  if (!workerProcessRunning) {
    throw new Error("worker process is not running");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export async function checkWorkerQueues(
  options: WorkerQueueHealthOptions = {},
): Promise<WorkerQueueHealthResult> {
  if (options.requireWorkerProcess) {
    await checkWorkerProcessRunning(
      options.processArgumentsProvider ?? defaultProcessArgumentsProvider,
    );
  }

  const queues = createWorkerHealthQueues();
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUEUE_CHECK_TIMEOUT_MS;
  let checkError: unknown;
  try {
    const checkResults = await withTimeout(
      Promise.allSettled(
        queues.map(async (queue) => {
          await queue.waitUntilReady();
          await queue.getJobCounts("waiting");
        }),
      ),
      timeoutMs,
      "worker queue readiness timed out",
    );
    checkError = firstRejectedReason(checkResults);
  } catch (error: unknown) {
    checkError = error;
  }

  const closeResults = await Promise.allSettled(queues.map((queue) => queue.close()));

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
  checkWorkerQueues({ requireWorkerProcess: true })
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
