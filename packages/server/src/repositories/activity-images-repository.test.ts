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
