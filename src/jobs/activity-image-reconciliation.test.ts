import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, expect, it, vi } from "vitest";
import { createMockDatabase } from "../providers/test-helpers.ts";
import type { AccountErasureWorkLockPool } from "./account-erasure-work-guard.ts";
import { createActivityImageReconciler } from "./activity-image-reconciliation.ts";

const mocks = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn(), guard: vi.fn() }));
vi.mock("../r2-storage.ts", () => ({
  createR2Client: () => ({ send: mocks.send, destroy: mocks.destroy }),
  requiredR2EnvironmentVariable: () => "private-media",
}));
vi.mock("./account-erasure-work-guard.ts", () => ({
  accountErasureAllowsQueuedUserWork: mocks.guard,
}));
const pool: AccountErasureWorkLockPool = {
  close: async () => {},
  runWithSharedUserLock: async (_user, work) => work(),
  tryRunWithExclusiveUserLock: vi.fn(async (_user, work) => work()),
};
const owner = "00000000-0000-4000-8000-000000000001";
const key = `images/${owner}/${"a".repeat(64)}`;
const old = new Date(Date.now() - 2 * 86400000);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockReset();
  mocks.guard.mockResolvedValue(true);
});
it("deletes an old unreferenced object under an exclusive user session barrier", async () => {
  const { db, spies } = createMockDatabase();
  const transaction = vi.spyOn(db, "transaction");
  mocks.send
    .mockResolvedValueOnce({ Contents: [{ Key: key, LastModified: old }] })
    .mockResolvedValueOnce({});
  await createActivityImageReconciler(db, pool)();
  expect(mocks.guard).toHaveBeenCalledWith(db, owner, "activity image cleanup");
  expect(pool.tryRunWithExclusiveUserLock).toHaveBeenCalledWith(owner, expect.any(Function));
  expect(spies.execute).toHaveBeenCalledTimes(3);
  expect(mocks.send).toHaveBeenNthCalledWith(
    2,
    expect.any(DeleteObjectCommand),
    expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
  );
  expect(mocks.send.mock.calls[1]?.[0].input).toEqual({ Bucket: "private-media", Key: key });
  expect(transaction).not.toHaveBeenCalled();
  expect(mocks.destroy).toHaveBeenCalledOnce();
});
it.each(["referenced", "acquiring"])("preserves an object while it is %s", async (state) => {
  const { db, spies } = createMockDatabase();
  spies.execute
    .mockResolvedValueOnce(state === "referenced" ? [{ id: "reference" }] : [])
    .mockResolvedValueOnce([{ id: "work" }]);
  mocks.send.mockResolvedValue({ Contents: [{ Key: key, LastModified: old }] });
  await createActivityImageReconciler(db, pool)();
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(spies.execute).toHaveBeenCalledTimes(state === "referenced" ? 1 : 2);
});
it("skips recent, malformed and incomplete object metadata without querying ownership", async () => {
  const { db, spies } = createMockDatabase();
  mocks.send.mockResolvedValue({
    Contents: [
      {},
      { Key: key },
      { Key: key, LastModified: new Date() },
      { Key: `images/not-a-user/${"a".repeat(64)}`, LastModified: old },
      { Key: `images/000/${"a".repeat(64)}`, LastModified: old },
    ],
  });
  await createActivityImageReconciler(db, pool)();
  expect(mocks.guard).not.toHaveBeenCalled();
  expect(spies.execute).not.toHaveBeenCalled();
});
it("resumes one bounded page per pass and restarts after the last page", async () => {
  const { db } = createMockDatabase();
  mocks.send
    .mockResolvedValueOnce({ IsTruncated: true, NextContinuationToken: "next" })
    .mockResolvedValueOnce({ IsTruncated: false })
    .mockResolvedValueOnce({});
  const reconcile = createActivityImageReconciler(db, pool);
  await reconcile();
  await reconcile();
  await reconcile();
  expect(mocks.send.mock.calls.map((call) => call[0].input)).toEqual([
    { Bucket: "private-media", Prefix: "images/", MaxKeys: 100, ContinuationToken: undefined },
    { Bucket: "private-media", Prefix: "images/", MaxKeys: 100, ContinuationToken: "next" },
    { Bucket: "private-media", Prefix: "images/", MaxKeys: 100, ContinuationToken: undefined },
  ]);
  expect(mocks.destroy).toHaveBeenCalledTimes(3);
});
it("rejects incomplete listings and always releases the S3 client", async () => {
  const { db } = createMockDatabase();
  mocks.send.mockResolvedValueOnce({ IsTruncated: true });
  await expect(createActivityImageReconciler(db, pool)()).rejects.toThrow(
    "Incomplete image reconciliation listing",
  );
  expect(mocks.destroy).toHaveBeenCalledOnce();
  mocks.send.mockRejectedValueOnce(Error("S3 offline"));
  await expect(createActivityImageReconciler(db, pool)()).rejects.toThrow("S3 offline");
  expect(mocks.destroy).toHaveBeenCalledTimes(2);
});

it("skips erased accounts and leaves metadata intact when object deletion fails", async () => {
  const { db, spies } = createMockDatabase();
  mocks.guard.mockResolvedValueOnce(false);
  mocks.send.mockResolvedValueOnce({ Contents: [{ Key: key, LastModified: old }] });
  await createActivityImageReconciler(db, pool)();
  expect(spies.execute).not.toHaveBeenCalled();
  expect(mocks.send).toHaveBeenCalledOnce();
  mocks.send
    .mockResolvedValueOnce({ Contents: [{ Key: key, LastModified: old }] })
    .mockRejectedValueOnce(Error("delete failed"));
  await expect(createActivityImageReconciler(db, pool)()).rejects.toThrow("delete failed");
  expect(spies.execute).toHaveBeenCalledTimes(2);
  expect(mocks.destroy).toHaveBeenCalledTimes(2);
});
