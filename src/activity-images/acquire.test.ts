import { beforeEach, expect, it, vi } from "vitest";
import { createMockDatabase } from "../providers/test-helpers.ts";
import { createActivityImageJobDependencies } from "./acquire.ts";
import type { ActivityImageWork } from "./types.ts";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  claim: vi.fn(),
  fail: vi.fn(),
  complete: vi.fn(),
  download: vi.fn(),
  refresh: vi.fn(),
  store: vi.fn(),
  cleanup: vi.fn(),
  bytes: vi.fn(),
}));
vi.mock("../db/activity-images.ts", () => ({
  loadActivityImageWork: mocks.load,
  claimActivityImageWork: mocks.claim,
  failActivityImageWork: mocks.fail,
  completeActivityImageWork: mocks.complete,
}));
vi.mock("./download.ts", () => ({ downloadActivityImage: mocks.download }));
vi.mock("./providers.ts", () => ({ refreshActivityImage: mocks.refresh }));
vi.mock("./storage.ts", () => ({
  activityImageObjectKey: () => "images/owner/hash",
  storeActivityImage: mocks.store,
}));
vi.mock("./metrics.ts", () => ({ activityImageBytes: { add: mocks.bytes } }));
const work: ActivityImageWork = {
  id: "work",
  userId: "owner",
  providerId: "strava",
  activityId: "activity",
  activityExternalId: "external",
  imageId: "image",
  generation: 1,
  attempts: 1,
  candidate: {
    sourceId: "source",
    kind: "photo",
    caption: null,
    position: 0,
    revision: null,
    raw: {},
    variants: [
      { url: "https://cdn.test/small", width: 1, height: 1 },
      { url: "https://cdn.test/full", width: 2, height: 2 },
      { url: "https://other.test/alternate", width: 1, height: 1 },
    ],
  },
};
const image = {
  filePath: "original",
  sha256: "a".repeat(64),
  sizeBytes: 20,
  mimeType: "image/png",
  width: 2,
  height: 2,
  cleanup: mocks.cleanup,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.download.mockResolvedValue(image);
  mocks.load.mockResolvedValue(work);
  mocks.store.mockResolvedValue({ objectKey: "images/owner/hash" });
  mocks.complete.mockResolvedValue(true);
});
it("uploads the largest original before its database transaction and removes the temporary file", async () => {
  const { db, spies } = createMockDatabase();
  const transaction = vi.spyOn(db, "transaction");
  const dependencies = createActivityImageJobDependencies(db);
  expect(await dependencies.acquire(work)).toEqual({ stored: true });
  expect(mocks.download).toHaveBeenCalledWith({
    url: "https://cdn.test/full",
    allowedOrigins: ["https://cdn.test", "https://other.test"],
  });
  expect(spies.execute).not.toHaveBeenCalled();
  expect(mocks.store.mock.invocationCallOrder[0]).toBeLessThan(
    transaction.mock.invocationCallOrder[0] ?? 0,
  );
  expect(mocks.load).toHaveBeenCalledWith(expect.anything(), "work", "owner");
  expect(mocks.store).toHaveBeenCalledWith({ userId: "owner", image });
  expect(mocks.complete).toHaveBeenCalledWith(expect.anything(), work, {
    ...image,
    objectKey: "images/owner/hash",
  });
  expect(mocks.bytes).toHaveBeenCalledWith(20, { provider: "strava" });
  expect(mocks.cleanup).toHaveBeenCalledOnce();
});
it("does not attach a work item retired during its upload", async () => {
  const { db } = createMockDatabase();
  mocks.load.mockResolvedValueOnce(null);
  expect(await createActivityImageJobDependencies(db).acquire(work)).toEqual({ stored: false });
  expect(mocks.store).toHaveBeenCalledOnce();
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.cleanup).toHaveBeenCalledOnce();
});
it("propagates storage errors and cleans the temporary original", async () => {
  const { db } = createMockDatabase();
  mocks.store.mockRejectedValueOnce(Error("S3 offline"));
  await expect(createActivityImageJobDependencies(db).acquire(work)).rejects.toThrow("S3 offline");
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.cleanup).toHaveBeenCalledOnce();
});
it("binds durable state and refreshed discovery to the same owner and database", async () => {
  const { db } = createMockDatabase();
  const deps = createActivityImageJobDependencies(db);
  await deps.load("work", "owner");
  await deps.claim(work);
  await deps.fail(work, true, "image_http_429", 600);
  await deps.refresh(work);
  expect(mocks.load).toHaveBeenCalledWith(db, "work", "owner");
  expect(mocks.claim).toHaveBeenCalledWith(db, work);
  expect(mocks.fail).toHaveBeenCalledWith(db, work, true, "image_http_429", 600);
  expect(mocks.refresh).toHaveBeenCalledWith(
    expect.objectContaining({ db, options: expect.objectContaining({ userId: "owner" }) }),
    work,
  );
});
