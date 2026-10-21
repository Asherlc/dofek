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
  runQueuedUserWorkUnlessAccountErasing: mocks.guard,
}));
const pool: AccountErasureWorkLockPool = {
  close: async () => {},
  runWithSharedUserLock: async (_user, work) => work(),
};
const owner = "00000000-0000-4000-8000-000000000001";
const key = `images/${owner}/${"a".repeat(64)}`;
const old = new Date(Date.now() - 2 * 86400000);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockReset();
  mocks.guard.mockImplementation(async (_pool, _db, _owner, _kind, work: () => Promise<unknown>) =>
    work(),
  );
});
it("deletes an old unreferenced object under the user's erasure guard and object lock", async () => {
  const { db, spies } = createMockDatabase();
  mocks.send
    .mockResolvedValueOnce({ Contents: [{ Key: key, LastModified: old }] })
    .mockResolvedValueOnce({});
  await createActivityImageReconciler(db, pool)();
  expect(mocks.guard).toHaveBeenCalledWith(
    pool,
    db,
    owner,
    "activity image cleanup",
    expect.any(Function),
  );
  expect(spies.execute).toHaveBeenCalledTimes(4);
  expect(mocks.send).toHaveBeenNthCalledWith(
    2,
    expect.any(DeleteObjectCommand),
    expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
  );
  expect(mocks.send.mock.calls[1]?.[0].input).toEqual({ Bucket: "private-media", Key: key });
  expect(mocks.destroy).toHaveBeenCalledOnce();
});
it.each(["referenced", "acquiring"])("preserves an object while it is %s", async (state) => {
  const { db, spies } = createMockDatabase();
  spies.execute
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(state === "referenced" ? [{ id: "reference" }] : [])
    .mockResolvedValueOnce([{ id: "work" }]);
  mocks.send.mockResolvedValue({ Contents: [{ Key: key, LastModified: old }] });
  await createActivityImageReconciler(db, pool)();
  expect(mocks.send).toHaveBeenCalledOnce();
  expect(spies.execute).toHaveBeenCalledTimes(state === "referenced" ? 2 : 3);
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
