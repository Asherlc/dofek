import { describe, expect, it } from "vitest";
import { kayaImageDiscovery } from "./kaya-images.ts";

describe("KAYA ascent photo discovery", () => {
  it("selects the original with a stable ascent slot and retains raw photo metadata", () => {
    const photo = {
      photo_url: "https://cdn.test/full?X-Amz-Signature=one",
      thumb_url: "https://cdn.test/thumb",
    };
    const discovery = kayaImageDiscovery({ id: "123", photo });
    expect(discovery).toMatchObject({
      coverage: "complete",
      expectedCount: 1,
      images: [{ sourceId: "kaya:ascent:123:photo", kind: "photo", raw: { id: "123", photo } }],
    });
    expect(discovery.images[0]?.variants.map((v) => v.url)).toEqual([
      photo.photo_url,
      photo.thumb_url,
    ]);
    const rotated = kayaImageDiscovery({
      id: "123",
      photo: { ...photo, photo_url: "https://cdn.test/full?X-Amz-Signature=two" },
    });
    expect(rotated.images[0]?.revision).toBe(discovery.images[0]?.revision);
    const replaced = kayaImageDiscovery({
      id: "123",
      photo: { ...photo, photo_url: "https://cdn.test/replacement" },
    });
    expect(replaced.images[0]?.sourceId).toBe(discovery.images[0]?.sourceId);
    expect(replaced.images[0]?.revision).not.toBe(discovery.images[0]?.revision);
  });
  it("accepts explicit no-photo without interpreting video thumbnails as photos", () => {
    expect(
      kayaImageDiscovery({ id: "123", photo: null, video_thumbnail_url: "https://cdn.test/video" }),
    ).toEqual({ coverage: "complete", expectedCount: 0, reason: null, images: [] });
  });
  it.each([
    {},
    { photo: undefined },
    { photo: {} },
    { photo: { photo_url: 3 } },
    { photo: { photo_url: "bad-url" } },
    { photo: { photo_url: "https://cdn.test/full", thumb_url: 3 } },
  ])("keeps unknown or malformed media incomplete: %j", (fields) => {
    expect(kayaImageDiscovery({ id: "123", ...fields })).toMatchObject({
      coverage: "partial",
      images: [],
    });
  });
  it("can retain an explicitly available thumbnail when no original is reported", () => {
    const discovery = kayaImageDiscovery({
      id: "123",
      photo: { photo_url: null, thumb_url: "https://cdn.test/thumb" },
    });
    expect(discovery).toMatchObject({
      coverage: "complete",
      images: [{ variants: [{ url: "https://cdn.test/thumb" }] }],
    });
  });
});
