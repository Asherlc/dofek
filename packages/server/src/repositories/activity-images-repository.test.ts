import { describe, expect, it, vi } from "vitest";
import { getOwnedActivityImages } from "./activity-images-repository.ts";

describe("owned activity image access", () => {
  it("does not query media or sign URLs before resolving visible owned members", async () => {
    const read = vi.fn(),
      sign = vi.fn();
    await expect(
      getOwnedActivityImages("unknown", { members: async () => null, read, sign }),
    ).rejects.toThrow("Activity not found");
    expect(read).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });
  it("displays one stored object while preserving all source associations", async () => {
    const sign = vi.fn(async () => "https://private.test/signed");
    const source = {
      activityId: "member",
      providerId: "strava",
      sourceId: "photo",
      kind: "photo",
      caption: "Original",
      position: 0,
    };
    const result = await getOwnedActivityImages("group", {
      members: async () => ["member"],
      read: async () => ({
        images: [
          {
            id: "object",
            objectKey: "images/owner/hash",
            width: 10,
            height: 20,
            mimeType: "image/png",
            sizeBytes: 30,
            sources: [source, { ...source, providerId: "peloton" }],
          },
        ],
        coverage: [],
        acquisition: [],
      }),
      sign,
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.sources).toHaveLength(2);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(result.images[0]).not.toHaveProperty("objectKey");
  });
});

it("does not read storage for an empty set of visible members", async () => {
  const { listActivityImages } = await import("./activity-images-repository.ts");
  const { createMockDatabase } = await import("../../../../../src/providers/test-helpers.ts");
  const { db, spies } = createMockDatabase();
  expect(await listActivityImages(db, { userId: "owner", memberActivityIds: [] })).toEqual({
    images: [],
    coverage: [],
    acquisition: [],
  });
  expect(spies.execute).not.toHaveBeenCalled();
});
it("parses stored media, discovery coverage and acquisition state together", async () => {
  const { listActivityImages } = await import("./activity-images-repository.ts");
  const { createMockDatabase } = await import("../../../../../src/providers/test-helpers.ts");
  const { db, spies } = createMockDatabase();
  const image = {
    id: "object",
    objectKey: "images/owner/hash",
    width: 10,
    height: 20,
    mimeType: "image/png",
    sizeBytes: "50",
    sources: [],
  };
  const coverage = {
    activityId: "member",
    providerId: "strava",
    coverage: "partial",
    reason: "gallery unavailable",
    expectedCount: 2,
  };
  const acquisition = {
    id: "work",
    state: "retryable_failure",
    errorCode: "image_http_429",
    attempts: 1,
  };
  spies.execute
    .mockResolvedValueOnce([image])
    .mockResolvedValueOnce([coverage])
    .mockResolvedValueOnce([acquisition]);
  expect(
    await listActivityImages(db, {
      userId: "owner",
      memberActivityIds: ["member", "other-member"],
    }),
  ).toEqual({
    images: [{ ...image, sizeBytes: 50 }],
    coverage: [coverage],
    acquisition: [acquisition],
  });
  expect(spies.execute).toHaveBeenCalledTimes(3);
});
