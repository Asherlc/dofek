import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import { createMockDatabase } from "../providers/test-helpers.ts";
import type { AccountErasureWorkLockPool } from "./account-erasure-work-guard.ts";
import { processSyncJob } from "./process-sync-job.ts";
import { createProviderSyncProcessor } from "./provider-sync-processor.ts";

vi.mock("../logger.ts", () => ({
  jobContext: { run: (_job: unknown, work: () => unknown) => work() },
  logger: { info: vi.fn() },
}));
vi.mock("./account-erasure-work-guard.ts", () => ({
  runQueuedUserWorkUnlessAccountErasing: vi.fn((_pool, _db, _userId, _kind, work: () => unknown) =>
    work(),
  ),
}));
vi.mock("./process-sync-job.ts", () => ({ processSyncJob: vi.fn() }));

const { db } = createMockDatabase();
const pool: AccountErasureWorkLockPool = {
  close: vi.fn(async () => undefined),
  tryRunWithExclusiveUserLock: vi.fn(async (_userId, work) => work()),
  runWithSharedUserLock: vi.fn(async (_userId, work) => work()),
};
const job: Parameters<ReturnType<typeof createProviderSyncProcessor>>[0] = {
  id: "fixture-job-private",
  queueQualifiedName: "bull:sync-kilter",
  timestamp: 0,
  attemptsMade: 0,
  attemptsStarted: 1,
  data: { userId: "fixture-user-private", providerId: "kilter" },
  getDependencies: vi.fn(),
  moveToWaitingChildren: vi.fn(),
  updateProgress: vi.fn(),
  updateData: vi.fn(),
  log: vi.fn(),
  opts: { attempts: 3 },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SYNC_WORKER_SITE", "fly");
  vi.stubEnv("SYNC_WORKER_INSTANCE", undefined);
  vi.stubEnv("FLY_MACHINE_ID", "fixture-machine");
});
afterEach(() => vi.unstubAllEnvs());

describe("provider sync execution attribution", () => {
  it("records an attempt and its duration without raw identifiers", async () => {
    const signal = new AbortController().signal;
    await createProviderSyncProcessor(db, pool)(job, "fixture-token", signal);

    expect(processSyncJob).toHaveBeenCalledWith(job, db, signal);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("Provider sync attempt finished", {
      event: "provider_sync_attempt_finished",
      worker_site: "fly",
      worker_instance: "fixture-machine",
      provider_id: "kilter",
      queue: "bull:sync-kilter",
      attempt: 1,
      outcome: "returned",
      duration_ms: expect.any(Number),
    });
  });

  it("records and preserves exceptions on the host that made the attempt", async () => {
    vi.stubEnv("SYNC_WORKER_SITE", "oracle");
    vi.stubEnv("SYNC_WORKER_INSTANCE", "fixture-oracle-host");
    const failure = new Error("fixture failure");
    vi.mocked(processSyncJob).mockRejectedValue(failure);

    await expect(createProviderSyncProcessor(db, pool)(job)).rejects.toBe(failure);
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      "Provider sync attempt finished",
      expect.objectContaining({
        worker_site: "oracle",
        worker_instance: "fixture-oracle-host",
        outcome: "threw",
      }),
    );
  });
});
