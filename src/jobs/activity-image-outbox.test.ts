import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.ts";

const mocks = vi.hoisted(() => ({
  pending: vi.fn(),
  mark: vi.fn(),
  fence: vi.fn(),
  Fenced: class Fenced extends Error {},
}));
vi.mock("../db/activity-images.ts", () => ({
  listPendingActivityImageWork: mocks.pending,
  markActivityImageDispatched: mocks.mark,
  reconcileActivityImageWork: vi.fn(),
}));
vi.mock("../db/account-erasure.ts", () => ({
  AccountErasureUserFencedError: mocks.Fenced,
  withAccountErasureUserWriteFence: mocks.fence,
}));

import { dispatchActivityImageOutbox } from "./activity-image-outbox.ts";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fence.mockImplementation(
    async (db: unknown, _user: string, operation: (tx: unknown) => Promise<void>) => operation(db),
  );
});
const db = { execute: vi.fn(async () => []), transaction: vi.fn() } satisfies Pick<
  Database,
  "execute" | "transaction"
>;
describe("activity image durable outbox", () => {
  it("replays the same logical work after Redis fails without acknowledging it", async () => {
    mocks.pending.mockResolvedValue([{ id: "work", userId: "owner" }]);
    const queue = {
      add: vi.fn().mockRejectedValueOnce(Error("Redis down")).mockResolvedValueOnce({}),
    };
    await expect(dispatchActivityImageOutbox(db, queue)).rejects.toThrow("Redis down");
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(await dispatchActivityImageOutbox(db, queue)).toBe(1);
    expect(queue.add.mock.calls[0]?.[2].jobId).toBe(queue.add.mock.calls[1]?.[2].jobId);
    expect(mocks.mark).toHaveBeenCalledOnce();
  });
  it("does not starve another account when erasure has fenced the first", async () => {
    mocks.pending.mockResolvedValue([
      { id: "erased", userId: "erased-owner" },
      { id: "live", userId: "live-owner" },
    ]);
    mocks.fence.mockRejectedValueOnce(new mocks.Fenced());
    const queue = { add: vi.fn(async () => ({})) };
    expect(await dispatchActivityImageOutbox(db, queue)).toBe(1);
    expect(queue.add).toHaveBeenCalledWith(
      "acquire",
      { workId: "live", userId: "live-owner" },
      expect.any(Object),
    );
  });
});

it("does not retain a failed Redis ID that would absorb durable dispatch again", async () => {
  mocks.pending.mockResolvedValue([{ id: "work", userId: "owner" }]);
  let launches = 0;
  const failed = new Set<string>();
  const queue = {
    add: vi.fn(
      async (
        _name: string,
        _data: unknown,
        options?: { jobId?: string; removeOnFail?: unknown },
      ) => {
        const id = options?.jobId ?? "";
        if (!failed.has(id)) {
          launches++;
          if (options?.removeOnFail !== true) failed.add(id);
        }
        return {};
      },
    ),
  };
  await dispatchActivityImageOutbox(db, queue);
  await dispatchActivityImageOutbox(db, queue);
  expect(launches).toBe(2);
});

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

it("reconciles periodically and stops polling when closed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20"));
  mocks.pending.mockResolvedValue([]);
  const { startActivityImageOutboxDispatcher } = await import("./activity-image-outbox.ts");
  const { reconcileActivityImageWork } = await import("../db/activity-images.ts");
  const reconcile = vi.fn(async () => undefined),
    backfill = vi.fn(async () => undefined);
  const dispatcher = startActivityImageOutboxDispatcher(db, { add: vi.fn() }, reconcile, backfill);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcileActivityImageWork).toHaveBeenCalledWith(db);
    expect(backfill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4999);
    expect(backfill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(295000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await dispatcher.close();
    const count = backfill.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(backfill).toHaveBeenCalledTimes(count);
  } finally {
    await dispatcher.close();
    vi.useRealTimers();
  }
});
it("does not overlap polls and waits for in-flight work on close", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20"));
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  mocks.pending.mockImplementation(async () => {
    await pending;
    return [];
  });
  const { startActivityImageOutboxDispatcher } = await import("./activity-image-outbox.ts");
  const backfill = vi.fn(async () => undefined);
  const dispatcher = startActivityImageOutboxDispatcher(
    db,
    { add: vi.fn() },
    async () => {},
    backfill,
  );
  try {
    await vi.advanceTimersByTimeAsync(20000);
    expect(mocks.pending).toHaveBeenCalledOnce();
    let closed = false;
    const closing = dispatcher.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(closed).toBe(true);
    expect(backfill).toHaveBeenCalledOnce();
  } finally {
    finish();
    await dispatcher.close();
    vi.useRealTimers();
    mocks.pending.mockReset();
  }
});
it("reports a polling failure and recovers on the next tick", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20"));
  const error = Error("database down");
  mocks.pending.mockRejectedValueOnce(error).mockResolvedValue([]);
  const { startActivityImageOutboxDispatcher } = await import("./activity-image-outbox.ts");
  const { captureException } = await import("../lib/error-reporting.ts");
  const backfill = vi.fn(async () => undefined);
  const dispatcher = startActivityImageOutboxDispatcher(
    db,
    { add: vi.fn() },
    async () => {},
    backfill,
  );
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { source: "activity-image-outbox" },
    });
    expect(backfill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(backfill).toHaveBeenCalledTimes(2);
  } finally {
    await dispatcher.close();
    vi.useRealTimers();
  }
});

it("dispatches acquisitions and backfills during a cleanup outage without polling R2 every tick", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20"));
  mocks.pending.mockResolvedValue([{ id: "work", userId: "owner" }]);
  const { startActivityImageOutboxDispatcher } = await import("./activity-image-outbox.ts");
  const reconcile = vi.fn().mockRejectedValue(Error("R2 unavailable"));
  const queue = { add: vi.fn(async () => undefined) };
  const backfill = vi.fn(async () => undefined);
  const dispatcher = startActivityImageOutboxDispatcher(db, queue, reconcile, backfill);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.add).toHaveBeenCalledOnce();
    expect(backfill).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(backfill).toHaveBeenCalledTimes(2);
  } finally {
    await dispatcher.close();
    vi.useRealTimers();
  }
});
