import { describe, expect, it, vi } from "vitest";
import { pelotonImageDiscovery, stravaImageDiscovery } from "./providers.ts";

describe("provider image discovery", () => {
  it("keeps Peloton artwork and every distinct extra image", () => {
    const result = pelotonImageDiscovery({
      ride: {
        id: "ride",
        title: "Class",
        image_url: "https://cdn.test/cover",
        extra_images: [
          "https://cdn.test/extra1",
          { id: "extra2", image_url: "https://cdn.test/extra2" },
        ],
      },
    });
    expect(result.images).toHaveLength(3);
    expect(result.images.map((i) => i.kind)).toEqual([
      "class_artwork",
      "class_artwork",
      "class_artwork",
    ]);
  });
  it("reports unknown extra image payloads as partial", () =>
    expect(
      pelotonImageDiscovery({ ride: { id: "ride", extra_images: [{ unrecognized: true }] } })
        .coverage,
    ).toBe("partial"));
  it("keeps gallery images instead of only the primary", () => {
    const result = stravaImageDiscovery(
      [
        {
          unique_id: "one",
          urls: { 100: "https://cdn.test/one-small", 2048: "https://cdn.test/one-large" },
        },
        { unique_id: "two", urls: { 2048: "https://cdn.test/two" } },
        { unique_id: "three", urls: { 2048: "https://cdn.test/three" } },
      ],
      3,
      true,
    );
    expect(result.coverage).toBe("complete");
    expect(result.images).toHaveLength(3);
    expect(result.images[0]?.variants).toHaveLength(2);
  });
  it("keeps all source records and reports incomplete gallery pagination", () => {
    expect(
      stravaImageDiscovery([{ unique_id: "one", urls: { 100: "https://cdn.test/one" } }], 3, false)
        .coverage,
    ).toBe("partial");
    expect(stravaImageDiscovery([], 0, true).coverage).toBe("complete");
    expect(stravaImageDiscovery([], null, false).coverage).toBe("partial");
  });
  it("excludes videos without substituting their cover for a photograph", () =>
    expect(
      stravaImageDiscovery(
        [{ unique_id: "video", media_type: 2, urls: { 100: "https://cdn.test/video" } }],
        1,
        true,
      ).images,
    ).toHaveLength(0));
});

it("preserves evidenced Zwift primary images and reports unknown snapshot structures", async () => {
  const { zwiftImageDiscovery } = await import("./providers.ts");
  const result = zwiftImageDiscovery({
    primaryImageUrl: "https://cdn.test/ride.png",
    snapshotThumbnails: [{ unknown: true }],
  });
  expect(result.images).toHaveLength(1);
  expect(result.images[0]?.kind).toBe("screenshot");
  expect(result.coverage).toBe("partial");
});

it("paginates full Strava galleries and preserves the primary when a later page fails", async () => {
  const { fetchStravaActivityImages } = await import("./providers.ts");
  const first = Array.from({ length: 200 }, (_, position) => ({
    unique_id: String(position),
    urls: { 4096: `https://cdn.test/${position}` },
  }));
  const fetchPage = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockRejectedValueOnce(Error("rate limited"));
  const result = await fetchStravaActivityImages(fetchPage, 201, {
    unique_id: "last",
    urls: { 100: "https://cdn.test/last" },
  });
  expect(result.coverage).toBe("partial");
  expect(result.images).toHaveLength(201);
  expect(fetchPage).toHaveBeenCalledTimes(2);
});
it("merges gallery and primary variants without replacing high resolution copies", async () => {
  const { fetchStravaActivityImages } = await import("./providers.ts");
  const result = await fetchStravaActivityImages(
    async () => [{ unique_id: "same", urls: { 4096: "https://cdn.test/full" } }],
    1,
    { unique_id: "same", urls: { 100: "https://cdn.test/thumb" } },
  );
  expect(result.images).toHaveLength(1);
  expect(result.images[0]?.variants).toHaveLength(2);
  expect(result.coverage).toBe("complete");
});
it("detects repeated Strava pages instead of looping indefinitely", async () => {
  const { fetchStravaActivityImages } = await import("./providers.ts");
  const page = Array.from({ length: 200 }, (_, position) => ({
    unique_id: String(position),
    urls: { 4096: `https://cdn.test/${position}` },
  }));
  const fetchPage = vi.fn(async () => page);
  const result = await fetchStravaActivityImages(fetchPage, 400);
  expect(result.coverage).toBe("partial");
  expect(fetchPage).toHaveBeenCalledTimes(2);
});

describe("discovery retry classification", () => {
  it("keeps a provider Retry-After and treats historical missing records as unavailable", async () => {
    const { imageDiscoveryFailure } = await import("./providers.ts");
    expect(imageDiscoveryFailure({ statusCode: 429, retryAfterSeconds: 900 })).toMatchObject({
      retryable: true,
      retryAfterSeconds: 900,
    });
    expect(imageDiscoveryFailure({ statusCode: 404, retryAfterSeconds: null })).toEqual({
      coverage: "unavailable",
      retryable: false,
    });
  });
});

it("preserves source identity, dimensions, captions and ordering across gallery variants", () => {
  const photo = {
    id: 42,
    caption: "Summit",
    urls: { large: "https://cdn.test/large", 100: "https://cdn.test/small" },
    sizes: { large: [600, 400] },
  };
  const result = stravaImageDiscovery(
    [photo, { urls: { custom: "https://cdn.test/other" } }, { unique_id: "empty", urls: {} }, null],
    2,
    true,
  );
  expect(result).toMatchObject({
    coverage: "partial",
    reason: "gallery_incomplete",
    expectedCount: 2,
    images: [
      { sourceId: "42", caption: "Summit", position: 0, revision: null, raw: photo },
      { position: 1, caption: null },
    ],
  });
  expect(result.images[0]?.variants).toEqual([
    { url: "https://cdn.test/small", width: 100, height: 100 },
    { url: "https://cdn.test/large", width: 600, height: 400 },
  ]);
  expect(result.images[1]?.variants[0]).toMatchObject({ width: null, height: null });
});
it("requires the expected number of unique images before claiming complete coverage", () => {
  const photo = { unique_id: "one", urls: { 100: "https://cdn.test/one" } };
  expect(stravaImageDiscovery([photo, photo], 2, true).coverage).toBe("partial");
  expect(stravaImageDiscovery([photo], 1, true)).toMatchObject({
    coverage: "complete",
    reason: null,
  });
  expect(stravaImageDiscovery([photo], null, true).coverage).toBe("complete");
  expect(
    stravaImageDiscovery([{ media_type: 1, urls: { 100: "https://cdn.test/photo" } }], 1, true)
      .images,
  ).toHaveLength(1);
});
it("preserves complete Peloton media metadata and explicit absence", () => {
  const result = pelotonImageDiscovery({
    ride: {
      id: "ride",
      title: "Class",
      image_url: "https://cdn.test/cover",
      extra_images: [
        { id: 0, image_url: "https://cdn.test/extra", width: 800, height: 600 },
        { image_url: "https://cdn.test/fallback" },
      ],
    },
  });
  expect(result).toMatchObject({
    coverage: "complete",
    reason: null,
    images: [
      {
        sourceId: "ride:cover",
        caption: "Class",
        position: 0,
        variants: [{ url: "https://cdn.test/cover", width: null, height: null }],
      },
      {
        sourceId: "ride:0",
        position: 1,
        variants: [{ url: "https://cdn.test/extra", width: 800, height: 600 }],
      },
      { position: 2, variants: [{ width: null, height: null }] },
    ],
  });
  expect(pelotonImageDiscovery({})).toEqual({
    coverage: "complete",
    expectedCount: 0,
    reason: null,
    images: [],
  });
  expect(pelotonImageDiscovery(null)).toMatchObject({ coverage: "failed", images: [] });
  expect(pelotonImageDiscovery({ ride: { id: "ride" } })).toMatchObject({
    coverage: "complete",
    images: [],
  });
});
it.each([
  { statusCode: 500 },
  { status: 503 },
  { statusCode: 429 },
  { statusCode: 408 },
  { statusCode: 400 },
  { statusCode: 401 },
  { statusCode: 410 },
  { name: "StravaNotFoundError" },
  Error("offline"),
])("classifies discovery failures (%j)", async (error) => {
  const { imageDiscoveryFailure } = await import("./providers.ts");
  const status =
    "statusCode" in error ? error.statusCode : "status" in error ? error.status : undefined;
  const unavailable = status === 410 || ("name" in error && error.name === "StravaNotFoundError");
  const retryable = !unavailable && (status === undefined || status === 429 || status >= 500);
  expect(imageDiscoveryFailure(error)).toEqual({
    coverage: unavailable ? "unavailable" : "failed",
    retryable,
    ...(retryable ? { retryAfterSeconds: 300 } : {}),
  });
});
it("rejects malformed provider metadata without retrying and clamps retry deadlines", async () => {
  const { imageDiscoveryFailure, zwiftImageDiscovery, fetchStravaActivityImages } = await import(
    "./providers.ts"
  );
  const { z } = await import("zod");
  expect(imageDiscoveryFailure(new z.ZodError([]))).toEqual({
    coverage: "failed",
    retryable: false,
  });
  expect(imageDiscoveryFailure({ statusCode: 429, retryAfterSeconds: -1 })).toMatchObject({
    retryAfterSeconds: 1,
  });
  expect(zwiftImageDiscovery(null)).toMatchObject({ coverage: "failed", images: [] });
  expect(zwiftImageDiscovery({})).toMatchObject({ coverage: "partial", images: [] });
  const result = await fetchStravaActivityImages(async () => {
    throw { statusCode: 429, retryAfterSeconds: 800 };
  }, 1);
  expect(result).toMatchObject({
    coverage: "partial",
    retryable: true,
    retryAfterSeconds: 800,
    images: [],
  });
});

vi.mock("../providers/index.ts", () => ({ getProvider: vi.fn() }));
vi.mock("../db/activity-images.ts", () => ({
  recordActivityImageDiscovery: vi.fn(async () => undefined),
  recordClimbingImageDiscovery: vi.fn(async () => undefined),
}));

it("records supported, unsupported, and failed discoveries with their owner", async () => {
  const { getProvider } = await import("../providers/index.ts");
  const { recordActivityImageDiscovery } = await import("../db/activity-images.ts");
  const { discoverAndRecordActivityImages } = await import("./providers.ts");
  const { SyncRun } = await import("../providers/sync-run.ts");
  const { SyncWindow } = await import("../providers/sync-window.ts");
  const { createMockDatabase } = await import("../providers/test-helpers.ts");
  const { db } = createMockDatabase();
  const run = new SyncRun({
    db,
    userId: "owner",
    window: SyncWindow.fromSince({ since: new Date(0) }),
  });
  vi.mocked(getProvider).mockReturnValue(undefined);
  expect(await discoverAndRecordActivityImages(run, "activity", "external", "none")).toMatchObject({
    coverage: "unavailable",
    reason: "provider_media_not_verified",
  });
  const discover = vi.fn(async () => ({
    coverage: "complete" as const,
    expectedCount: 0,
    reason: null,
    images: [],
  }));
  vi.mocked(getProvider).mockReturnValue({
    id: "provider",
    name: "Provider",
    validate: () => null,
    sync: vi.fn(),
    discoverActivityImages: discover,
  });
  expect(
    await discoverAndRecordActivityImages(run, "activity", "external", "provider"),
  ).toMatchObject({ coverage: "complete" });
  expect(discover).toHaveBeenCalledWith(run, "external");
  expect(recordActivityImageDiscovery).toHaveBeenCalledWith(db, {
    userId: "owner",
    activityId: "activity",
    providerId: "provider",
    discovery: expect.objectContaining({ coverage: "complete" }),
  });
  discover.mockRejectedValueOnce(Error("offline"));
  expect(
    await discoverAndRecordActivityImages(run, "activity", "external", "provider"),
  ).toMatchObject({ coverage: "failed", retryable: true, reason: "provider_media_request_failed" });
  await expect(
    discoverAndRecordActivityImages(new SyncRun({ db, window: run.window }), "a", "e", "provider"),
  ).rejects.toThrow("explicit owner");
});
it.each(["activity", null])(
  "refreshes the matching image for owner %s through the corresponding provider lookup",
  async (activityId) => {
    const { getProvider } = await import("../providers/index.ts");
    const { refreshActivityImage } = await import("./providers.ts");
    const { recordClimbingImageDiscovery } = await import("../db/activity-images.ts");
    vi.mocked(recordClimbingImageDiscovery).mockClear();
    const { SyncRun } = await import("../providers/sync-run.ts");
    const { SyncWindow } = await import("../providers/sync-window.ts");
    const { createMockDatabase } = await import("../providers/test-helpers.ts");
    const { db } = createMockDatabase();
    const run = new SyncRun({
      db,
      userId: "owner",
      window: SyncWindow.fromSince({ since: new Date(0) }),
    });
    const image = {
      sourceId: "same",
      kind: "photo" as const,
      caption: null,
      position: 0,
      variants: [{ url: "https://cdn.test/fresh", width: 1, height: 1 }],
      revision: null,
      raw: {},
    };
    const work = {
      id: "work",
      userId: "owner",
      providerId: "provider",
      ...(activityId === null ? { activityId: null, climbingLogEntryId: "log" } : { activityId }),
      activityExternalId: "external",
      imageId: "image",
      generation: 1,
      candidate: { ...image, revision: "previous-photo" },
      attempts: 1,
    };
    const discover = vi.fn(async () => ({
      coverage: "complete" as const,
      expectedCount: 1,
      reason: null,
      images: [image],
    }));
    vi.mocked(getProvider).mockReturnValue({
      id: "provider",
      name: "Provider",
      validate: () => null,
      sync: vi.fn(),
      ...(activityId === null
        ? { discoverClimbingImages: discover }
        : { discoverActivityImages: discover }),
    });
    expect(await refreshActivityImage(run, work)).toEqual(image);
    expect(discover).toHaveBeenCalledWith(run, "external", { refresh: true });
    if (activityId === null)
      expect(recordClimbingImageDiscovery).toHaveBeenCalledWith(db, {
        userId: work.userId,
        climbingLogEntryId: "log",
        providerId: work.providerId,
        discovery: { coverage: "complete", expectedCount: 1, reason: null, images: [image] },
      });
    else expect(recordClimbingImageDiscovery).not.toHaveBeenCalled();
    discover.mockResolvedValueOnce({
      coverage: "complete",
      expectedCount: 0,
      reason: null,
      images: [],
    });
    await expect(refreshActivityImage(run, work)).rejects.toThrow("no longer exposed");
    if (activityId === null)
      expect(recordClimbingImageDiscovery).toHaveBeenLastCalledWith(db, {
        userId: work.userId,
        climbingLogEntryId: "log",
        providerId: work.providerId,
        discovery: { coverage: "complete", expectedCount: 0, reason: null, images: [] },
      });
    vi.mocked(getProvider).mockReturnValue(undefined);
    await expect(refreshActivityImage(run, work)).rejects.toThrow("refresh unavailable");
  },
);
