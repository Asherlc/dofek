import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.ts";

const mocks = vi.hoisted(() => ({
  AccountErasureUserFencedError: class AccountErasureUserFencedError extends Error {},
  captureException: vi.fn(),
  listQueued: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
  withUserWriteFence: vi.fn(),
}));

vi.mock("../db/data-export.ts", () => ({
  listQueuedDataExportRequests: mocks.listQueued,
}));
vi.mock("@sentry/node", () => ({ captureException: mocks.captureException }));
vi.mock("../db/account-erasure.ts", () => ({
  AccountErasureUserFencedError: mocks.AccountErasureUserFencedError,
  withAccountErasureUserWriteFence: (...args: unknown[]) => mocks.withUserWriteFence(...args),
}));
vi.mock("../logger.ts", () => ({
  logger: { error: mocks.logError, info: mocks.logInfo },
}));

import { dispatchDataExportOutbox, startDataExportOutboxDispatcher } from "./data-export-outbox.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listQueued.mockResolvedValue([]);
  mocks.withUserWriteFence.mockImplementation(
    async (
      database: unknown,
      _userId: string,
      operation: (transaction: unknown) => Promise<unknown>,
    ) => operation(database),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchDataExportOutbox", () => {
  function mockDatabase() {
    return {
      execute: vi.fn(async () => []),
      transaction: vi.fn(),
    } satisfies Pick<Database, "execute" | "transaction">;
  }

  it("retries a committed export with one deterministic BullMQ job", async () => {
    const request = {
      exportId: "10000000-0000-4000-8000-000000000025",
      userId: "20000000-0000-4000-8000-000000000025",
    };
    mocks.listQueued.mockResolvedValue([request]);
    const database = mockDatabase();
    const queue = {
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error("Redis unavailable"))
        .mockResolvedValueOnce({ id: request.exportId }),
    };

    await expect(dispatchDataExportOutbox(database, queue)).rejects.toThrow("Redis unavailable");
    await expect(dispatchDataExportOutbox(database, queue)).resolves.toBe(1);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      "export",
      {
        exportId: request.exportId,
        userId: request.userId,
      },
      {
        jobId: request.exportId,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    expect(mocks.withUserWriteFence).toHaveBeenCalledWith(
      database,
      request.userId,
      expect.any(Function),
    );
  });

  it("passes the requested batch size and dispatches every queued export in order", async () => {
    const requests = [
      {
        exportId: "10000000-0000-4000-8000-000000000025",
        userId: "20000000-0000-4000-8000-000000000025",
      },
      {
        exportId: "30000000-0000-4000-8000-000000000025",
        userId: "20000000-0000-4000-8000-000000000025",
      },
    ];
    mocks.listQueued.mockResolvedValue(requests);
    const database = mockDatabase();
    const queue = { add: vi.fn().mockResolvedValue({}) };

    await expect(dispatchDataExportOutbox(database, queue, 2)).resolves.toBe(2);

    expect(mocks.listQueued).toHaveBeenCalledWith(database, 2);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it("skips a fenced account without starving later users", async () => {
    const requests = [
      {
        exportId: "10000000-0000-4000-8000-000000000025",
        userId: "20000000-0000-4000-8000-000000000025",
      },
      {
        exportId: "30000000-0000-4000-8000-000000000025",
        userId: "40000000-0000-4000-8000-000000000025",
      },
    ];
    mocks.listQueued.mockResolvedValue(requests);
    mocks.withUserWriteFence
      .mockRejectedValueOnce(new mocks.AccountErasureUserFencedError())
      .mockImplementationOnce(
        async (
          database: unknown,
          _userId: string,
          operation: (transaction: unknown) => Promise<unknown>,
        ) => operation(database),
      );
    const database = mockDatabase();
    const queue = { add: vi.fn().mockResolvedValue({}) };

    await expect(dispatchDataExportOutbox(database, queue, 2)).resolves.toBe(1);

    expect(queue.add).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledWith(
      "export",
      expect.objectContaining({ exportId: requests[1]?.exportId }),
      expect.any(Object),
    );
  });
});

describe("startDataExportOutboxDispatcher", () => {
  function mockDatabase() {
    return {
      execute: vi.fn(async () => []),
      transaction: vi.fn(),
    } satisfies Pick<Database, "execute" | "transaction">;
  }

  it("polls immediately, reports dispatched work, and stops when closed", async () => {
    vi.useFakeTimers();
    const request = {
      exportId: "10000000-0000-4000-8000-000000000025",
      userId: "20000000-0000-4000-8000-000000000025",
    };
    mocks.listQueued.mockResolvedValue([request]);
    const database = mockDatabase();
    const queue = { add: vi.fn().mockResolvedValue({}) };

    const dispatcher = startDataExportOutboxDispatcher(database, queue, 100);
    await vi.waitFor(() => expect(mocks.logInfo).toHaveBeenCalledOnce());
    expect(mocks.logInfo).toHaveBeenCalledWith("[data-export-outbox] Ensured 1 queued export(s)");
    const callsBeforeInterval = mocks.listQueued.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listQueued).toHaveBeenCalledTimes(callsBeforeInterval + 1);

    await dispatcher.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listQueued).toHaveBeenCalledTimes(callsBeforeInterval + 1);
  });

  it("does not overlap polls and resumes after the active dispatch completes", async () => {
    vi.useFakeTimers();
    let resolveList: ((requests: []) => void) | undefined;
    mocks.listQueued.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const database = mockDatabase();
    const queue = { add: vi.fn() };
    const dispatcher = startDataExportOutboxDispatcher(database, queue, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listQueued).toHaveBeenCalledOnce();
    resolveList?.([]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listQueued).toHaveBeenCalledTimes(2);
    await dispatcher.close();
  });

  it("does not log when there are no queued exports", async () => {
    vi.useFakeTimers();
    const database = mockDatabase();
    const queue = { add: vi.fn() };

    const dispatcher = startDataExportOutboxDispatcher(database, queue, 100);
    await vi.waitFor(() => expect(mocks.listQueued).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.logInfo).not.toHaveBeenCalled();
    await dispatcher.close();
  });

  it("reports polling failures and continues polling", async () => {
    vi.useFakeTimers();
    mocks.listQueued.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue([]);
    const database = mockDatabase();
    const queue = { add: vi.fn() };

    const dispatcher = startDataExportOutboxDispatcher(database, queue, 100);
    await vi.waitFor(() => expect(mocks.captureException).toHaveBeenCalledOnce());
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: "data-export-outbox" },
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      "[data-export-outbox] Dispatch failed: Error: database unavailable",
    );
    const callsBeforeInterval = mocks.listQueued.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listQueued).toHaveBeenCalledTimes(callsBeforeInterval + 1);
    await dispatcher.close();
  });
});
