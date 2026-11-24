import { z } from "zod";
import { getGhostTrack } from "../db/activity-ghost-track.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { ghostTrackIndexColumns } from "../db/ghost-track-index-schema.ts";
import { ACCOUNT_ERASURE_FENCE_TABLE } from "../metric-stream/clickhouse-table.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";

const trackBatchSize = 16;
const candidatePageSize = 25;
// About 220 meters of latitude. This includes nearby recordings that can match
// even when their raw envelopes do not intersect.
const searchMarginDegrees = 0.002;
const emptyMemberSignature = "hex(SHA256('[]'))";

type QueryClient = Pick<ClickHouseClient, "query">;
type Track = Awaited<ReturnType<typeof getGhostTrack>>;

const observedTrackSchema = z.object({
  user_id: z.uuid(),
  activity_id: z.uuid(),
  gps_source_refreshed_at_ns: z.string(),
  gps_refresh_version: z.string(),
  member_signature: z.string(),
});

interface CandidateCursor {
  startedAt: string;
  activityId: string;
}

const candidateSchema = z.object({
  activityId: z.uuid(),
  memberActivityId: z.uuid(),
  providerId: z.string(),
  deviceId: z.string().nullable(),
  sport: z.enum(["running", "cycling"]),
  modality: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  pointCount: z.coerce.number(),
  refreshVersion: z.string(),
  sourceRefreshedAtNs: z.string(),
  memberSourceSyncedAtNs: z.string().nullable(),
  gpsRefreshVersion: z.string(),
  gpsSourceRefreshedAtNs: z.string(),
  memberSignature: z.string(),
});

function excludesErasedOwner(user: string): string {
  return `lower(hex(SHA256(toString(${user})))) NOT IN (
    SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
  )`;
}

/** Defines gps and members CTEs. The optional internal keys CTE supplies user_id and activity_id. */
export function ghostTrackInputVersionsSql(keys?: string): string {
  const scopedKeys = keys ? `(SELECT user_id, activity_id FROM ${keys})` : null;
  // Include GPS tombstones. The aggregate projection's source timestamp can
  // stay unchanged when the model publishes a newer invalidation version.
  return `
    gps AS (
      SELECT user_id, activity_id,
        toUnixTimestamp64Nano(max(greatest(source_refreshed_at, refreshed_at))) AS gps_source_refreshed_at_ns,
        max(refresh_version) AS gps_refresh_version
      FROM analytics.activity_ghost_location_sample
      ${scopedKeys ? `WHERE (user_id, activity_id) IN ${scopedKeys}` : ""}
      GROUP BY user_id, activity_id
    ), members AS (
      SELECT user_id, group_id AS activity_id,
        groupUniqArray(source.activity_id) AS eligible_member_ids,
        hex(SHA256(toJSONString(arraySort(groupArray(tuple(
          source.activity_id, provider_id, canonical_type, modality, started_at, ended_at, source_synced_at,
          source_name, if(provider_id = 'apple_health', JSONExtractString(coalesce(raw, '{}'), 'sourceBundle'), '')
        )))))) AS member_signature
      FROM analytics.activity_source_records AS source FINAL
      WHERE is_deleted = 0 AND user_id IS NOT NULL AND group_id IS NOT NULL
        -- Apply the same current-member eligibility as getGhostTrack.
        AND provider_id != 'strava'
        AND canonical_type IN ('running', 'cycling')
        AND (modality IS NULL OR modality NOT IN ('indoor', 'virtual'))
        AND NOT (
          provider_id = 'apple_health'
          AND (
            lowerUTF8(trim(BOTH ' ' FROM coalesce(source_name, ''))) = 'strava'
            OR lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(
              coalesce(raw, '{}'), 'sourceBundle'
            ))) = 'com.strava.strava'
          )
        )
        ${scopedKeys ? `AND (assumeNotNull(user_id), assumeNotNull(group_id)) IN ${scopedKeys}` : ""}
      GROUP BY user_id, group_id
    )`;
}

/** Compares an internal observed-row alias to gps and members joined on user_id and activity_id. */
export function ghostTrackInputVersionsMatchSql(observed: string): string {
  return `${observed}.gps_source_refreshed_at_ns = coalesce(gps.gps_source_refreshed_at_ns, 0)
    AND ${observed}.gps_refresh_version = coalesce(gps.gps_refresh_version, 0)
    AND ${observed}.member_signature = coalesce(members.member_signature, ${emptyMemberSignature})`;
}

const dirtyTracksSql = `
  WITH ${ghostTrackInputVersionsSql()}, published AS (
    SELECT user_id, activity_id, gps_source_refreshed_at_ns, gps_refresh_version, member_signature
    FROM analytics.ghost_track FINAL
  )
  SELECT coalesce(gps.user_id, published.user_id) AS user_id,
    coalesce(gps.activity_id, published.activity_id) AS activity_id,
    coalesce(gps.gps_source_refreshed_at_ns, 0) AS gps_source_refreshed_at_ns,
    coalesce(gps.gps_refresh_version, 0) AS gps_refresh_version,
    coalesce(members.member_signature, ${emptyMemberSignature}) AS member_signature
  FROM gps FULL OUTER JOIN published
    ON gps.user_id = published.user_id AND gps.activity_id = published.activity_id
  LEFT JOIN members
    ON members.user_id = coalesce(gps.user_id, published.user_id)
    AND members.activity_id = coalesce(gps.activity_id, published.activity_id)
  WHERE (published.activity_id IS NULL OR NOT (${ghostTrackInputVersionsMatchSql("published")}))
    AND ${excludesErasedOwner("coalesce(gps.user_id, published.user_id)")}`;

async function queryRows<Schema extends z.ZodType>(
  client: QueryClient,
  schema: Schema,
  query: string,
  queryParams?: Record<string, unknown>,
): Promise<z.infer<Schema>[]> {
  const result = await client.query({
    query,
    query_params: queryParams,
    format: "JSONEachRow",
    clickhouse_settings: { join_use_nulls: 1, max_threads: 1, enable_materialized_cte: 1 },
  });
  return schema.array().parse(await result.json());
}

function pointTime(timestampMs: number | undefined): string | null {
  if (timestampMs === undefined) return null;
  const milliseconds = Math.floor(timestampMs);
  const fractionalMicroseconds = Math.round((timestampMs - milliseconds) * 1_000);
  return new Date(milliseconds)
    .toISOString()
    .replace("Z", `${String(fractionalMicroseconds).padStart(3, "0")}Z`);
}

function trackBounds(points: Extract<Track, { status: "ready" }>["points"]) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minShiftedLng = Infinity;
  let maxShiftedLng = -Infinity;
  for (const { lat, lng } of points) {
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    const shiftedLng = lng < 0 ? lng + 360 : lng;
    minShiftedLng = Math.min(minShiftedLng, shiftedLng);
    maxShiftedLng = Math.max(maxShiftedLng, shiftedLng);
  }
  if (minLat > maxLat) return { min_lat: null, max_lat: null, min_lng: null, max_lng: null };
  const longitudeBounds =
    maxLng - minLng < 180
      ? [minLng, maxLng]
      : maxShiftedLng - minShiftedLng < 180
        ? [minShiftedLng, maxShiftedLng]
        : [-180, 180];
  return {
    min_lat: minLat,
    max_lat: maxLat,
    min_lng: longitudeBounds[0],
    max_lng: longitudeBounds[1],
  };
}

function prepareTrack(observed: z.infer<typeof observedTrackSchema>, track: Track) {
  const metadata = track.status === "missing" ? null : track;
  const points = track.status === "ready" ? track.points : [];
  return {
    ...observed,
    status: track.status,
    member_activity_id: metadata?.memberActivityId ?? null,
    provider_id: metadata?.providerId ?? null,
    device_id: metadata?.deviceId ?? null,
    sport: metadata?.sport ?? null,
    modality: metadata?.modality ?? null,
    started_at: metadata?.startedAt ?? pointTime(points[0]?.timestampMs),
    ended_at: metadata?.endedAt ?? pointTime(points.at(-1)?.timestampMs),
    ...trackBounds(points),
    point_count: track.status === "over-limit" ? track.pointLimit + 1 : points.length,
    track_refresh_version: metadata?.refreshVersion ?? null,
    track_source_refreshed_at_ns: metadata?.sourceRefreshedAtNs ?? null,
    member_source_synced_at_ns: metadata?.memberSourceSyncedAtNs ?? null,
  };
}

/** Projects one batch under the shared analytics publication owner. */
export async function projectGhostTrackIndex(
  owner: Pick<AnalyticsQueryOwner, "client" | "assertActive">,
): Promise<{ pendingTracks: number }> {
  await owner.assertActive();
  const client = owner.client;
  const dirty = await queryRows(
    client,
    observedTrackSchema,
    `SELECT user_id, activity_id, toString(gps_source_refreshed_at_ns) AS gps_source_refreshed_at_ns,
        toString(gps_refresh_version) AS gps_refresh_version, member_signature
      FROM (${dirtyTracksSql}) ORDER BY toInt64(gps_source_refreshed_at_ns), user_id, activity_id
      LIMIT ${trackBatchSize}`,
  );
  if (dirty.length === 0) return { pendingTracks: 0 };

  const prepared = [];
  for (const source of dirty) {
    const track = await getGhostTrack(client, {
      userId: source.user_id,
      activityId: source.activity_id,
    });
    prepared.push(prepareTrack(source, track));
  }

  // Publish the discovery version only when the inputs still agree in the write.
  // The worker keeps only the compact states between sequential track reads.
  await client.command({
    query: `INSERT INTO analytics.ghost_track
      WITH prepared_rows AS MATERIALIZED (
        SELECT * FROM format('JSONEachRow', {columns:String}, {batch:String})
      ), ${ghostTrackInputVersionsSql("prepared_rows")}
      SELECT prepared.*, greatest(toUInt64(toUnixTimestamp64Nano(now64(9))),
        coalesce(previous.refresh_version, 0) + 1) AS refresh_version
      FROM prepared_rows AS prepared
      LEFT JOIN gps USING (user_id, activity_id)
      LEFT JOIN members USING (user_id, activity_id)
      LEFT JOIN analytics.ghost_track AS previous FINAL USING (user_id, activity_id)
      WHERE ${ghostTrackInputVersionsMatchSql("prepared")}
        AND ${excludesErasedOwner("prepared.user_id")}`,
    query_params: {
      columns: ghostTrackIndexColumns,
      batch: prepared.map((row) => JSON.stringify(row)).join("\n"),
    },
    clickhouse_settings: {
      join_use_nulls: 1,
      max_threads: 1,
      enable_materialized_cte: 1,
      date_time_input_format: "best_effort",
      log_queries: 0,
    },
  });

  const pending = await queryRows(
    client,
    z.object({ count: z.coerce.number() }),
    `SELECT count() AS count FROM (${dirtyTracksSql})`,
  );
  return { pendingTracks: pending[0]?.count ?? 0 };
}

/** Pages current compact evidence for an already chosen anchor activity. */
export async function listGhostTrackCandidates(
  client: QueryClient,
  input: {
    userId: string;
    anchorActivityId: string;
    before?: CandidateCursor;
    candidateActivityIds?: readonly string[];
  },
) {
  const page = await queryRows(
    client,
    candidateSchema.extend({ isCurrent: z.coerce.number() }),
    `WITH owned_tracks AS (
      SELECT * FROM analytics.ghost_track FINAL
      WHERE user_id = {userId:UUID} AND status = 'ready'
        AND started_at IS NOT NULL AND min_lat IS NOT NULL AND ${excludesErasedOwner("user_id")}
    ), anchor_context AS (
      SELECT sport AS anchor_sport, started_at AS anchor_started_at,
        min_lat AS anchor_min_lat, max_lat AS anchor_max_lat,
        min_lng AS anchor_min_lng, max_lng AS anchor_max_lng,
        least(180.0, ${searchMarginDegrees} / greatest(0.000001, cos(radians(
        least(90.0, greatest(abs(min_lat), abs(max_lat)) + ${searchMarginDegrees})
      )))) AS longitude_margin
      FROM owned_tracks WHERE activity_id = {anchorActivityId:UUID}
    ), ordered_page AS MATERIALIZED (
      SELECT candidate.* FROM owned_tracks AS candidate CROSS JOIN anchor_context AS anchor
      WHERE candidate.sport = anchor.anchor_sport AND candidate.started_at < anchor.anchor_started_at
        AND ({hasCandidateActivityIds:Bool} = 0 OR candidate.activity_id IN {candidateActivityIds:Array(UUID)})
        AND ({beforeStartedAt:Nullable(String)} IS NULL OR
          (candidate.started_at, candidate.activity_id) <
            (parseDateTime64BestEffort({beforeStartedAt:Nullable(String)}, 6, 'UTC'), {beforeActivityId:Nullable(UUID)}))
        AND candidate.min_lat <= anchor.anchor_max_lat + ${searchMarginDegrees}
        AND candidate.max_lat >= anchor.anchor_min_lat - ${searchMarginDegrees}
        AND arrayExists(shift ->
          candidate.min_lng + shift <= anchor.anchor_max_lng + anchor.longitude_margin
          AND candidate.max_lng + shift >= anchor.anchor_min_lng - anchor.longitude_margin,
          [-360.0, 0.0, 360.0])
      ORDER BY candidate.started_at DESC, candidate.activity_id DESC
      LIMIT ${candidatePageSize + 1}
    ), page_keys AS (
      SELECT user_id, activity_id, gps_source_refreshed_at_ns, gps_refresh_version, member_signature
      FROM ordered_page ORDER BY started_at DESC, activity_id DESC LIMIT ${candidatePageSize}
    ), checked_tracks AS MATERIALIZED (
      SELECT * FROM page_keys
      UNION ALL
      SELECT user_id, activity_id, gps_source_refreshed_at_ns, gps_refresh_version, member_signature
      FROM owned_tracks WHERE activity_id = {anchorActivityId:UUID}
    ), ${ghostTrackInputVersionsSql("checked_tracks")}, current_keys AS MATERIALIZED (
      SELECT indexed.activity_id AS activity_id
      FROM checked_tracks AS indexed INNER JOIN gps USING (user_id, activity_id)
      LEFT JOIN members USING (user_id, activity_id)
      WHERE ${ghostTrackInputVersionsMatchSql("indexed")}
    )
    SELECT activity_id AS activityId, member_activity_id AS memberActivityId,
      provider_id AS providerId, device_id AS deviceId, sport, modality,
      formatDateTime(started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS startedAt,
      formatDateTime(ended_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS endedAt,
      point_count AS pointCount, toString(track_refresh_version) AS refreshVersion,
      toString(track_source_refreshed_at_ns) AS sourceRefreshedAtNs,
      toString(member_source_synced_at_ns) AS memberSourceSyncedAtNs,
      toString(gps_refresh_version) AS gpsRefreshVersion,
      toString(gps_source_refreshed_at_ns) AS gpsSourceRefreshedAtNs,
      member_signature AS memberSignature,
      toUInt8(activity_id IN (SELECT activity_id FROM current_keys)) AS isCurrent
    FROM ordered_page
    WHERE {anchorActivityId:UUID} IN (SELECT activity_id FROM current_keys)
    ORDER BY started_at DESC, activity_id DESC`,
    {
      userId: input.userId,
      anchorActivityId: input.anchorActivityId,
      beforeStartedAt: input.before?.startedAt ?? null,
      beforeActivityId: input.before?.activityId ?? null,
      hasCandidateActivityIds: input.candidateActivityIds !== undefined,
      candidateActivityIds: input.candidateActivityIds ?? [],
    },
  );
  const candidates = page
    .slice(0, candidatePageSize)
    .flatMap(({ isCurrent, ...candidate }) => (isCurrent ? [candidate] : []));
  // The cursor describes the ordered metadata page even when every row is stale.
  const last = page.length > candidatePageSize ? page[candidatePageSize - 1] : undefined;
  return {
    candidates,
    nextCursor: last ? { startedAt: last.startedAt, activityId: last.activityId } : null,
    historyCoverage: "unverified" as const,
  };
}
