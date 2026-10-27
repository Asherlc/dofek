import { captureException } from "dofek/lib/error-reporting";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

import { getOwnedActivityImages } from "./activity-images-repository.ts";

describe("owned activity image access", () => {
  it("does not query media or sign URLs before resolving visible owned members", async () => {
    const read = vi.fn(),
      sign = vi.fn();
    await expect(
      getOwnedActivityImages("unknown", {
        members: async () => null,
        read,
        sign,
        readImage: vi.fn(),
      }),
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
      readImage: vi.fn(),
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.sources).toHaveLength(2);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(result.images[0]).not.toHaveProperty("objectKey");
  });
  it("shows one photo for PNG and JPEG provider copies while retaining both sources", async () => {
    const original = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#446688" },
    })
      .png()
      .toBuffer();
    const exported = await sharp(original).jpeg({ quality: 90 }).toBuffer();
    const source = {
      activityId: "peloton-ride",
      providerId: "peloton",
      sourceId: "cover",
      kind: "class_artwork",
      caption: "Ride",
      position: 0,
    };
    const sign = vi.fn(async (key: string) => `https://private.test/${key}`);
    const result = await getOwnedActivityImages("group", {
      members: async () => ["peloton-ride", "strava-ride"],
      read: async () => ({
        images: [
          {
            id: "original",
            objectKey: "original",
            width: 64,
            height: 64,
            mimeType: "image/png",
            sizeBytes: original.length,
            sources: [source],
          },
          {
            id: "exported",
            objectKey: "exported",
            width: 64,
            height: 64,
            mimeType: "image/jpeg",
            sizeBytes: exported.length,
            sources: [
              {
                ...source,
                activityId: "strava-ride",
                providerId: "strava",
                sourceId: "photo",
                kind: "photo",
              },
            ],
          },
        ],
        coverage: [],
        acquisition: [],
      }),
      sign,
      readImage: async (key: string) => (key === "original" ? original : exported),
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.sources.map((item) => item.providerId)).toEqual(["peloton", "strava"]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(result.images[0]).not.toHaveProperty("objectKey");
  });
  it("returns an actionable error when stored photos cannot be signed", async () => {
    const failure = new Error("R2 unavailable");
    await expect(
      getOwnedActivityImages("group", {
        members: async () => ["member"],
        read: async () => ({
          images: [
            {
              id: "image",
              objectKey: "private",
              width: 1,
              height: 1,
              mimeType: "image/png",
              sizeBytes: 1,
              sources: [],
            },
          ],
          coverage: [],
          acquisition: [],
        }),
        readImage: vi.fn(),
        sign: async () => {
          throw failure;
        },
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Stored activity photos could not be loaded. Refresh photos to retry.",
      cause: expect.objectContaining({ message: "R2 unavailable" }),
    });
    expect(captureException).toHaveBeenCalledWith(failure, {
      tags: { context: "activity-photos" },
    });
  });
});

it("does not read storage for an empty set of visible members", async () => {
  const { listActivityImages } = await import("./activity-images-repository.ts");
  const { createMockDatabase } = await import("../../../../src/providers/test-helpers.ts");
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
  const { createMockDatabase } = await import("../../../../src/providers/test-helpers.ts");
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

it("reports an actionable ascent-photo signing failure", async () => {
  const { signStoredImages } = await import("./activity-images-repository.ts");
  const failure = new Error("Object storage is unavailable");
  await expect(
    signStoredImages(
      {
        images: [
          {
            id: "stored",
            objectKey: "private/ascent",
            width: 1,
            height: 1,
            mimeType: "image/png",
            sizeBytes: 1,
            sources: [
              {
                activityId: null,
                climbingLogEntryId: "log",
                providerId: "kaya",
                sourceId: "photo",
                kind: "photo",
                caption: null,
                position: 0,
              },
            ],
          },
        ],
        coverage: [],
        acquisition: [],
      },
      {
        sign: async () => {
          throw failure;
        },
        readImage: vi.fn(),
      },
      "climbing",
    ),
  ).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "Stored ascent photos could not be loaded. Refresh photos to retry.",
  });
  expect(captureException).toHaveBeenCalledWith(failure, { tags: { context: "climbing-photos" } });
});
