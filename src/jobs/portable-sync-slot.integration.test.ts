import { randomUUID } from "node:crypto";
import { Queue, RedisConnection, Worker } from "bullmq";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createPortableSyncSlot, yieldSyncToPortableWorker } from "./portable-sync-slot.ts";
import { getRedisConnection, type SyncJobData } from "./queues.ts";
import { createWorkerReadinessServer } from "./worker-readiness.ts";

const connection = getRedisConnection();
const redisConnection = new RedisConnection(connection, { blocking: false });
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});
afterAll(() => redisConnection.close());

async function fixture(
  getSlot?: (
    slot: ReturnType<typeof createPortableSyncSlot>,
  ) => Promise<ReturnType<typeof createPortableSyncSlot>>,
) {
  const queue = new Queue<SyncJobData>(`portable-slot-test-${randomUUID()}`, { connection });
  const redis = await redisConnection.client;
  const slot = createPortableSyncSlot(redis, `${queue.qualifiedName}:slot`);
  resources.push(async () => {
    await redis.del(`${queue.qualifiedName}:slot`);
    await queue.obliterate({ force: true });
    await queue.close();
  });
  const processed: string[] = [];
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const oracle: Worker<SyncJobData> = new Worker<SyncJobData>(
    queue.name,
    async (job, token) => {
      await yieldSyncToPortableWorker(
        async () => getSlot?.(slot) ?? slot,
        oracle,
        "test-provider",
        job,
        token,
      );
      processed.push("oracle");
    },
    { connection, autorun: false },
  );
  oracle.on("completed", finish);
  const fly = new Worker<SyncJobData>(
    queue.name,
    async () => {
      processed.push("fly");
    },
    { connection, autorun: false },
  );
  fly.on("completed", finish);
  resources.push(
    () => oracle.close(),
    () => fly.close(),
  );
  return { queue, slot, oracle, fly, processed, finished };
}

describe("portable sync preference with Redis", () => {
  it("gives one offer to Fly while both workers can run", async () => {
    const { queue, slot, oracle, fly, processed, finished } = await fixture();
    await slot.renew();
    let offered: () => void = () => {};
    const offer = new Promise<void>((resolve) => {
      offered = resolve;
    });
    oracle.once("paused", offered);
    const job = await queue.add("sync", { userId: "fixture-user" }, { attempts: 2 });
    void oracle.run();
    await offer;
    expect(await slot.renew()).toBe("test-provider");
    expect(await slot.take("test-provider")).toBe(true);
    void fly.run();
    await finished;
    expect(processed).toEqual(["fly"]);
    const completed = await queue.getJob(job.id ?? "");
    expect(completed?.attemptsMade).toBe(1);
  });

  it("keeps /readyz available during the handoff pause and still yields to Fly", async () => {
    const { queue, slot, oracle, fly, processed, finished } = await fixture();
    const readinessServer = createWorkerReadinessServer([oracle]);
    resources.push(
      () =>
        new Promise<void>((resolve, reject) => {
          readinessServer.closeAllConnections();
          readinessServer.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    await new Promise<void>((resolve) => readinessServer.listen(0, "127.0.0.1", resolve));
    const address = readinessServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Worker readiness server did not bind a TCP port");
    }
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const backend = oracle.getBackend();
    const client = await backend.client;
    const llen = vi.spyOn(client, "llen");

    await slot.renew();
    let offered: () => void = () => {};
    const offer = new Promise<void>((resolve) => {
      offered = resolve;
    });
    oracle.once("paused", offered);
    const job = await queue.add("sync", { userId: "fixture-user" }, { attempts: 2 });
    const oracleRun = oracle.run();
    await offer;
    expect(await slot.renew()).toBe("test-provider");
    expect(await slot.take("test-provider")).toBe(true);
    await oracleRun;

    expect(oracle.isRunning()).toBe(false);
    const duringHandoff = await fetch(`${serverUrl}/readyz`);
    expect(duringHandoff.status).toBe(200);
    await expect(duringHandoff.json()).resolves.toEqual({ status: "ok", workers: 1 });
    expect(llen).toHaveBeenCalledWith(backend.toKey("wait"));

    void fly.run();
    await finished;
    expect(processed).toEqual(["fly"]);
    const completed = await queue.getJob(job.id ?? "");
    expect(completed?.attemptsMade).toBe(1);
  }, 10_000);

  it("falls back to Oracle if Fly exits after advertising its slot", async () => {
    const { queue, slot, oracle, processed, finished } = await fixture();
    await slot.renew();
    await queue.add("sync", { userId: "fixture-user" }, { attempts: 2 });
    void oracle.run();
    await finished;
    expect(processed).toEqual(["oracle"]);
  }, 10_000);

  it.each(["connection", "offer"])(
    "runs locally on the first attempt after a reservation %s fails",
    async (stage) => {
      const { queue, slot, oracle, processed, finished } = await fixture(async (availableSlot) => {
        if (stage === "connection") throw new Error("Reservation connection failed");
        return {
          ...availableSlot,
          async offer() {
            throw new Error("Reservation command timed out");
          },
        };
      });
      await slot.renew();
      const job = await queue.add("sync", { userId: "fixture-user" }, { attempts: 2 });
      void oracle.run();
      await finished;
      expect(processed).toEqual(["oracle"]);
      expect((await queue.getJob(job.id ?? ""))?.attemptsMade).toBe(1);
    },
    10_000,
  );
});
