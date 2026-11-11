import { setImmediate } from "node:timers/promises";
import pixelmatch from "pixelmatch";
import sharp from "sharp";

interface GalleryImage {
  objectKey: string;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
  sources: { providerId: string }[];
}

interface PreparedImage {
  data: Buffer;
  width: number;
  height: number;
}

function canCompare(first: GalleryImage, second: GalleryImage): boolean {
  return (
    first.width * second.height === second.width * first.height &&
    !first.sources.some((source) =>
      second.sources.some((other) => source.providerId === other.providerId),
    )
  );
}

function preferImage<T extends GalleryImage>(first: T, second: T): T {
  const resolution = second.width * second.height - first.width * first.height;
  if (resolution > 0) return second;
  if (resolution === 0 && second.mimeType === "image/png" && first.mimeType !== "image/png")
    return second;
  return first;
}

export async function consolidateActivityImageCopies<T extends GalleryImage>(
  images: T[],
  readImage: (objectKey: string) => Promise<Uint8Array>,
): Promise<T[]> {
  const prepared = new Map<string, PreparedImage | null>();
  async function prepare(image: T): Promise<PreparedImage | null> {
    const cached = prepared.get(image.objectKey);
    if (cached !== undefined) return cached;
    const bytes = await readImage(image.objectKey);
    const decoder = sharp(bytes, { limitInputPixels: 100_000_000 });
    const metadata = await decoder.metadata();
    if ((metadata.pages ?? 1) > 1) {
      prepared.set(image.objectKey, null);
      return null;
    }
    const { data, info } = await decoder
      .autoOrient()
      .toColourspace("srgb")
      .resize({ width: 512, height: 512, fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = { data, width: info.width, height: info.height };
    prepared.set(image.objectKey, result);
    return result;
  }

  const gallery: T[] = [];
  for (const image of images) {
    let match = -1;
    for (const [index, existing] of gallery.entries()) {
      if (!canCompare(existing, image)) continue;
      const first = await prepare(existing);
      if (!first) continue;
      const second = await prepare(image);
      if (!second || first.width !== second.width || first.height !== second.height) continue;
      // Allow export compression noise, while requiring 99.99% of pixels to match.
      const differences = pixelmatch(first.data, second.data, null, first.width, first.height, {
        threshold: 0.07,
        includeAA: true,
      });
      // Cached comparisons still need to let other requests use the event loop.
      await setImmediate();
      if (differences / (first.width * first.height) <= 0.0001) {
        match = index;
        break;
      }
    }
    const existing = gallery[match];
    if (existing) {
      gallery[match] = {
        ...preferImage(existing, image),
        sources: [...existing.sources, ...image.sources],
      };
    } else gallery.push(image);
  }
  return gallery;
}
