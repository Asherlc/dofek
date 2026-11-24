import { type Job, type RedisConnection, WaitingError, type Worker } from "bullmq";
import { captureException } from "../lib/error-reporting.ts";
import type { SyncJobData } from "./queues.ts";

const SLOT_KEY = "dofek:portable-sync:slot";
const IDLE = "idle";
const SLOT_TTL_MS = 3_000;

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
  worker: Pick<Worker<SyncJobData>, "pause" | "resume" | "closing">,
  providerId: string,
  job: Job<SyncJobData>,
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

  // BullMQ keeps the same job and retry budget. The local pause gives the
  // portable worker time to claim it before Oracle resumes the queue.
  await worker.pause(true);
  try {
    await job.moveToWait(token);
  } finally {
    setTimeout(() => {
      if (!worker.closing) {
        void worker.resume().catch((error: unknown) => {
          captureException(error, { tags: { source: "portable-sync-fallback" } });
        });
      }
    }, SLOT_TTL_MS).unref();
  }
  throw new WaitingError();
}
