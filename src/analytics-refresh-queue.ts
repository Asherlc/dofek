import type { ConnectionOptions } from "bullmq";
import { type Queue, type QueueEvents, Worker } from "bullmq";
import {
  ANALYTICS_REFRESH_QUEUE,
  type AnalyticsRefreshJobData,
  getAnalyticsRefreshQueue,
  getAnalyticsRefreshQueueEvents,
  getAnalyticsRefreshWaitSignal,
} from "./jobs/queues.ts";

const refreshJobOptions = {
  deduplication: { id: ANALYTICS_REFRESH_QUEUE },
  // Retain finished handles so waitUntilFinished can observe completion that
  // raced ahead of waiter registration; use the existing bounded failure policy.
  removeOnComplete: { age: 604_800, count: 1_000 },
  removeOnFail: { age: 604_800, count: 1_000 },
};

export async function enqueueAnalyticsRefresh(
  queue: Pick<Queue<AnalyticsRefreshJobData>, "add">,
): Promise<void> {
  await queue.add(ANALYTICS_REFRESH_QUEUE, { type: "analytics-refresh" }, refreshJobOptions);
}

/** Await the queued refresh, including a deduplicated pending request. */
export async function enqueueAnalyticsRefreshAndWait(
  queue: Pick<Queue<AnalyticsRefreshJobData>, "add">,
  events: QueueEvents,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const completion = async () => {
    await events.waitUntilReady();
    signal.throwIfAborted();
    const job = await queue.add(
      ANALYTICS_REFRESH_QUEUE,
      { type: "analytics-refresh" },
      refreshJobOptions,
    );
    signal.throwIfAborted();
    await job.waitUntilFinished(events);
  };
  try {
    await Promise.race([completion(), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The application's one serialized analytics writer owns deletion refreshes too. */
export async function refreshAnalyticsAndWait(): Promise<void> {
  await enqueueAnalyticsRefreshAndWait(
    getAnalyticsRefreshQueue(),
    getAnalyticsRefreshQueueEvents(),
    getAnalyticsRefreshWaitSignal(),
  );
}

interface AnalyticsRefreshJobsInput {
  queue: Pick<
    Queue<AnalyticsRefreshJobData>,
    "name" | "add" | "setGlobalConcurrency" | "upsertJobScheduler"
  >;
  connection: ConnectionOptions;
  processRefresh(): Promise<void>;
  intervalMilliseconds: number;
  reportFailure(error: Error): void;
  signal: AbortSignal;
}

export async function runAnalyticsRefreshJobs({
  queue,
  connection,
  processRefresh,
  intervalMilliseconds,
  reportFailure,
  signal,
}: AnalyticsRefreshJobsInput): Promise<void> {
  if (signal.aborted) return;
  await queue.setGlobalConcurrency(1);
  await queue.upsertJobScheduler(
    "analytics-refresh-periodic",
    { every: intervalMilliseconds },
    {
      name: "analytics-refresh-periodic",
      data: { type: "analytics-refresh" },
      opts: { removeOnComplete: true, removeOnFail: { age: 604_800, count: 1_000 } },
    },
  );
  await enqueueAnalyticsRefresh(queue);

  const consumer = new Worker<AnalyticsRefreshJobData>(
    queue.name,
    async (job) => {
      if (job.name === "analytics-refresh-periodic") {
        await enqueueAnalyticsRefresh(queue);
        return;
      }
      // Release only this job's deduplication key so updates arriving during
      // the build can create one subsequent batch.
      await job.removeDeduplicationKey();
      await processRefresh();
    },
    { connection, concurrency: 1, autorun: false },
  );
  consumer.on("error", reportFailure);
  consumer.on("failed", (_job, error) => {
    if (signal.aborted && error.name === "AbortError") return;
    reportFailure(error);
  });
  let onAbort = () => {};
  const stopped = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) resolve();
  });
  try {
    await Promise.race([consumer.run(), stopped]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await consumer.close();
  }
}
