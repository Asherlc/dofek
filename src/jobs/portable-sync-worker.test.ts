import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunPortableSyncQueuesInput } from "./portable-sync-queues.ts";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  closeReadiness: vi.fn(),
  healthStatus: vi.fn<() => number>(),
  closeQueues: vi.fn(async () => undefined),
  closeLockPool: vi.fn(async () => undefined),
  closeDatabase: vi.fn(async () => undefined),
  shutdownInstrumentation: vi.fn(async () => undefined),
  prepare: vi.fn(async () => undefined),
  run: vi.fn<(input: RunPortableSyncQueuesInput) => Promise<void>>(),
}));

vi.mock("node:http", () => ({
  createServer(
    respond: (request: undefined, response: { writeHead(status: number): { end(): void } }) => void,
  ) {
    mocks.healthStatus.mockImplementation(() => {
      let status = 0;
      respond(undefined, {
        writeHead(value) {
          status = value;
          return { end: vi.fn() };
        },
      });
      return status;
    });
    return { listen: mocks.listen, close: mocks.closeReadiness };
  },
}));
vi.mock("../db/index.ts", () => ({
  createDatabaseFromEnv: vi.fn(() => ({ $client: { end: mocks.closeDatabase } })),
}));
vi.mock("../instrumentation.ts", () => ({
  startInstrumentation: vi.fn(() => ({ shutdown: mocks.shutdownInstrumentation })),
}));
vi.mock("../lib/sentry.ts", () => ({ initProductionSentry: vi.fn() }));
vi.mock("../logger.ts", () => ({ logger: { info: vi.fn() } }));
vi.mock("../providers/index.ts", () => ({
  getEnabledSyncProviders: vi.fn(() => [{ id: "kilter" }, { id: "tension" }, { id: "strava" }]),
}));
vi.mock("./account-erasure-startup.ts", () => ({ prepareProviderWorker: mocks.prepare }));
vi.mock("./account-erasure-work-guard.ts", () => ({
  createAccountErasureWorkLockPoolFromEnv: vi.fn(() => ({ close: mocks.closeLockPool })),
}));
vi.mock("./portable-sync-queues.ts", () => ({ runPortableSyncQueues: mocks.run }));
vi.mock("./portable-sync-slot.ts", () => ({ createPortableSyncSlot: vi.fn() }));
vi.mock("./provider-sync-processor.ts", () => ({ createProviderSyncProcessor: vi.fn() }));
vi.mock("./queues.ts", () => ({
  getRedisConnection: vi.fn(() => ({})),
  getSharedRedisConnection: vi.fn(() => ({ client: Promise.resolve({}) })),
  closeAllQueueResources: mocks.closeQueues,
}));

const terminationSignals = ["SIGINT", "SIGTERM"] as const;
const previousListeners = new Map<(typeof terminationSignals)[number], Set<unknown>>();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("REDIS_URL", "redis://fixture");
  for (const signal of terminationSignals) {
    previousListeners.set(signal, new Set(process.listeners(signal)));
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const signal of terminationSignals) {
    for (const listener of process.listeners(signal)) {
      if (!previousListeners.get(signal)?.has(listener)) process.off(signal, listener);
    }
  }
});

describe("portable sync worker startup", () => {
  it("starts only the configured queues, then drains and flushes on shutdown", async () => {
    vi.stubEnv("SYNC_WORKER_PROVIDERS", "kilter,tension,kilter");
    mocks.run.mockImplementationOnce(async ({ providerIds, signal, onReady }) => {
      expect(mocks.prepare).toHaveBeenCalledOnce();
      expect(providerIds).toEqual(["kilter", "tension"]);
      onReady();
      expect(mocks.listen).toHaveBeenCalledWith(3002, "::");
      expect(mocks.healthStatus()).toBe(200);
      const stop = process.listeners("SIGTERM").find((listener) => {
        return !previousListeners.get("SIGTERM")?.has(listener);
      });
      if (!stop) throw new Error("The worker did not register a shutdown handler");
      stop("SIGTERM");
      expect(signal.aborted).toBe(true);
      expect(mocks.healthStatus()).toBe(503);
    });

    await import("./portable-sync-worker.ts");

    expect(mocks.closeReadiness).toHaveBeenCalled();
    expect(mocks.closeQueues).toHaveBeenCalledOnce();
    expect(mocks.closeLockPool).toHaveBeenCalledOnce();
    expect(mocks.closeDatabase).toHaveBeenCalledOnce();
    expect(mocks.shutdownInstrumentation).toHaveBeenCalledOnce();
    expect(mocks.closeQueues).toHaveBeenCalledBefore(mocks.shutdownInstrumentation);
  });

  it.each([
    ["", "SYNC_WORKER_PROVIDERS is required"],
    ["not-a-provider", "SYNC_WORKER_PROVIDERS includes unavailable queues: not-a-provider"],
    ["strava", "SYNC_WORKER_PROVIDERS includes rate-limited queues: strava"],
  ])("fails before starting a worker for invalid configuration %j", async (providers, message) => {
    vi.stubEnv("SYNC_WORKER_PROVIDERS", providers);
    await expect(import("./portable-sync-worker.ts")).rejects.toThrow(message);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
  });

  it("requires a Redis endpoint before opening a worker", async () => {
    vi.stubEnv("SYNC_WORKER_PROVIDERS", "kilter");
    vi.stubEnv("REDIS_URL", undefined);
    await expect(import("./portable-sync-worker.ts")).rejects.toThrow("REDIS_URL is required");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
