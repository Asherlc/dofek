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

it("does not retain a failed Redis ID that would absorb durable redispatch", async () => {
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
