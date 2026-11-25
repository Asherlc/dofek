import { labelGhostRoute } from "../analytics/ghost-route-labels.ts";
import { recordedGhostRouteChunks } from "../analytics/ghost-route-matching.ts";
import { prepareGhostSectionComparisons } from "../analytics/ghost-route-section-projection.ts";
import { findUnnamedGhostClimbs } from "../analytics/ghost-route-sections.ts";
import {
  ghostScalarWindow,
  matchesSelectedGhostTrack,
} from "../analytics/ghost-session-pair-preparation.ts";
import { isAccountErasureActive } from "../db/account-erasure-processing.ts";
import {
  type GhostAltitudeWindowProof,
  getGhostAltitudeWindow,
  readGhostAltitudeWindowProof,
} from "../db/activity-ghost-scalar-sample.ts";
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
  ghostRouteClimbsCacheKey,
  ghostRouteClimbsCacheResultSchema,
  readGhostRouteClimbsCache,
} from "../lib/ghost-route-climbs-cache.ts";
import {
  ghostRouteLabelsCacheKey,
  ghostRouteLabelsCacheResultSchema,
  readGhostRouteLabelsCache,
} from "../lib/ghost-route-labels-cache.ts";
import type { GhostRouteClimbsJobData, GhostRouteLabelsJobData } from "./queues.ts";

type RouteKey = Pick<GhostRouteLabelsJobData, "userId" | "activityId">;
type LabelRevision = Pick<GhostRouteLabelsJobData, "sourceVersion" | "consentRevision">;
type RouteDatabase = Pick<Database, "execute">;
type RouteAnalytics = Pick<ClickHouseClient, "query">;
type RouteCache = Pick<CacheStore, "get" | "set" | "invalidate">;

interface RoutePreparation {
  db: RouteDatabase;
  clickhouse: RouteAnalytics;
  cache: RouteCache;
  signal?: AbortSignal;
}

const climbResultTtlMs = 24 * 60 * 60 * 1_000;

export interface GhostRouteLabelsJobConfig {
  provider: Parameters<typeof labelGhostRoute>[1];
  resultTtlMs: number;
}

/** Reads one current independently selected recording at compact grain. */
export async function readGhostRouteInput(
  db: RouteDatabase,
  clickhouse: RouteAnalytics,
  key: RouteKey,
) {
  if (await isAccountErasureActive(db, key.userId)) return null;
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
  return { source, sourceVersion: ghostRouteLabelsSourceVersion(source) };
}

/** Reads the current label input at compact grain before a worker or producer handles coordinates. */
export async function readGhostRouteLabelsInput(
  db: RouteDatabase,
  clickhouse: RouteAnalytics,
  key: RouteKey,
) {
  const consent = await readGhostMapLabelConsent(db, key.userId);
  if (!consent) return null;
  const input = await readGhostRouteInput(db, clickhouse, key);
  if (!input || (await readGhostMapLabelConsent(db, key.userId))?.revision !== consent.revision)
    return null;
  return { ...input, consentRevision: consent.revision };
}

type ReadyInput = NonNullable<Awaited<ReturnType<typeof readGhostRouteLabelsInput>>>;

function matchesRevision(input: ReadyInput | null, job: LabelRevision): input is ReadyInput {
  return (
    input?.sourceVersion === job.sourceVersion && input.consentRevision === job.consentRevision
  );
}

async function publishCurrent(
  cache: RouteCache,
  key: string,
  result: unknown,
  expiration: { ttlMs: number } | { expiresAt: number },
  stillCurrent: () => Promise<boolean>,
) {
  if (!(await stillCurrent())) return false;
  const ttlMs = "expiresAt" in expiration ? expiration.expiresAt - Date.now() : expiration.ttlMs;
  if (ttlMs <= 0) return false;
  let current = false;
  try {
    await cache.set(key, result, ttlMs);
  } finally {
    try {
      current = await stillCurrent();
    } finally {
      if (!current) await cache.invalidate(key);
    }
  }
  return current;
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
  }: RoutePreparation & { config?: GhostRouteLabelsJobConfig },
): Promise<void> {
  if (!config || signal?.aborted) return;
  if (!Number.isSafeInteger(config.resultTtlMs) || config.resultTtlMs <= 0)
    throw new Error("Ghost route labels require a positive cache retention limit");

  const key = { userId: data.userId, activityId: data.activityId };
  const input = await readGhostRouteLabelsInput(db, clickhouse, key);
  if (!matchesRevision(input, data)) return;
  const cacheKey = ghostRouteLabelsCacheKey(data);
  let labels = await readGhostRouteLabelsCache(cache, data);
  if (labels && (labels.status !== "ready" || labels.prepared || labels.expiresAt === undefined))
    return;
  if (!labels && data.prepareOnly) return;
  const track = await getGhostTrack(clickhouse, key);
  if (!matchesSelectedGhostTrack(track, input.source)) return;

  async function stillCurrent() {
    return (
      !signal?.aborted &&
      matchesRevision(await readGhostRouteLabelsInput(db, clickhouse, key), data)
    );
  }

  if (!labels) {
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
    if (result.status === "disabled" || result.status === "cancelled") return;
    const expiration =
      result.status === "ready"
        ? { expiresAt: Date.now() + config.resultTtlMs }
        : { ttlMs: config.resultTtlMs };
    labels = ghostRouteLabelsCacheResultSchema.parse(
      "expiresAt" in expiration ? { ...result, expiresAt: expiration.expiresAt } : result,
    );
    if (!(await publishCurrent(cache, cacheKey, labels, expiration, stillCurrent))) return;
  }
  if (labels.status !== "ready" || labels.expiresAt === undefined || !(await stillCurrent()))
    return;

  const prepared = await prepareGhostSectionComparisons(
    { db, clickhouse },
    { userId: data.userId, anchor: { stamp: input.source, track }, sections: labels.sections },
  );
  if (prepared.status === "ready") {
    await publishCurrent(
      cache,
      cacheKey,
      { ...labels, prepared },
      { expiresAt: labels.expiresAt },
      stillCurrent,
    );
  }
}

/** Prepares unnamed climbs from one selected recording under the post-sync erasure lock. */
export async function processGhostRouteClimbsJob(
  data: GhostRouteClimbsJobData,
  { db, clickhouse, cache, signal }: RoutePreparation,
): Promise<void> {
  if (signal?.aborted) return;
  const key = { userId: data.userId, activityId: data.activityId };
  const input = await readGhostRouteInput(db, clickhouse, key);
  if (input?.sourceVersion !== data.sourceVersion) return;

  async function altitudeStillCurrent(saved: GhostAltitudeWindowProof) {
    const current = await readGhostAltitudeWindowProof(
      async (schema, query, query_params) => {
        const result = await clickhouse.query({ query, query_params, format: "JSONEachRow" });
        return schema.array().parse(await result.json());
      },
      data.userId,
      saved,
    );
    return current?.count === saved.count && current.digest === saved.digest;
  }

  const cached = await readGhostRouteClimbsCache(cache, data);
  if (cached && (await altitudeStillCurrent(cached.altitudeProof))) return;
  const track = await getGhostTrack(clickhouse, key);
  if (!matchesSelectedGhostTrack(track, input.source)) return;

  const { chunks } = recordedGhostRouteChunks(track.points);
  const start = chunks[0]?.[0];
  const last = chunks.at(-1)?.at(-1);
  if (!start || !last) return;
  // The source window is half-open. Include the last recorded sample at microsecond precision.
  const end = { ...last, timestampMs: last.timestampMs + 0.001 };
  const altitude = await getGhostAltitudeWindow(clickhouse, data.userId, {
    ...ghostScalarWindow(input.source, {
      start,
      end,
      elapsedMs: end.timestampMs - start.timestampMs,
    }),
    providerId: input.source.providerId,
    deviceId: input.source.deviceId,
  });
  if (altitude.status !== "ready") return;
  const { proof } = altitude;
  async function stillCurrent() {
    return (
      !signal?.aborted &&
      (await readGhostRouteInput(db, clickhouse, key))?.sourceVersion === data.sourceVersion &&
      (await altitudeStillCurrent(proof))
    );
  }

  const climbs = findUnnamedGhostClimbs(track.points, altitude.observations);
  const prepared = await prepareGhostSectionComparisons(
    { db, clickhouse },
    {
      userId: data.userId,
      anchor: { stamp: input.source, track },
      sections: climbs.sections.map((section) => ({ ...section, kind: "unnamed-climb" })),
    },
  );
  if (prepared.status !== "ready") return;
  const result = ghostRouteClimbsCacheResultSchema.parse({
    status: "ready",
    altitudeProof: proof,
    prepared: { ...prepared, bounded: prepared.bounded || climbs.bounded },
  });
  await publishCurrent(
    cache,
    ghostRouteClimbsCacheKey(data),
    result,
    { ttlMs: climbResultTtlMs },
    stillCurrent,
  );
}
