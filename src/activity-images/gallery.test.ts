import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { consolidateActivityImageCopies } from "./gallery.ts";

const scene = Buffer.from(`<svg width="1024" height="768" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sky"><stop stop-color="#123754"/><stop offset="1" stop-color="#bdac79"/></linearGradient>
    <radialGradient id="sun"><stop stop-color="#f7e5a2"/><stop offset="1" stop-color="#bdac79"/></radialGradient>
  </defs>
  <rect width="1024" height="768" fill="url(#sky)"/>
  <circle cx="700" cy="240" r="160" fill="url(#sun)"/>
  <path d="M0 650 Q260 250 520 580 T1024 450 V768 H0Z" fill="#30513f"/>
  <path d="M0 720 Q220 410 650 650 T1024 610 V768 H0Z" fill="#53734c"/>
</svg>`);

function image(objectKey: string, providerId: string, width = 1024, height = 768) {
  return {
    id: objectKey,
    objectKey,
    width,
    height,
    mimeType: objectKey.endsWith("jpg") ? "image/jpeg" : "image/png",
    sizeBytes: 100,
    sources: [{ providerId, sourceId: `${objectKey}-source` }],
  };
}

describe("activity gallery image copies", () => {
  let png: Buffer;
  let jpeg: Buffer;
  let resized: Buffer;
  let changed: Buffer;
  beforeAll(async () => {
    png = await sharp(scene).png().toBuffer();
    jpeg = await sharp(png).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
    resized = await sharp(png).resize(512, 384).png().toBuffer();
    changed = await sharp(png)
      .composite([
        {
          input: Buffer.from(
            '<svg width="60" height="60"><rect width="60" height="60" fill="red"/></svg>',
          ),
          left: 500,
          top: 300,
        },
      ])
      .png()
      .toBuffer();
  });

  it("shows a PNG and its cross-provider JPEG copy once with every source", async () => {
    const original = image("original.png", "peloton");
    const copy = image("copy.jpg", "strava");
    const read = vi.fn(async (key: string) => (key === "original.png" ? png : jpeg));
    const result = await consolidateActivityImageCopies([copy, original], read);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("original.png");
    expect(result[0]?.sources).toEqual([copy.sources[0], original.sources[0]]);
    expect(copy.sources).toHaveLength(1);
  });

  it("keeps the larger copy in the original gallery position", async () => {
    const small = image("small.png", "strava", 512, 384);
    const other = image("other.png", "strava");
    const large = image("large.png", "peloton");
    const read = async (key: string) =>
      ({ "small.png": resized, "large.png": png, "other.png": changed })[key] ?? png;
    const result = await consolidateActivityImageCopies([small, other, large], read);

    expect(result.map((entry) => entry.id)).toEqual(["large.png", "other.png"]);
    expect(result[0]?.sources).toEqual([small.sources[0], large.sources[0]]);
  });

  it("keeps photos with a visible local difference separate", async () => {
    const images = [image("original.png", "peloton"), image("changed.png", "strava")];
    const result = await consolidateActivityImageCopies(images, async (key) =>
      key === "original.png" ? png : changed,
    );
    expect(result.map((entry) => entry.id)).toEqual(["original.png", "changed.png"]);
  });

  it("preserves separate photos from one provider without reading their originals", async () => {
    const images = [image("first.png", "strava"), image("second.png", "strava")];
    const read = vi.fn(async () => png);
    expect(await consolidateActivityImageCopies(images, read)).toEqual(images);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not group another photo from a provider already represented in the group", async () => {
    const images = [
      image("first.png", "strava"),
      image("copy.png", "peloton"),
      image("second.png", "strava"),
    ];
    const result = await consolidateActivityImageCopies(images, async () => png);
    expect(result).toHaveLength(2);
    expect(result[0]?.sources.map((source) => source.providerId)).toEqual(["strava", "peloton"]);
    expect(result[1]?.id).toBe("second.png");
  });

  it("does not read originals when there is no comparable cross-provider pair", async () => {
    const read = vi.fn(async () => png);
    const lone = image("one.png", "peloton");
    const single = [lone];
    expect(await consolidateActivityImageCopies([], read)).toEqual([]);
    expect(await consolidateActivityImageCopies(single, read)).toEqual(single);
    const images = [lone, image("portrait.png", "strava", 768, 1024)];
    expect(await consolidateActivityImageCopies(images, read)).toEqual(images);
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves animations even when their first frame matches a static image", async () => {
    const frames = Buffer.from([255, 0, 0, 0, 0, 255]);
    const animated = await sharp(frames, {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    })
      .gif({ delay: [100, 100] })
      .toBuffer();
    const still = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const images = [image("animation.gif", "strava", 1, 1), image("still.png", "peloton", 1, 1)];
    expect(
      await consolidateActivityImageCopies(images, async (key) =>
        key === "animation.gif" ? animated : still,
      ),
    ).toEqual(images);
  });

  it("reuses prepared originals within one gallery read", async () => {
    const images = [
      image("first.png", "peloton"),
      image("changed.png", "garmin"),
      image("copy.jpg", "strava"),
    ];
    const read = vi.fn(async (key: string) =>
      key === "first.png" ? png : key === "changed.png" ? changed : jpeg,
    );
    const result = await consolidateActivityImageCopies(images, read);
    expect(result).toHaveLength(2);
    expect(read.mock.calls.map(([key]) => key).sort()).toEqual([
      "changed.png",
      "copy.jpg",
      "first.png",
    ]);
  });

  it("propagates unavailable or invalid originals", async () => {
    const images = [image("first.png", "peloton"), image("second.jpg", "strava")];
    await expect(
      consolidateActivityImageCopies(images, async () => {
        throw new Error("Media storage unavailable");
      }),
    ).rejects.toThrow("Media storage unavailable");
    await expect(
      consolidateActivityImageCopies(images, async () => Buffer.from("invalid image")),
    ).rejects.toThrow();
  });
});
