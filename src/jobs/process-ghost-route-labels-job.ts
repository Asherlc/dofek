import { labelGhostRoute } from "../analytics/ghost-route-labels.ts";
import { isAccountErasureActive } from "../db/account-erasure-processing.ts";
import { getGhostTrack } from "../db/activity-ghost-track.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { readGhostMapLabelConsent } from "../db/ghost-map-label-consent.ts";
import {
  getGhostTrackEvidence,
  ghostRouteLabelsSourceVersion,
  hasActiveGhostMember,
  resolveActiveGhostMembers,
} from "../db/ghost-track-evidence.ts";
import type { Database } from "../db/index.ts";
import type { CacheStore } from "../lib/cache.ts";
import {
  ghostRouteLabelsCacheKey,
  ghostRouteLabelsCacheResultSchema,
  readGhostRouteLabelsCache,
} from "../lib/ghost-route-labels-cache.ts";
import type { GhostRouteLabelsJobData } from "./queues.ts";

type LabelKey = Pick<GhostRouteLabelsJobData, "userId" | "activityId">;
type LabelRevision = Pick<GhostRouteLabelsJobData, "sourceVersion" | "consentRevision">;
type LabelDatabase = Pick<Database, "execute">;
type LabelAnalytics = Pick<ClickHouseClient, "query">;

export interface GhostRouteLabelsJobConfig {
  provider: Parameters<typeof labelGhostRoute>[1];
  resultTtlMs: number;
}

/** Reads the current label input at compact grain before a worker or producer handles coordinates. */
export async function readGhostRouteLabelsInput(
  db: LabelDatabase,
  clickhouse: LabelAnalytics,
  key: LabelKey,
) {
  const consent = await readGhostMapLabelConsent(db, key.userId);
  if (!consent || (await isAccountErasureActive(db, key.userId))) return null;
  const source = await getGhostTrackEvidence(clickhouse, key);
  if (source?.status !== "ready") return null;
  const active = await resolveActiveGhostMembers(db, key.userId, [source.memberActivityId]);
  const selected = active.get(source.memberActivityId);
  if (
    !hasActiveGhostMember(active, source) ||
    selected?.sport !== source.sport ||
    selected.modality !== source.modality
  )
    return null;
  if ((await readGhostMapLabelConsent(db, key.userId))?.revision !== consent.revision) return null;

  return {
    source,
    sourceVersion: ghostRouteLabelsSourceVersion(source),
    consentRevision: consent.revision,
  };
}

type ReadyInput = NonNullable<Awaited<ReturnType<typeof readGhostRouteLabelsInput>>>;

function matchesLoadedSource(
  track: Awaited<ReturnType<typeof getGhostTrack>>,
  source: ReadyInput["source"],
): track is Extract<typeof track, { status: "ready" }> {
  return (
    track.status === "ready" &&
    track.memberActivityId === source.memberActivityId &&
    track.providerId === source.providerId &&
    track.deviceId === source.deviceId &&
    track.sport === source.sport &&
    track.modality === source.modality &&
    track.refreshVersion === source.refreshVersion &&
    track.sourceRefreshedAtNs === source.sourceRefreshedAtNs &&
    track.memberSourceSyncedAtNs === source.memberSourceSyncedAtNs &&
    (track.startedAt === null || track.startedAt === source.startedAt) &&
    (track.endedAt === null || track.endedAt === source.endedAt)
  );
}

function matchesRevision(input: ReadyInput | null, job: LabelRevision): input is ReadyInput {
  return (
    input?.sourceVersion === job.sourceVersion && input.consentRevision === job.consentRevision
  );
}

/** Runs under the post-sync worker's shared account-erasure work lock. */
export async function processGhostRouteLabelsJob(
  data: GhostRouteLabelsJobData,
  {
    db,
    clickhouse,
    cache,
    config,
    signal,
  }: {
    db: LabelDatabase;
    clickhouse: LabelAnalytics;
    cache: Pick<CacheStore, "get" | "set" | "invalidate">;
    config?: GhostRouteLabelsJobConfig;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (!config || signal?.aborted) return;
  if (!Number.isSafeInteger(config.resultTtlMs) || config.resultTtlMs <= 0)
    throw new Error("Ghost route labels require a positive cache retention limit");

  const key = { userId: data.userId, activityId: data.activityId };
  const input = await readGhostRouteLabelsInput(db, clickhouse, key);
  if (!matchesRevision(input, data)) return;
  const cacheKey = ghostRouteLabelsCacheKey(data);
  if ((await readGhostRouteLabelsCache(cache, data)) !== undefined) return;
  const track = await getGhostTrack(clickhouse, key);
  if (!matchesLoadedSource(track, input.source)) return;

  async function stillCurrent() {
    return (
      !signal?.aborted &&
      matchesRevision(await readGhostRouteLabelsInput(db, clickhouse, key), data)
    );
  }

  const result = await labelGhostRoute(
    {
      sport: track.sport,
      points: track.points,
      enabled: true,
      canDispatch: stillCurrent,
      signal,
    },
    config.provider,
  );
  if (result.status === "disabled" || result.status === "cancelled" || !(await stillCurrent()))
    return;

  let current = false;
  try {
    await cache.set(cacheKey, ghostRouteLabelsCacheResultSchema.parse(result), config.resultTtlMs);
    current = await stillCurrent();
  } finally {
    if (!current) await cache.invalidate(cacheKey);
  }
}
