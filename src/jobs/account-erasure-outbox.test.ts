import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteExpiredPreparations: vi.fn(async () => 0),
  enqueue: vi.fn(async () => undefined),
  listPending: vi.fn(async () => [
    { id: "10000000-0000-4000-8000-000000001994" },
    { id: "20000000-0000-4000-8000-000000001994" },
  ]),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  markDispatched: vi.fn(async () => undefined),
  markOverdue: vi.fn(async () => 0),
}));

vi.mock("../db/account-erasure-processing.ts", () => ({
  deleteExpiredAccountErasurePreparations: mocks.deleteExpiredPreparations,
  listPendingAccountErasureRequests: mocks.listPending,
  markAccountErasureDispatched: mocks.markDispatched,
  markOverdueAccountErasureRequests: mocks.markOverdue,
}));

vi.mock("./queues.ts", () => ({
  enqueueAccountErasure: mocks.enqueue,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
  },
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/node";
import {
  dispatchAccountErasureOutbox,
  startAccountErasureOutboxDispatcher,
} from "./account-erasure-outbox.ts";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("account-erasure outbox", () => {
  it("enqueues each due request before marking its durable row dispatched", async () => {
    const database = { execute: vi.fn(async () => []) };
    const queue = { add: vi.fn(async () => undefined) };

    await expect(dispatchAccountErasureOutbox(database, queue)).resolves.toBe(2);

    expect(mocks.deleteExpiredPreparations).toHaveBeenCalledWith(database, 100);
    expect(mocks.enqueue).toHaveBeenNthCalledWith(
      1,
      { id: "10000000-0000-4000-8000-000000001994" },
      queue,
    );
    expect(mocks.markDispatched).toHaveBeenNthCalledWith(
      1,
      database,
      "10000000-0000-4000-8000-000000001994",
    );
    expect(mocks.enqueue).toHaveBeenNthCalledWith(
      2,
      { id: "20000000-0000-4000-8000-000000001994" },
      queue,
    );
  });

  it("reports dispatcher failures without emitting account identifiers", async () => {
    const sensitiveError = new Error(
      "queue failed for person@example.test request 10000000-0000-4000-8000-000000001994",
    );
    mocks.listPending.mockRejectedValueOnce(sensitiveError);
    const dispatcher = startAccountErasureOutboxDispatcher(
      { execute: vi.fn(async () => []) },
      { add: vi.fn(async () => undefined) },
      60_000,
    );

    await vi.waitFor(() => {
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Account erasure outbox dispatch failed",
        }),
        {
          tags: {
            errorName: "Error",
            source: "account-erasure-outbox",
          },
        },
      );
    });
    expect(mocks.loggerError).toHaveBeenCalledWith("[account-erasure-outbox] Dispatch failed");
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain("person@example.test");
    expect(JSON.stringify(vi.mocked(Sentry.captureException).mock.calls)).not.toContain(
      "10000000-0000-4000-8000-000000001994",
    );

    await dispatcher.close();
  });
});
