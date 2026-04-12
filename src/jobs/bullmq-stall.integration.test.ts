import { randomUUID } from "node:crypto";
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration tests that exercise BullMQ's stall detection with real Redis.
 *
 * These tests use accelerated timeouts (1-2s lock durations instead of 10min)
 * to reproduce the exact failure mode seen in production: the training export
 * job stalling with "job stalled more than allowable limit".
 *
 * Requires Redis running locally (docker compose up redis).
 */

function getTestRedisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "6379", 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
  };
}

/**
 * Create a deferred promise — a promise with externally-accessible resolve/reject.
 * Equivalent to Promise.withResolvers() but compatible with ES2022 lib target.
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BullMQ stall detection", () => {
  let connection: ConnectionOptions;
  const cleanupFns: Array<() => Promise<void>> = [];

  beforeAll(() => {
    connection = getTestRedisConnection();
  });

  afterEach(async () => {
    // Close all queues and workers created during the test
    await Promise.all(cleanupFns.map((fn) => fn()));
    cleanupFns.length = 0;
  });

  /**
   * Helper: create a queue with a unique name and register it for cleanup.
   */
  function createTestQueue(suffix: string): Queue {
    const queueName = `test-stall-${suffix}-${randomUUID()}`;
    const queue = new Queue(queueName, { connection });
    cleanupFns.push(async () => {
      await queue.obliterate({ force: true }).catch((_error: unknown) => {
        // Best-effort cleanup — queue may already be closed
      });
      await queue.close();
    });
    return queue;
  }

  it("prevents stalling when handler calls extendLock", async () => {
    const queue = createTestQueue("with-extend");
    const { promise, resolve } = deferred<{ failed: boolean; error?: string }>();

    const worker = new Worker(
      queue.name,
      async (job, token) => {
        // Simulate 5s of work, extending lock every 500ms.
        // With lockDuration=2s and stalledInterval=1s, the job would stall
        // without these extendLock calls.
        const start = Date.now();
        while (Date.now() - start < 5_000) {
          await new Promise((r) => setTimeout(r, 500));
          if (token) {
            await job.extendLock(token, 2_000);
          }
        }
      },
      {
        connection,
        lockDuration: 2_000,
        stalledInterval: 1_000,
        maxStalledCount: 0,
      },
    );
    cleanupFns.push(async () => worker.close());

    worker.on("failed", (_job, error) => {
      resolve({ failed: true, error: error.message });
    });
    worker.on("completed", () => {
      resolve({ failed: false });
    });

    await queue.add("test", {});

    const result = await promise;
    expect(result.failed).toBe(false);
  }, 30_000);

  it("passes a defined, non-empty token to the processor", async () => {
    const queue = createTestQueue("token-check");
    const { promise, resolve } = deferred<{ token: string | undefined }>();

    const worker = new Worker(
      queue.name,
      async (_job, token) => {
        resolve({ token });
      },
      { connection },
    );
    cleanupFns.push(async () => worker.close());

    await queue.add("test", {});

    const result = await promise;
    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe("string");
    expect(result.token?.length).toBeGreaterThan(0);
  }, 15_000);

  it("keeps extendLock active when wrapper mirrors training export pattern and BullMQ provides a defined token", async () => {
    // This test mirrors the exact pattern from worker.ts:
    //   extendLock: (duration) =>
    //     token ? job.extendLock(token, duration).then(() => {}) : Promise.resolve()
    //
    // If token were ever falsy, extendLock would become a silent no-op and the
    // job would stall. This test verifies BullMQ provides a defined token here,
    // so the wrapper remains safe and the job does not stall.
    const queue = createTestQueue("defined-token-wrapper");
    const { promise, resolve } = deferred<{
      failed: boolean;
      tokenWasFalsy: boolean;
      error?: string;
    }>();

    const worker = new Worker(
      queue.name,
      async (job, token) => {
        // Replicate the worker.ts wrapper exactly
        const wrappedExtendLock = (duration: number) =>
          token ? job.extendLock(token, duration).then(() => {}) : Promise.resolve();

        const tokenWasFalsy = !token;

        // Simulate long work with periodic lock extension via wrapper
        const start = Date.now();
        while (Date.now() - start < 5_000) {
          await new Promise((r) => setTimeout(r, 500));
          await wrappedExtendLock(2_000);
        }

        // If we got here, the job didn't stall. Report token status.
        resolve({ failed: false, tokenWasFalsy });
      },
      {
        connection,
        lockDuration: 2_000,
        stalledInterval: 1_000,
        maxStalledCount: 0,
      },
    );
    cleanupFns.push(async () => worker.close());

    worker.on("failed", (_job, error) => {
      resolve({ failed: true, tokenWasFalsy: true, error: error.message });
    });

    await queue.add("test", {});

    const result = await promise;

    // The token should always be defined — if it's not, extendLock is a
    // silent no-op and the job will stall (exactly the production bug).
    expect(result.tokenWasFalsy).toBe(false);
    expect(result.failed).toBe(false);
  }, 30_000);
});
