import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import {
  ANALYTICS_REFRESH_QUEUE,
  type AnalyticsRefreshJobData,
  getRedisCommandConnection,
} from "./jobs/queues.ts";

export function createAnalyticsRefreshQueue(
  connection?: ConnectionOptions,
): Queue<AnalyticsRefreshJobData> {
  return new Queue(ANALYTICS_REFRESH_QUEUE, {
    connection: connection ?? getRedisCommandConnection(),
  });
}

export async function enqueueAnalyticsRefresh(
  queue: Pick<Queue<AnalyticsRefreshJobData>, "add">,
): Promise<void> {
  await queue.add(
    ANALYTICS_REFRESH_QUEUE,
    { type: "analytics-refresh" },
    {
      deduplication: { id: ANALYTICS_REFRESH_QUEUE },
      removeOnComplete: true,
      removeOnFail: { age: 604_800, count: 1_000 },
    },
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
  consumer.on("failed", (_job, error) => reportFailure(error));
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
