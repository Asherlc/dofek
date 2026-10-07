import { createDatabase } from "dofek/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  ensure: vi.fn(),
  enqueue: vi.fn(),
  invalidate: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("dofek/db/account-erasure", () => ({ withAccountErasureUserWriteFence: mocks.fence }));
vi.mock("dofek/db/tokens", () => ({ ensureProvider: mocks.ensure }));
vi.mock("dofek/jobs/enqueue-sync-job", () => ({ enqueueReconnectSyncJob: mocks.enqueue }));
vi.mock("dofek/lib/cache", () => ({ queryCache: { invalidateByPrefix: mocks.invalidate } }));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: mocks.capture }));

import { completeCredentialReconnect } from "./credential-reconnect.ts";

describe("completeCredentialReconnect", () => {
  const db = createDatabase("postgres://unused:unused@127.0.0.1/unused");
  const transaction = createDatabase("postgres://unused:unused@127.0.0.1/unused");
  const ctx = { db, userId: "user-1" };
  const provider = { id: "peloton", name: "Peloton", apiBaseUrl: "https://api.onepeloton.com" };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fence.mockImplementation(async (_db, _userId, operation) => operation(transaction));
  });

  it("waits for persistence and its transaction to commit before fenced dispatch", async () => {
    const save = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const persist = vi.fn(() => {
      started.resolve();
      return save.promise;
    });
    mocks.fence.mockImplementationOnce(async (_db, _userId, operation) => {
      await operation(transaction);
      await commit.promise;
    });
    const completion = completeCredentialReconnect(ctx, provider, persist);
    await started.promise;
    expect(mocks.enqueue).not.toHaveBeenCalled();
    save.resolve();
    await Promise.resolve();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    commit.resolve();
    await completion;
    expect(persist).toHaveBeenCalledWith(transaction);
    expect(mocks.ensure).toHaveBeenCalledWith(
      transaction,
      "peloton",
      "Peloton",
      provider.apiBaseUrl,
      "user-1",
    );
    expect(mocks.invalidate).toHaveBeenCalledWith("user-1:sync.providers");
    expect(mocks.fence).toHaveBeenCalledTimes(2);
    expect(mocks.fence).toHaveBeenNthCalledWith(2, db, "user-1", expect.any(Function));
    expect(mocks.enqueue).toHaveBeenCalledWith("peloton", "user-1");
  });

  it("does not enqueue when persistence rejects", async () => {
    await expect(
      completeCredentialReconnect(ctx, provider, async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rejects persistence when account erasure fences the user", async () => {
    mocks.fence.mockRejectedValueOnce(new Error("Account erasure in progress"));
    const persist = vi.fn();
    await expect(completeCredentialReconnect(ctx, provider, persist)).rejects.toThrow(
      "Account erasure in progress",
    );
    expect(persist).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("does not dispatch if erasure begins after credentials commit", async () => {
    mocks.fence.mockImplementationOnce(async (_db, _userId, operation) => operation(transaction));
    mocks.fence.mockRejectedValueOnce(new Error("Account erasure in progress"));
    await expect(completeCredentialReconnect(ctx, provider, vi.fn())).rejects.toThrow(
      "Peloton connected, but its sync could not be started. Try Sync again.",
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("starts sync even if cache invalidation fails and reports an actionable status error", async () => {
    const error = new Error("cache unavailable");
    mocks.invalidate.mockRejectedValueOnce(error);
    await expect(completeCredentialReconnect(ctx, provider, vi.fn())).rejects.toThrow(
      "Peloton connected and sync started, but its status could not be refreshed. Refresh this page.",
    );
    expect(mocks.enqueue).toHaveBeenCalledWith("peloton", "user-1");
    expect(mocks.capture).toHaveBeenCalledWith(error);
  });

  it("reports dispatch failure after committing credentials", async () => {
    const error = new Error("queue unavailable");
    mocks.enqueue.mockRejectedValueOnce(error);
    const persist = vi.fn();
    await expect(completeCredentialReconnect(ctx, provider, persist)).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Peloton connected, but its sync could not be started. Try Sync again.",
      cause: error,
    });
    expect(persist).toHaveBeenCalledWith(transaction);
    expect(mocks.capture).toHaveBeenCalledWith(error);
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
