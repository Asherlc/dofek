import { z } from "zod";
import { type ImageDiscovery, sourceImageIdentity } from "../activity-images/types.ts";

const photoUrlSchema = z.url({ protocol: /^https$/ });
const mediaSchema = z
  .object({
    id: z.string().min(1),
    photo: z
      .object({
        photo_url: photoUrlSchema.nullish(),
        thumb_url: photoUrlSchema.nullish(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

/** Only ascent photographs; climb galleries and video covers are separate source records. */
export function kayaImageDiscovery(ascent: unknown): ImageDiscovery {
  const parsed = mediaSchema.safeParse(ascent);
  if (!parsed.success)
    return {
      coverage: "partial",
      expectedCount: null,
      reason: "invalid_kaya_ascent_photo",
      images: [],
    };
  const { id, photo } = parsed.data;
  if (photo === null) return { coverage: "complete", expectedCount: 0, reason: null, images: [] };
  const urls = [
    ...new Set(
      [photo.photo_url, photo.thumb_url].filter((url): url is string => typeof url === "string"),
    ),
  ];
  const first = urls[0];
  if (!first)
    return {
      coverage: "partial",
      expectedCount: null,
      reason: "invalid_kaya_ascent_photo",
      images: [],
    };
  return {
    coverage: "complete",
    expectedCount: 1,
    reason: null,
    images: [
      {
        sourceId: `kaya:ascent:${id}:photo`,
        kind: "photo",
        caption: null,
        position: 0,
        variants: urls.map((url) => ({ url, width: null, height: null })),
        revision: sourceImageIdentity(first),
        raw: { id, photo },
      },
    ],
  };
}
