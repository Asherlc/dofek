import { setTimeout as sleep } from "node:timers/promises";
import type { ConnectionOptions, Processor, Queue } from "bullmq";
import { Worker } from "bullmq";
import { captureException } from "../lib/error-reporting.ts";
import type { createPortableSyncSlot } from "./portable-sync-slot.ts";
import { getProviderQueueConfig, type ProviderQueueConfig } from "./provider-queue-config.ts";
import { createProviderSyncQueue, type SyncJobData } from "./queues.ts";

/** Poll cadence after a full sweep finds no runnable work anywhere. */
const IDLE_POLL_INTERVAL_MS = 1_000;
/**
 * Cap how long one candidate holds a worker open while trying to claim.
 * Waiting/prioritized jobs and already-due delayed jobs are claimed on the
 * worker's first ticks; the cap stops a far-future delayed job from keeping the
 * blocking connection — and the whole round robin — hostage until it is due.
 */
const CLAIM_WINDOW_MS = 250;
/**
 * Bound how long a candidate waits on a limiter race: a queue can become
 * rate-limited between the count check and the worker's first claim. A small
 * ceiling keeps one candidate from stalling the round robin.
 */
const RATE_LIMIT_RACE_DELAY_MS = 250;

export interface RunPortableSyncQueuesInput {
  /** Provider IDs; the caller is responsible for validating/enabling them. */
  providerIds: readonly string[];
  connection: ConnectionOptions;
  processor: Processor<SyncJobData>;
  signal: AbortSignal;
  slot: ReturnType<typeof createPortableSyncSlot>;
  onReady: () => void;
}

/**
 * Decide whether a candidate justifies opening a short-lived worker. The
 * persistent Queue instances already hold their Redis connections, so this is
 * a single pipelined count rather than two new clients per candidate per sweep.
 *
 * `wait`/`prioritized` are immediately claimable. `delayed` is included because BullMQ's Worker is
 * what promotes a due delayed job into `wait` on its first ticks — without a
 * worker, a due delayed job would never leave the delayed set on this host.
 *
 * Stalled jobs are deliberately not a trigger: the Oracle worker that stays on
 * each eligible queue owns stalled recovery via `moveStalledJobsToWait()`. Our
 * short-lived workers pause and close cleanly, so they do not create stalls.
 */
async function hasRunnableWork(queue: Queue<SyncJobData>): Promise<boolean> {
  const counts = await queue.getJobCounts("wait", "prioritized", "delayed");
  return (counts.wait ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0) > 0;
}

/**
 * Run one single-job worker against a candidate queue and resolve once it has
 * either claimed/finished a job or given up. The worker claims at most one job
 * (concurrency 1 plus `pause(true)` at processor entry) and leaves job
 * completion, native retry, and lock handling to BullMQ.
 */
async function claimOne(
  queue: Queue<SyncJobData>,
  config: ProviderQueueConfig,
  connection: ConnectionOptions,
  processor: Processor<SyncJobData>,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;

  let claimed = false;
  let draining: Promise<void> | undefined;

  const worker = new Worker<SyncJobData>(
    queue.name,
    async (job, token, jobSignal) => {
      claimed = true;
      // Stop this worker from claiming another job. `true` skips waiting for
      // the active job (we are inside it) without altering BullMQ's lifecycle.
      await worker.pause(true);
      return processor(job, token, jobSignal);
    },
    {
      connection,
      autorun: false,
      concurrency: 1,
      maximumRateLimitDelay: RATE_LIMIT_RACE_DELAY_MS,
      ...(config.limiter ? { limiter: config.limiter } : {}),
    },
  );
  // Keep transient connection/Redis errors observable without letting them
  // become unhandled EventEmitter 'error' events. Job failures are reported by
  // the caller's processor and by BullMQ's own `failed` event.
  worker.on("error", (error) => {
    captureException(error, {
      tags: { source: "portable-sync-selector", queue: queue.name },
    });
  });

  // If another worker drains the queue first, close as soon as BullMQ reports
  // it rather than waiting out the claim window.
  worker.once("drained", () => {
    draining = worker.close();
  });
  const onAbort = () => {
    void worker.close();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const windowController = new AbortController();
  try {
    // `run()` resolves after the single claimed job finishes (`pause(true)`
    // empties the main loop). The timer is the fallback for a claim that never
    // happens, so one candidate cannot block the round robin indefinitely.
    // Both promises are observed by race, so neither can reject unhandled.
    await Promise.race([
      worker.run(),
      sleep(CLAIM_WINDOW_MS, undefined, { signal: windowController.signal }),
    ]);
    return claimed;
  } catch (error) {
    if (!signal.aborted) throw error;
    return claimed;
  } finally {
    windowController.abort();
    signal.removeEventListener("abort", onAbort);
    await (draining ?? worker.close());
  }
}

/**
 * Consume eligible per-provider sync queues with a single active job globally.
 *
 * Candidates are visited round-robin via one absolute cursor advanced once per
 * visit. A provider whose limiter is currently active, or that has no
 * runnable work, is skipped without opening a worker. Each shared queue's
 * native global concurrency is held at the provider's configured cap, so
 * adding this worker cannot raise aggregate concurrency beyond that cap.
 */
export async function runPortableSyncQueues({
  providerIds,
  connection,
  processor,
  signal,
  slot,
  onReady,
}: RunPortableSyncQueuesInput): Promise<void> {
  if (signal.aborted) return;

  const candidates = providerIds.map((providerId) => ({
    providerId,
    queue: createProviderSyncQueue(providerId, connection),
    config: getProviderQueueConfig(providerId),
  }));

  try {
    await Promise.all(
      candidates.map(({ queue, config }) => queue.setGlobalConcurrency(config.concurrency)),
    );
    if (signal.aborted) return;
    onReady();

    let cursor = 0;
    while (!signal.aborted) {
      const offer = await slot.renew();
      const offered = candidates.find(({ providerId }) => providerId === offer);
      if (offer && !offered) await slot.take(offer);
      let claimed = false;
      for (
        let visit = 0;
        visit < (offered ? 1 : candidates.length) && !signal.aborted;
        visit += 1
      ) {
        const index = cursor % candidates.length;
        if (!offered) cursor += 1;
        const candidate = offered ?? candidates[index];
        if (!candidate) break;
        const { queue, config } = candidate;
        if (config.limiter && (await queue.getRateLimitTtl(config.limiter.max)) > 0) {
          continue;
        }
        if (!(await hasRunnableWork(queue))) continue;
        // Direct claims and offers compete for the same idle slot.
        if (!offered && !(await slot.take(null))) break;

        claimed = await claimOne(
          queue,
          config,
          connection,
          async (job, token, jobSignal) => {
            if (offered) await slot.take(offered.providerId);
            return processor(job, token, jobSignal);
          },
          signal,
        );
        break;
      }
      if (!claimed && !signal.aborted) {
        try {
          await sleep(offered ? 100 : IDLE_POLL_INTERVAL_MS, undefined, { signal });
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    }
  } finally {
    await Promise.all([slot.take(null), ...candidates.map(({ queue }) => queue.close())]);
  }
}
