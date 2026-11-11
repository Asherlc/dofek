import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { consolidateActivityImageCopies } from "./gallery.ts";

const comparisonObserver = vi.hoisted(() => vi.fn<() => void>());
vi.mock("pixelmatch", async (importOriginal) => {
  const original = await importOriginal<typeof import("pixelmatch")>();
  return {
    default(...args: Parameters<typeof original.default>) {
      comparisonObserver();
      return original.default(...args);
    },
  };
});

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
  let webp: Buffer;
  let resized: Buffer;
  let changed: Buffer;
  beforeAll(async () => {
    png = await sharp(scene).png().toBuffer();
    jpeg = await sharp(png).jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
    webp = await sharp(png).webp({ lossless: true }).toBuffer();
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

  it("recognizes a JPEG export with ordinary compression and chroma subsampling", async () => {
    const exportBytes = await sharp(png)
      .jpeg({ quality: 85, chromaSubsampling: "4:2:0" })
      .toBuffer();
    const original = image("original.png", "peloton");
    const copy = image("export.jpg", "strava");
    const result = await consolidateActivityImageCopies([original, copy], async (key) =>
      key === "original.png" ? png : exportBytes,
    );
    expect(result.map((entry) => entry.id)).toEqual(["original.png"]);
    expect(result[0]?.sources).toEqual([...original.sources, ...copy.sources]);
  });

  it("recognizes a compressed JPEG copy of a textured full-size image", async () => {
    const width = 1920;
    const height = 1080;
    const pixels = Buffer.alloc(width * height * 3);
    let seed = 42;
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = (seed / 2 ** 32 - 0.5) * 80;
        const offset = (row * width + column) * 3;
        pixels[offset] = Math.max(0, Math.min(255, 105 + 65 * Math.sin(column / 72) + noise));
        pixels[offset + 1] = Math.max(0, Math.min(255, 115 + 50 * Math.cos(row / 100) + noise));
        pixels[offset + 2] = Math.max(
          0,
          Math.min(255, 125 + 50 * Math.sin((column + row) / 64) - noise),
        );
      }
    }
    const originalBytes = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const exportBytes = await sharp(originalBytes)
      .jpeg({ quality: 85, chromaSubsampling: "4:2:0" })
      .toBuffer();
    const original = image("original.png", "peloton", width, height);
    const copy = image("export.jpg", "strava", width, height);
    const result = await consolidateActivityImageCopies([copy, original], async (key) =>
      key === "original.png" ? originalBytes : exportBytes,
    );

    expect(result.map((entry) => entry.id)).toEqual(["original.png"]);
    expect(result[0]?.sources).toEqual([...copy.sources, ...original.sources]);
  });

  it.each([
    ["original.png", "copy.jpg", "image/png", "image/jpeg"],
    ["first.png", "second.png", "image/png", "image/png"],
    ["first.jpg", "second.webp", "image/jpeg", "image/webp"],
  ])(
    "retains the first equally sharp %s over %s",
    async (firstKey, secondKey, firstMime, secondMime) => {
      const first = { ...image(firstKey, "peloton"), mimeType: firstMime };
      const second = { ...image(secondKey, "strava"), mimeType: secondMime };
      const firstBytes = firstMime === "image/jpeg" ? jpeg : png;
      const secondBytes =
        secondMime === "image/jpeg" ? jpeg : secondMime === "image/webp" ? webp : png;
      const result = await consolidateActivityImageCopies([first, second], async (key) =>
        key === firstKey ? firstBytes : secondBytes,
      );
      expect(result.map((entry) => entry.id)).toEqual([firstKey]);
      expect(result[0]?.sources).toEqual([...first.sources, ...second.sources]);
    },
  );

  it.each(["image/jpeg", "image/png"])(
    "keeps the larger %s over a smaller PNG",
    async (mimeType) => {
      const large = { ...image("large", "peloton"), mimeType };
      const small = image("small.png", "strava", 512, 384);
      const result = await consolidateActivityImageCopies([large, small], async (key) =>
        key === "large" ? png : resized,
      );
      expect(result.map((entry) => entry.id)).toEqual(["large"]);
    },
  );

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

  it("keeps an incoming photo separate when only one of its providers overlaps", async () => {
    const first = image("first.png", "strava");
    const second = image("second.png", "peloton");
    second.sources.push({ providerId: "strava", sourceId: "shared-copy" });
    const read = vi.fn(async () => png);
    expect(await consolidateActivityImageCopies([first, second], read)).toEqual([first, second]);
    expect(read).not.toHaveBeenCalled();
  });

  it("preserves three distinct scenes in gallery order", async () => {
    const third = await sharp(png).negate().png().toBuffer();
    const images = [
      image("first.png", "peloton"),
      image("second.png", "strava"),
      image("third.png", "garmin"),
    ];
    const result = await consolidateActivityImageCopies(images, async (key) =>
      key === "first.png" ? png : key === "second.png" ? changed : third,
    );
    expect(result.map((entry) => entry.id)).toEqual(["first.png", "second.png", "third.png"]);
  });

  it("lets other requests run between comparisons of cached image pixels", async () => {
    const third = await sharp(png).negate().png().toBuffer();
    const images = [
      image("first.png", "peloton"),
      image("second.png", "strava"),
      image("third.png", "garmin"),
    ];
    let comparisons = 0;
    let probeRan = false;
    let probeBeforeThird: boolean | undefined;
    let probe: NodeJS.Immediate | undefined;
    comparisonObserver.mockImplementation(() => {
      comparisons++;
      if (comparisons === 2)
        probe = setImmediate(() => {
          probeRan = true;
        });
      if (comparisons === 3) probeBeforeThird = probeRan;
    });
    try {
      const result = await consolidateActivityImageCopies(images, async (key) =>
        key === "first.png" ? png : key === "second.png" ? changed : third,
      );
      expect(result).toHaveLength(3);
      expect(comparisons).toBe(3);
      expect(probeBeforeThird).toBe(true);
    } finally {
      comparisonObserver.mockReset();
      if (probe) clearImmediate(probe);
    }
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

  it("preserves separate animations with identical frames and different timing", async () => {
    const frames = Buffer.from([255, 0, 0, 0, 0, 255]);
    const firstBytes = await sharp(frames, {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    })
      .gif({ delay: [100, 100] })
      .toBuffer();
    const secondBytes = await sharp(frames, {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    })
      .gif({ delay: [200, 200] })
      .toBuffer();
    const images = [
      image("first.gif", "peloton", 1, 1),
      image("second.gif", "strava", 1, 1),
      image("third.gif", "garmin", 1, 1),
    ];
    const read = vi.fn(async (key: string) => (key === "first.gif" ? firstBytes : secondBytes));
    expect(await consolidateActivityImageCopies(images, read)).toEqual(images);
    expect(read.mock.calls.filter(([key]) => key === "first.gif")).toHaveLength(1);
  });

  it("preserves an animation supplied after a static photo", async () => {
    const still = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const animated = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    })
      .gif({ delay: [100, 100] })
      .toBuffer();
    const images = [image("still.png", "peloton", 1, 1), image("animation.gif", "strava", 1, 1)];
    expect(
      await consolidateActivityImageCopies(images, async (key) =>
        key === "still.png" ? still : animated,
      ),
    ).toEqual(images);
  });

  it("preserves photos whose stored dimensions agree but displayed orientations differ", async () => {
    const bytes = await sharp({
      create: { width: 1024, height: 768, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const rotated = await sharp(bytes).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const images = [image("landscape.jpg", "peloton"), image("portrait.jpg", "strava")];
    expect(
      await consolidateActivityImageCopies(images, async (key) =>
        key === "landscape.jpg" ? bytes : rotated,
      ),
    ).toEqual(images);
  });

  it.each([
    [26, 1],
    [27, 2],
  ])(
    "allows %i isolated changed pixels only within the compression tolerance",
    async (count, expectedImages) => {
      const pixels = Buffer.alloc(512 * 512 * 3, 255);
      const original = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } })
        .png()
        .toBuffer();
      for (let index = 0; index < count; index++) {
        const offset = ((10 + index * 16) * 512 + 100) * 3;
        pixels.fill(0, offset, offset + 3);
      }
      const copy = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } })
        .png()
        .toBuffer();
      const images = [
        image("original.png", "peloton", 512, 512),
        image("copy.png", "strava", 512, 512),
      ];
      expect(
        await consolidateActivityImageCopies(images, async (key) =>
          key === "original.png" ? original : copy,
        ),
      ).toHaveLength(expectedImages);
    },
  );

  it("preserves a small change along an anti-aliased contour", async () => {
    const pixels = Buffer.alloc(512 * 512 * 3, 255);
    for (let y = 0; y < 512; y++) pixels.fill(0, (y * 512 + 150) * 3, (y * 512 + 350) * 3);
    const original = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } })
      .png()
      .toBuffer();
    for (let y = 200; y < 300; y++) pixels.fill(128, (y * 512 + 149) * 3, (y * 512 + 150) * 3);
    const changed = await sharp(pixels, { raw: { width: 512, height: 512, channels: 3 } })
      .png()
      .toBuffer();
    const images = [
      image("original.png", "peloton", 512, 512),
      image("changed.png", "strava", 512, 512),
    ];
    expect(
      await consolidateActivityImageCopies(images, async (key) =>
        key === "original.png" ? original : changed,
      ),
    ).toHaveLength(2);
  });

  it("preserves a low-contrast change across the scene", async () => {
    const original = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 100, g: 100, b: 100 } },
    })
      .png()
      .toBuffer();
    const changed = await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 120, g: 120, b: 120 } },
    })
      .png()
      .toBuffer();
    const images = [
      image("original.png", "peloton", 512, 512),
      image("changed.png", "strava", 512, 512),
    ];
    expect(
      await consolidateActivityImageCopies(images, async (key) =>
        key === "original.png" ? original : changed,
      ),
    ).toHaveLength(2);
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
