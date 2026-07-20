import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/typed-sql.ts";

const mocks = vi.hoisted(() => ({
  listPending: vi.fn(),
  markDispatched: vi.fn(),
  captureException: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../db/file-upload.ts", () => ({
  listPendingFileUploadOutboxRequests: mocks.listPending,
  markFileUploadOutboxDispatched: mocks.markDispatched,
}));
vi.mock("@sentry/node", () => ({ captureException: mocks.captureException }));
vi.mock("../logger.ts", () => ({
  logger: { error: mocks.logError, info: mocks.logInfo },
}));

import { dispatchFileUploadOutbox, startFileUploadOutboxDispatcher } from "./file-upload-outbox.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPending.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchFileUploadOutbox", () => {
  it("retries a committed outbox event with one deterministic logical job", async () => {
    const uploadId = "00000000-0000-4000-8000-0000000000f1";
    const request = {
      uploadId,
      importJobId: `file-import-${uploadId}`,
      importType: "garmin-dump",
      userId: "00000000-0000-4000-8000-0000000000f2",
    };
    mocks.listPending.mockResolvedValue([request]);
    mocks.markDispatched.mockResolvedValue(undefined);
    const database = { execute: vi.fn(async () => []) } satisfies Pick<Database, "execute">;
    const queue = {
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error("Redis unavailable"))
        .mockResolvedValueOnce({ id: request.importJobId }),
    };

    await expect(dispatchFileUploadOutbox(database, queue)).rejects.toThrow("Redis unavailable");
    await expect(dispatchFileUploadOutbox(database, queue)).resolves.toBe(1);

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      "garmin-dump",
      expect.objectContaining({ uploadId }),
      { jobId: request.importJobId },
    );
    expect(mocks.markDispatched).toHaveBeenCalledOnce();
  });

  it("passes the requested batch size and dispatches every request in order", async () => {
    const requests = [
      {
        uploadId: "00000000-0000-4000-8000-0000000000f1",
        importJobId: "file-import-one",
        importType: "strong-csv",
        userId: "00000000-0000-4000-8000-0000000000f2",
      },
      {
        uploadId: "00000000-0000-4000-8000-0000000000f3",
        importJobId: "file-import-two",
        importType: "fit-file",
        userId: "00000000-0000-4000-8000-0000000000f2",
      },
    ];
    mocks.listPending.mockResolvedValue(requests);
    const database = { execute: vi.fn() } satisfies Pick<Database, "execute">;
    const queue = { add: vi.fn().mockResolvedValue({}) };

    await expect(dispatchFileUploadOutbox(database, queue, 2)).resolves.toBe(2);

    expect(mocks.listPending).toHaveBeenCalledWith(database, 2);
    expect(mocks.markDispatched).toHaveBeenNthCalledWith(1, database, requests[0]?.uploadId);
    expect(mocks.markDispatched).toHaveBeenNthCalledWith(2, database, requests[1]?.uploadId);
  });

  it("polls immediately, reports dispatched work, and stops when closed", async () => {
    vi.useFakeTimers();
    const request = {
      uploadId: "00000000-0000-4000-8000-0000000000f1",
      importJobId: "file-import-one",
      importType: "strong-csv",
      userId: "00000000-0000-4000-8000-0000000000f2",
    };
    mocks.listPending.mockResolvedValue([request]);
    const database = { execute: vi.fn() } satisfies Pick<Database, "execute">;
    const queue = { add: vi.fn().mockResolvedValue({}) };

    const dispatcher = startFileUploadOutboxDispatcher(database, queue, 100);
    await vi.waitFor(() => expect(mocks.logInfo).toHaveBeenCalledOnce());
    expect(mocks.logInfo).toHaveBeenCalledWith("[file-upload-outbox] Dispatched 1 upload(s)");
    const callsBeforeInterval = mocks.listPending.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listPending).toHaveBeenCalledTimes(callsBeforeInterval + 1);

    await dispatcher.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listPending).toHaveBeenCalledTimes(callsBeforeInterval + 1);
  });

  it("does not overlap polls and resumes after the active dispatch completes", async () => {
    vi.useFakeTimers();
    let resolveList: ((requests: []) => void) | undefined;
    mocks.listPending.mockImplementationOnce(
      () =>
        new Promise<[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const database = { execute: vi.fn() } satisfies Pick<Database, "execute">;
    const queue = { add: vi.fn() };
    const dispatcher = startFileUploadOutboxDispatcher(database, queue, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listPending).toHaveBeenCalledOnce();
    resolveList?.([]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listPending).toHaveBeenCalledTimes(2);
    await dispatcher.close();
  });

  it("reports polling failures and continues polling", async () => {
    vi.useFakeTimers();
    mocks.listPending
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue([]);
    const database = { execute: vi.fn() } satisfies Pick<Database, "execute">;
    const queue = { add: vi.fn() };

    const dispatcher = startFileUploadOutboxDispatcher(database, queue, 100);
    await vi.waitFor(() => expect(mocks.captureException).toHaveBeenCalledOnce());
    expect(mocks.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { source: "file-upload-outbox" },
    });
    expect(mocks.logError).toHaveBeenCalledWith(
      "[file-upload-outbox] Dispatch failed: Error: database unavailable",
    );
    const callsBeforeInterval = mocks.listPending.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.listPending).toHaveBeenCalledTimes(callsBeforeInterval + 1);
    await dispatcher.close();
  });
});
