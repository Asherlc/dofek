import { z } from "zod";
import { ghostRouteLabelsCachePrefix } from "../db/ghost-map-label-consent.ts";
import { ghostRouteLabelsSourceVersion } from "../db/ghost-track-evidence.ts";
import { type GhostRouteLabelsJobData, ghostRouteLabelsRevisionDigest } from "../jobs/queues.ts";
import type { CacheStore } from "./cache.ts";
import { preparedGhostSectionsSchema } from "./ghost-route-section-results.ts";

type LabelCacheRevision = Pick<
  GhostRouteLabelsJobData,
  "userId" | "activityId" | "sourceVersion" | "consentRevision"
>;

const recordedBoundSchema = z.strictObject({
  originalIndex: z.number().int().nonnegative(),
  timestampMs: z.number(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  distanceMeters: z.number().nonnegative(),
});

const labelsSchema = z.strictObject({
  sections: z
    .array(
      z.strictObject({
        kind: z.enum(["named-road", "named-trail"]),
        name: z.string().min(1).max(256),
        start: recordedBoundSchema,
        end: recordedBoundSchema,
        attribution: z.string().min(1),
      }),
    )
    .max(64),
  coverage: z.strictObject({
    sampledWaypoints: z.number().int().nonnegative(),
    confirmedWaypoints: z.number().int().nonnegative(),
    bounded: z.boolean(),
  }),
});

export const ghostRouteLabelsCacheResultSchema = z.discriminatedUnion("status", [
  labelsSchema.extend({
    status: z.literal("ready"),
    expiresAt: z.int().positive().optional(),
    prepared: preparedGhostSectionsSchema.optional().catch(undefined),
  }),
  labelsSchema.extend({ status: z.literal("unavailable") }),
  z.strictObject({
    status: z.literal("error"),
    reason: z.enum(["rate-limited", "request-failed", "invalid-response"]),
    retryAfterSeconds: z.number().int().nonnegative().max(3_600).optional(),
  }),
]);
export type GhostRouteLabelsCacheResult = z.infer<typeof ghostRouteLabelsCacheResultSchema>;

export function ghostRouteLabelsCacheKey(data: LabelCacheRevision): string {
  return `${ghostRouteLabelsCachePrefix(data.userId)}${data.activityId}:${ghostRouteLabelsRevisionDigest(data)}`;
}

/** Callers supply the already verified current owner, recording and consent revisions. */
export async function readGhostRouteLabelsCache(
  cache: Pick<CacheStore, "get">,
  data: LabelCacheRevision,
): Promise<GhostRouteLabelsCacheResult | undefined> {
  const result = ghostRouteLabelsCacheResultSchema.safeParse(
    await cache.get(ghostRouteLabelsCacheKey(data)),
  );
  if (!result.success) return undefined;
  if (result.data.status !== "ready") return result.data;
  if (result.data.expiresAt !== undefined && result.data.expiresAt <= Date.now()) return undefined;
  const { prepared, ...labels } = result.data;
  if (
    prepared?.anchorStamp.activityId === data.activityId &&
    ghostRouteLabelsSourceVersion({ status: "ready", ...prepared.anchorStamp }) ===
      data.sourceVersion &&
    prepared.sections.every(({ kind }) => kind !== "unnamed-climb")
  ) {
    return result.data;
  }
  return labels;
}
