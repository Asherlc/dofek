import { type Job, type RedisConnection, WaitingError, type Worker } from "bullmq";
import { captureException } from "../lib/error-reporting.ts";
import type { SyncJobData } from "./queues.ts";

const SLOT_KEY = "dofek:portable-sync:slot";
const IDLE = "idle";
const SLOT_TTL_MS = 3_000;

/**
 * In-process ownership so readiness can treat an intentional Fly handoff pause
 * as healthy. `until` is set only when that owner schedules the resume timer.
 */
type PortableSyncHandoffMark = { until?: number };
const handoffMarkByWorker = new WeakMap<object, PortableSyncHandoffMark>();

export function isPortableSyncHandoffActive(worker: object): boolean {
  const mark = handoffMarkByWorker.get(worker);
  return mark?.until !== undefined && performance.now() < mark.until;
}

export function createPortableSyncSlot(
  redis: Pick<Awaited<RedisConnection["client"]>, "eval">,
  key = SLOT_KEY,
) {
  return {
    async renew(): Promise<string | null> {
      const state = await redis.eval(
        `local state = redis.call('GET', KEYS[1])
         if not state or state == ARGV[1] then
           redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[1])
           return ARGV[1]
         end
         return state`,
        1,
        key,
        IDLE,
        SLOT_TTL_MS,
      );
      return typeof state === "string" && state !== IDLE ? state : null;
    },
    async offer(providerId: string): Promise<boolean> {
      const reserved = await redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
         redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[3])
         return 1`,
        1,
        key,
        IDLE,
        SLOT_TTL_MS,
        providerId,
      );
      return reserved === 1;
    },
    async take(offer: string | null): Promise<boolean> {
      const removed = await redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
         return redis.call('DEL', KEYS[1])`,
        1,
        key,
        offer ?? IDLE,
      );
      return removed === 1;
    },
  };
}

export async function yieldSyncToPortableWorker(
  getSlot: () => Promise<ReturnType<typeof createPortableSyncSlot>>,
  worker: Pick<Worker<SyncJobData>, "pause" | "resume" | "closing" | "isPaused">,
  providerId: string,
  job: Pick<Job<SyncJobData>, "attemptsStarted" | "moveToWait">,
  token?: string,
): Promise<void> {
  if (!token || job.attemptsStarted !== 1) return;
  try {
    const slot = await getSlot();
    if (!(await slot.offer(providerId))) return;
  } catch (error) {
    captureException(error, {
      tags: { source: "portable-sync-reservation", provider: providerId },
    });
    return;
  }

  // Claim ownership immediately after a successful offer so an earlier resume
  // timer cannot clear a newer handoff that is still blocked on moveToWait.
  const mark: PortableSyncHandoffMark = {};
  handoffMarkByWorker.set(worker, mark);

  // BullMQ keeps the same job and retry budget. The local pause gives the
  // portable worker time to claim it before Oracle resumes the queue.
  try {
    await worker.pause(true);
    await job.moveToWait(token);
  } finally {
    // Only the current owner prepares the resume timer. A later accepted offer
    // already replaced this mark; leave that owner alone.
    if (handoffMarkByWorker.get(worker) === mark) {
      if (worker.isPaused()) {
        // Align the readiness deadline with this owner's resume timer. Also
        // covers pause failures that leave the worker paused from a prior offer.
        mark.until = performance.now() + SLOT_TTL_MS;
        setTimeout(() => {
          if (handoffMarkByWorker.get(worker) !== mark) return;
          handoffMarkByWorker.delete(worker);
          if (!worker.closing) {
            void worker.resume().catch((error: unknown) => {
              captureException(error, { tags: { source: "portable-sync-fallback" } });
            });
          }
        }, SLOT_TTL_MS).unref();
      } else {
        handoffMarkByWorker.delete(worker);
      }
    }
  }
  throw new WaitingError();
}
