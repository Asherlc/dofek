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
