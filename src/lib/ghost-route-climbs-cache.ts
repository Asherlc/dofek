import { z } from "zod";
import { ghostRouteLabelsSourceVersion } from "../db/ghost-track-evidence.ts";
import type { GhostRouteClimbsJobData } from "../jobs/queues.ts";
import type { CacheStore } from "./cache.ts";
import { preparedGhostSectionsSchema } from "./ghost-route-section-results.ts";

type ClimbCacheRevision = Pick<GhostRouteClimbsJobData, "userId" | "activityId" | "sourceVersion">;

export const ghostRouteClimbsCacheResultSchema = z
  .strictObject({
    status: z.literal("ready"),
    altitudeProof: z.strictObject({
      activityId: z.uuid(),
      memberActivityId: z.uuid(),
      providerId: z.string(),
      deviceId: z.string().nullable(),
      startedAt: z.iso.datetime({ precision: 6 }),
      endedAt: z.iso.datetime({ precision: 6 }),
      count: z.int().min(0).max(20_000),
      digest: z.string().regex(/^[A-F0-9]{64}$/),
    }),
    prepared: preparedGhostSectionsSchema,
  })
  .refine(({ altitudeProof, prepared }) => {
    const { anchorStamp } = prepared;
    return (
      altitudeProof.activityId === anchorStamp.activityId &&
      altitudeProof.memberActivityId === anchorStamp.memberActivityId &&
      altitudeProof.providerId === anchorStamp.providerId &&
      altitudeProof.deviceId === anchorStamp.deviceId &&
      prepared.sections.every(({ kind }) => kind === "unnamed-climb")
    );
  });

export type GhostRouteClimbsCacheResult = z.infer<typeof ghostRouteClimbsCacheResultSchema>;

export function ghostRouteClimbsCacheKey(data: ClimbCacheRevision): string {
  return `${data.userId}:ghostRouteClimbs.${data.activityId}:${data.sourceVersion}`;
}

/** Callers also verify the saved altitude proof against the current scalar window. */
export async function readGhostRouteClimbsCache(
  cache: Pick<CacheStore, "get">,
  data: ClimbCacheRevision,
): Promise<GhostRouteClimbsCacheResult | undefined> {
  const result = ghostRouteClimbsCacheResultSchema.safeParse(
    await cache.get(ghostRouteClimbsCacheKey(data)),
  );
  if (!result.success) return undefined;
  const { anchorStamp } = result.data.prepared;
  if (
    anchorStamp.activityId !== data.activityId ||
    ghostRouteLabelsSourceVersion({ status: "ready", ...anchorStamp }) !== data.sourceVersion
  ) {
    return undefined;
  }
  return result.data;
}
