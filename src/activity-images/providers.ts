import { z } from "zod";
import { recordActivityImageDiscovery } from "../db/activity-images.ts";
import { getProvider } from "../providers/index.ts";
import type { SyncRun } from "../providers/sync-run.ts";
import { isSyncProvider } from "../providers/types.ts";
import {
  type ActivityImageWork,
  type ImageDiscovery,
  type ProviderImageCandidate,
  sourceImageIdentity,
} from "./types.ts";

const photoSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullish(),
    unique_id: z.string().nullish(),
    caption: z.string().nullish(),
    media_type: z.number().optional(),
    urls: z.record(z.string(), z.string()),
    sizes: z.record(z.string(), z.array(z.number())).optional(),
  })
  .passthrough();
export const stravaPhotoListSchema = z.array(photoSchema);
export type StravaImagePhoto = z.infer<typeof photoSchema>;
export function stravaImageDiscovery(
  photos: unknown[],
  expectedCount: number | null,
  finished: boolean,
): ImageDiscovery {
  const images: ProviderImageCandidate[] = [];
  let invalid = false;
  for (const raw of photos) {
    const parsed = photoSchema.safeParse(raw);
    if (!parsed.success) {
      invalid = true;
      continue;
    }
    const photo = parsed.data;
    if (photo.media_type === 2) continue;
    const variants = Object.entries(photo.urls).map(([size, url]) => ({
      url,
      width: photo.sizes?.[size]?.[0] ?? (Number(size) || null),
      height: photo.sizes?.[size]?.[1] ?? (Number(size) || null),
    }));
    const first = variants[0];
    if (!first) {
      invalid = true;
      continue;
    }
    images.push({
      sourceId: photo.unique_id ?? String(photo.id ?? sourceImageIdentity(first.url)),
      kind: "photo",
      caption: photo.caption ?? null,
      position: images.length,
      variants,
      revision: null,
      raw: photo,
    });
  }
  const bySource = new Map<string, ProviderImageCandidate>();
  for (const image of images) {
    const existing = bySource.get(image.sourceId);
    if (existing) {
      existing.variants = [
        ...new Map(
          [...existing.variants, ...image.variants].map((variant) => [variant.url, variant]),
        ).values(),
      ];
    } else bySource.set(image.sourceId, image);
  }
  const unique = [...bySource.values()];
  const complete =
    finished && !invalid && (expectedCount === null || unique.length >= expectedCount);
  return {
    coverage: complete ? "complete" : "partial",
    expectedCount,
    reason: complete ? null : "gallery_incomplete",
    images: unique,
  };
}
export function pelotonImageDiscovery(workout: unknown): ImageDiscovery {
  const result = z
    .object({
      ride: z
        .object({
          id: z.string(),
          title: z.string().optional(),
          image_url: z.string().nullish(),
          extra_images: z.array(z.unknown()).nullish(),
        })
        .nullish(),
    })
    .safeParse(workout);
  if (!result.success)
    return { coverage: "failed", expectedCount: null, reason: "invalid_workout_media", images: [] };
  const ride = result.data.ride;
  if (!ride) return { coverage: "complete", expectedCount: 0, reason: null, images: [] };
  const images: ProviderImageCandidate[] = [];
  let partial = false;
  const append = (
    url: string,
    sourceId: string,
    raw: Record<string, unknown>,
    width: number | null = null,
    height: number | null = null,
  ) => {
    images.push({
      sourceId,
      kind: "class_artwork",
      caption: ride.title ?? null,
      position: images.length,
      variants: [{ url, width, height }],
      revision: null,
      raw,
    });
  };
  if (ride.image_url) append(ride.image_url, `${ride.id}:cover`, { image_url: ride.image_url });
  for (const extra of ride.extra_images ?? []) {
    if (typeof extra === "string") {
      append(extra, `${ride.id}:${sourceImageIdentity(extra)}`, { url: extra });
      continue;
    }
    const parsed = z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        image_url: z.string(),
        width: z.number().nullish(),
        height: z.number().nullish(),
      })
      .passthrough()
      .safeParse(extra);
    if (!parsed.success) {
      partial = true;
      continue;
    }
    const value = parsed.data;
    append(
      value.image_url,
      `${ride.id}:${value.id ?? sourceImageIdentity(value.image_url)}`,
      value,
      value.width ?? null,
      value.height ?? null,
    );
  }
  return {
    coverage: partial ? "partial" : "complete",
    expectedCount: null,
    reason: partial ? "unrecognized_class_image" : null,
    images,
  };
}
export function imageDiscoveryFailure(
  error: unknown,
): Pick<ImageDiscovery, "coverage" | "retryable" | "retryAfterSeconds"> {
  const parsed = z
    .object({
      statusCode: z.number().optional(),
      status: z.number().optional(),
      retryAfterSeconds: z.number().nullish(),
      name: z.string().optional(),
    })
    .safeParse(error);
  const detail = parsed.success ? parsed.data : {};
  const status = detail.statusCode ?? detail.status;
  if (status === 404 || status === 410 || detail.name === "StravaNotFoundError")
    return { coverage: "unavailable", retryable: false };
  const retryable =
    !(error instanceof z.ZodError) && (status === undefined || status === 429 || status >= 500);
  return {
    coverage: "failed",
    retryable,
    ...(retryable ? { retryAfterSeconds: Math.max(1, detail.retryAfterSeconds ?? 300) } : {}),
  };
}
export async function discoverAndRecordActivityImages(
  run: SyncRun,
  activityId: string,
  activityExternalId: string,
  providerId: string,
): Promise<ImageDiscovery> {
  const userId = run.options.userId;
  if (!userId) throw Error("Image discovery requires an explicit owner");
  const provider = getProvider(providerId);
  let discovery: ImageDiscovery;
  try {
    discovery =
      provider && isSyncProvider(provider) && provider.discoverActivityImages
        ? await provider.discoverActivityImages(run, activityExternalId)
        : {
            coverage: "unavailable",
            expectedCount: null,
            reason: "provider_media_not_verified",
            images: [],
          };
  } catch (error) {
    discovery = {
      ...imageDiscoveryFailure(error),
      expectedCount: null,
      reason: "provider_media_request_failed",
      images: [],
    };
  }
  await recordActivityImageDiscovery(run.db, { userId, activityId, providerId, discovery });
  return discovery;
}
export async function refreshActivityImage(
  run: SyncRun,
  work: ActivityImageWork,
): Promise<ProviderImageCandidate> {
  const provider = getProvider(work.providerId);
  if (!provider || !isSyncProvider(provider) || !provider.discoverActivityImages)
    throw Error("Image refresh unavailable");
  const discovery = await provider.discoverActivityImages(run, work.activityExternalId, {
    refresh: true,
  });
  const candidate = discovery.images.find((image) => image.sourceId === work.candidate.sourceId);
  if (!candidate) throw Error("Source image no longer exposed");
  return candidate;
}

export async function fetchStravaActivityImages(
  fetchPage: (page: number) => Promise<unknown>,
  expectedCount: number | null,
  primary: unknown = null,
): Promise<ImageDiscovery> {
  const photos: unknown[] = [];
  const seen = new Set<string>();
  let finished = false;
  let failure: ReturnType<typeof imageDiscoveryFailure> | undefined;
  for (let page = 1; page <= 100; page++) {
    try {
      const batch = stravaPhotoListSchema.parse(await fetchPage(page));
      const fingerprint = JSON.stringify(
        batch.map((photo) => photo.unique_id ?? photo.id ?? photo.urls),
      );
      if (batch.length && seen.has(fingerprint)) break;
      seen.add(fingerprint);
      photos.push(...batch);
      if (batch.length < 200) {
        finished = true;
        break;
      }
    } catch (error) {
      failure = imageDiscoveryFailure(error);
      break;
    }
  }
  if (primary) photos.push(primary);
  return {
    ...stravaImageDiscovery(photos, expectedCount, finished),
    ...(failure
      ? { retryable: failure.retryable, retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
  };
}

export function zwiftImageDiscovery(value: unknown): ImageDiscovery {
  const parsed = z
    .object({
      primaryImageUrl: z.string().nullish(),
      snapshotThumbnails: z.array(z.unknown()).optional(),
      snapshotList: z.unknown().optional(),
    })
    .safeParse(value);
  if (!parsed.success)
    return { coverage: "failed", expectedCount: null, reason: "invalid_zwift_media", images: [] };
  const images: ProviderImageCandidate[] = [];
  if (parsed.data.primaryImageUrl)
    images.push({
      sourceId: sourceImageIdentity(parsed.data.primaryImageUrl),
      kind: "screenshot",
      caption: null,
      position: 0,
      variants: [{ url: parsed.data.primaryImageUrl, width: null, height: null }],
      revision: null,
      raw: { primaryImageUrl: parsed.data.primaryImageUrl },
    });
  // The inspected source defines snapshot payloads as unknown; do not invent a gallery contract.
  return {
    coverage: "partial",
    expectedCount: null,
    reason: "zwift_snapshot_gallery_unverified",
    images,
  };
}
