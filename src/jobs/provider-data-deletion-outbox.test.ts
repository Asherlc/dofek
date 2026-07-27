import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchProviderDataDeletionOutbox,
  startProviderDataDeletionOutboxDispatcher,
} from "./provider-data-deletion-outbox.ts";

const mocks = vi.hoisted(() => ({
  AccountErasureUserFencedError: class AccountErasureUserFencedError extends Error {},
  captureException: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  withUserWriteFence: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: mocks.captureException,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
  },
}));
vi.mock("../db/account-erasure.ts", () => ({
  AccountErasureUserFencedError: mocks.AccountErasureUserFencedError,
  withAccountErasureUserWriteFence: (
    database: unknown,
    userId: string,
    operation: (transaction: unknown) => Promise<unknown>,
  ) => mocks.withUserWriteFence(database, userId, operation),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
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
  vi.restoreAllMocks();
});

describe("dispatchProviderDataDeletionOutbox", () => {
  it("enqueues pending requests before marking them dispatched", async () => {
    const eventId = "30000000-0000-4000-8000-000000000003";
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          event_id: eventId,
          generation: "2",
          provider_id: "garmin",
          user_id: "00000000-0000-4000-8000-000000000004",
        },
      ])
      .mockResolvedValueOnce([]);
    const add = vi.fn(async () => undefined);

    await expect(
      dispatchProviderDataDeletionOutbox({ execute, transaction: vi.fn() }, { add }, 100),
    ).resolves.toBe(1);

    expect(add).toHaveBeenCalledWith(
      "provider-data-deletion",
      expect.objectContaining({ eventId, generation: 2 }),
      expect.objectContaining({ jobId: eventId }),
    );
    expect(add.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[1] ?? 0);
    expect(mocks.withUserWriteFence).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-4000-8000-000000000004",
      expect.any(Function),
    );
  });

  it("skips a fenced account without starving later users", async () => {
    const firstEventId = "30000000-0000-4000-8000-000000000003";
    const secondEventId = "40000000-0000-4000-8000-000000000003";
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          event_id: firstEventId,
          generation: "2",
          provider_id: "garmin",
          user_id: "00000000-0000-4000-8000-000000000004",
        },
        {
          event_id: secondEventId,
          generation: "3",
          provider_id: "wahoo",
          user_id: "00000000-0000-4000-8000-000000000005",
        },
      ])
      .mockResolvedValue([]);
    mocks.withUserWriteFence
      .mockRejectedValueOnce(new mocks.AccountErasureUserFencedError())
      .mockImplementationOnce(
        async (
          database: unknown,
          _userId: string,
          operation: (transaction: unknown) => Promise<unknown>,
        ) => operation(database),
      );
    const add = vi.fn(async () => undefined);

    await expect(
      dispatchProviderDataDeletionOutbox({ execute, transaction: vi.fn() }, { add }, 100),
    ).resolves.toBe(1);

    expect(add).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith(
      "provider-data-deletion",
      expect.objectContaining({ eventId: secondEventId }),
      expect.any(Object),
    );
  });
});

describe("startProviderDataDeletionOutboxDispatcher", () => {
  it("dispatches immediately and logs the number of requests", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          event_id: "30000000-0000-4000-8000-000000000003",
          generation: "2",
          provider_id: "garmin",
          user_id: "00000000-0000-4000-8000-000000000004",
        },
      ])
      .mockResolvedValueOnce([]);
    const add = vi.fn(async () => undefined);

    const dispatcher = startProviderDataDeletionOutboxDispatcher(
      { execute, transaction: vi.fn() },
      { add },
      1_000,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(add).toHaveBeenCalledOnce();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "[provider-data-deletion-outbox] Dispatched 1 request(s)",
    );
    await dispatcher.close();
  });

  it("does not overlap interval dispatches", async () => {
    let resolveFirstQuery: ((rows: Record<string, unknown>[]) => void) | undefined;
    const firstQuery = new Promise<Record<string, unknown>[]>((resolve) => {
      resolveFirstQuery = resolve;
    });
    const execute = vi.fn().mockReturnValueOnce(firstQuery).mockResolvedValue([]);
    const add = vi.fn(async () => undefined);

    const dispatcher = startProviderDataDeletionOutboxDispatcher(
      { execute, transaction: vi.fn() },
      { add },
      1_000,
    );
    expect(execute).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(execute).toHaveBeenCalledOnce();

    if (!resolveFirstQuery) throw new Error("Expected the first generation query to start");
    resolveFirstQuery([]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
    await dispatcher.close();
  });

  it("reports dispatch errors and retries on the next interval", async () => {
    const dispatchError = new Error("database unavailable");
    const execute = vi.fn().mockRejectedValueOnce(dispatchError).mockResolvedValue([]);
    const add = vi.fn(async () => undefined);

    const dispatcher = startProviderDataDeletionOutboxDispatcher(
      { execute, transaction: vi.fn() },
      { add },
      1_000,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.captureException).toHaveBeenCalledWith(dispatchError, {
      tags: { source: "provider-data-deletion-outbox" },
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "[provider-data-deletion-outbox] Dispatch failed: Error: database unavailable",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(2);
    await dispatcher.close();
  });

  it("clears the interval and fences captured callbacks when closed", async () => {
    vi.useRealTimers();
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let invokeInterval: (() => void) | undefined;
    let intervalHandle: ReturnType<typeof setInterval> | undefined;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((callback) => {
      invokeInterval = () => {
        if (typeof callback !== "function") throw new Error("Expected an interval callback");
        callback();
      };
      intervalHandle = originalSetInterval(() => undefined, 60_000);
      return intervalHandle;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const execute = vi.fn().mockResolvedValue([]);
    const add = vi.fn(async () => undefined);

    try {
      const dispatcher = startProviderDataDeletionOutboxDispatcher(
        { execute, transaction: vi.fn() },
        { add },
        1_000,
      );
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      await dispatcher.close();

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
      if (!invokeInterval) throw new Error("Expected the interval callback to be captured");
      invokeInterval();
      await Promise.resolve();
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      if (intervalHandle) originalClearInterval(intervalHandle);
    }
  });
});
