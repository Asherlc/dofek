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
}

export interface WorkerQueueHealthResult {
  status: "ok";
  queues: "ok";
}

const DEFAULT_QUEUE_CHECK_TIMEOUT_MS = 2_500;

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

function firstRejectedReason(results: PromiseSettledResult<unknown>[]): unknown {
  return results.find((result) => result.status === "rejected")?.reason;
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
