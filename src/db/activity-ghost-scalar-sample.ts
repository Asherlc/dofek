import { BLE_HEART_RATE_PROVIDER_ID, WHOOP_BLE_PROVIDER_ID } from "@dofek/providers/push-providers";
import { z } from "zod";
import { ACCOUNT_ERASURE_FENCE_TABLE } from "../metric-stream/clickhouse-table.ts";
import { activityMetricSamplesSql, activityMetricSourceIdSql } from "./activity-metric-query.ts";
import type { ClickHouseClient } from "./clickhouse.ts";

const ghostScalarSampleSchema = z.object({
  id: z.string(),
  member_activity_id: z.string().nullable(),
  channel: z.enum(["heart_rate", "power", "speed", "altitude"]),
  recorded_at: z.iso.datetime(),
  scalar: z.number(),
  provider_id: z.string(),
  device_id: z.string().nullable(),
  source_id: z.string(),
  source_external_id: z.string().nullable(),
  source_type: z.string().nullable(),
  measurement_kind: z.string(),
});

const directBleProviders = [BLE_HEART_RATE_PROVIDER_ID, WHOOP_BLE_PROVIDER_ID];
const independentMemberFilter = `is_deleted = 0
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
  )`;
const directBleFilter = `linked_member_id IS NULL
  AND source_type = 'ble'
  AND provider_id IN {directBleProviders:Array(String)}
  AND notEmpty(coalesce(device_id, ''))`;
const coherentMemberLink = `(member_activity_id IS NULL OR activity_id IS NULL OR member_activity_id = activity_id)`;

interface GhostScalarWindow {
  userId: string;
  activityId: string;
  memberActivityIds: readonly string[];
  startedAt: string;
  endedAt: string;
  fetchLimit?: number;
  channels?: readonly z.infer<typeof ghostScalarSampleSchema.shape.channel>[];
}

/** Reads observations for a verified Ghost activity window. Missing readings stay absent. */
export async function getGhostScalarSamples(
  client: Pick<ClickHouseClient, "query">,
  window: GhostScalarWindow,
): Promise<z.infer<typeof ghostScalarSampleSchema>[]> {
  const result = await client.query({
    query: `
      WITH independent_members AS (
        SELECT activity_id, provider_id
        FROM analytics.activity_source_records FINAL
        WHERE activity_id IN (
            SELECT arrayJoin(CAST({memberActivityIds:Array(String)}, 'Array(UUID)'))
          )
          AND user_id = {userId:UUID}
          AND group_id = {activityId:UUID}
          AND ${independentMemberFilter}
      ), bounded_samples AS (
        SELECT *, coalesce(member_activity_id, activity_id) AS linked_member_id
        FROM (${activityMetricSamplesSql})
        WHERE channel IN ('heart_rate', 'power', 'speed', 'altitude')
          ${window.channels === undefined ? "" : "AND channel IN {ghostChannels:Array(String)}"}
          AND provider_id != 'strava'
          AND ${coherentMemberLink}
      )
      SELECT id, linked_member_id AS member_activity_id, channel,
        formatDateTime(recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
        scalar, provider_id, device_id, ${activityMetricSourceIdSql} AS source_id,
        source_external_id, source_type, measurement_kind
      FROM bounded_samples
      WHERE (linked_member_id, provider_id) IN (SELECT activity_id, provider_id FROM independent_members)
        OR (${directBleFilter} AND EXISTS (SELECT 1 FROM independent_members))
      -- Use the ordinary deduped_sensor priority and tie-breaks on eligible candidates.
      ORDER BY bounded_samples.recorded_at, channel, provider_priority, provider_id,
        channel = 'heart_rate' AND measurement_kind = 'estimated', id
      LIMIT 1 BY channel, bounded_samples.recorded_at
      ${window.fetchLimit === undefined ? "" : "LIMIT {sampleFetchLimit:UInt32}"}`,
    format: "JSONEachRow",
    query_params: {
      userId: window.userId,
      activityId: window.activityId,
      memberActivityIds: window.memberActivityIds,
      windowStartedAt: window.startedAt,
      windowEndedAt: window.endedAt,
      isPointOnly: false,
      directBleProviders,
      ...(window.channels === undefined ? {} : { ghostChannels: window.channels }),
      ...(window.fetchLimit === undefined ? {} : { sampleFetchLimit: window.fetchLimit }),
    },
  });
  return ghostScalarSampleSchema.array().parse(await result.json());
}

export const ghostScalarProofWindowColumns = `window_id UInt16, activity_id UUID,
  member_activity_id UUID, started_at DateTime64(6, 'UTC'), ended_at DateTime64(6, 'UTC')`;
export const ghostScalarProofProviders = { directBleProviders };

interface MeasuredWindow {
  activityId: string;
  memberActivityId: string;
  startedAt: string;
  endedAt: string;
}

export interface GhostScalarWindowProof extends MeasuredWindow {
  count: number;
  digest: string;
}

export function ghostScalarProofWindowRow(window: MeasuredWindow, index: number) {
  return {
    window_id: index,
    activity_id: window.activityId,
    member_activity_id: window.memberActivityId,
    started_at: window.startedAt,
    ended_at: window.endedAt,
  };
}

/** Shared proof for bounded HR/power windows or one selected altitude recording. */
export function ghostScalarProofSql(windowKeys: string, channelScope?: "altitude"): string {
  const altitude = channelScope === "altitude";
  return `
    ghost_scalar_members AS MATERIALIZED (
      SELECT assumeNotNull(group_id) AS group_id, activity_id, provider_id
      FROM analytics.activity_source_records FINAL
      WHERE user_id = {userId:UUID}
        AND (assumeNotNull(group_id), activity_id) IN (
          SELECT activity_id, member_activity_id FROM ${windowKeys}
        )
        AND ${independentMemberFilter}
        ${
          altitude
            ? `AND provider_id = {providerId:String}
        AND lower(hex(SHA256(toString({userId:UUID})))) NOT IN (
          SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
        )`
            : ""
        }
    ), ghost_scalar_inputs AS MATERIALIZED (
      SELECT timed.window_id AS window_id, sample.id AS id, sample.channel AS channel,
        sample.recorded_at AS recorded_at, sample.scalar AS scalar, sample.provider_id AS provider_id,
        sample.provider_priority AS provider_priority, sample.linked_member_id AS linked_member_id,
        sample.device_id AS device_id, sample.source_type AS source_type, sample.measurement_kind AS measurement_kind,
        sample._peerdb_version AS source_version, sample._peerdb_is_deleted AS deleted
      FROM (
        SELECT *, coalesce(member_activity_id, activity_id) AS linked_member_id
        FROM analytics.sensor_scalar_sample FINAL
        WHERE user_id = {userId:UUID}
          ${
            altitude
              ? `AND channel = 'altitude'
          AND provider_id = {providerId:String}
          AND isNotDistinctFrom(device_id, {deviceId:Nullable(String)})
          AND measurement_kind IN ('direct', 'unknown')`
              : "AND channel IN ('heart_rate', 'power')"
          }
          AND recorded_date IN (
            SELECT toDate(arrayJoin(range(toUInt32(toDate(started_at)), toUInt32(toDate(ended_at)) + 1)))
            FROM ${windowKeys}
          )
          AND (activity_id IS NULL OR activity_id IN (SELECT member_activity_id FROM ${windowKeys}))
          AND provider_id != 'strava'
          AND ${coherentMemberLink}
      ) AS sample
      CROSS JOIN ${windowKeys} AS timed
      WHERE sample.recorded_at >= timed.started_at AND sample.recorded_at < timed.ended_at
        AND (
          (timed.activity_id, sample.linked_member_id, sample.provider_id)
            IN (SELECT group_id, activity_id, provider_id FROM ghost_scalar_members)
          AND sample.linked_member_id = timed.member_activity_id
          ${
            altitude
              ? ""
              : `OR (${directBleFilter} AND (timed.activity_id, timed.member_activity_id)
            IN (SELECT group_id, activity_id FROM ghost_scalar_members))`
          }
        )
      ORDER BY window_id, recorded_at, channel, provider_id, id
      LIMIT {ghostScalarFetchLimit:UInt32} BY window_id
    ), ghost_scalar_input_proofs AS (
      SELECT window_id, count() AS raw_count, hex(SHA256(toJSONString(arraySort(groupArray(tuple(
        id, channel, toUnixTimestamp64Micro(recorded_at), scalar, provider_id, provider_priority,
        linked_member_id, device_id, source_type, measurement_kind, source_version, deleted
      )))))) AS digest
      FROM ghost_scalar_inputs
      GROUP BY window_id
    ), ghost_scalar_proofs AS (
      SELECT timed.window_id AS window_id, coalesce(proofs.raw_count, 0) AS raw_count,
        if(raw_count = 0, hex(SHA256('[]')), proofs.digest) AS digest
      FROM ${windowKeys} AS timed LEFT JOIN ghost_scalar_input_proofs AS proofs USING (window_id)
      WHERE (timed.activity_id, timed.member_activity_id)
        IN (SELECT group_id, activity_id FROM ghost_scalar_members)
    )`;
}

const scalarProofRowSchema = z.object({
  raw_count: z.coerce.number(),
  digest: z.string(),
});
const measuredScalarResultSchema = scalarProofRowSchema.extend({
  observations: z.array(
    z.tuple([z.iso.datetime(), z.enum(["heart_rate", "power"]), z.number().nullable(), z.string()]),
  ),
});

/** Readers retain no proof when the raw sentinel was reached. */
export async function getMeasuredGhostScalarWindow(
  client: Pick<ClickHouseClient, "query">,
  userId: string,
  window: MeasuredWindow,
  fetchLimit: number,
) {
  const result = await client.query({
    query: `
      WITH measured_windows AS MATERIALIZED (
        SELECT * FROM format('JSONEachRow', {windowColumns:String}, {window:String})
      ), ${ghostScalarProofSql("measured_windows")}, selected_samples AS (
        SELECT recorded_at, channel, scalar, measurement_kind
        FROM ghost_scalar_inputs
        WHERE deleted = 0 AND (channel != 'heart_rate' OR scalar > 0)
        ORDER BY recorded_at, channel, provider_priority, provider_id,
          channel = 'heart_rate' AND measurement_kind = 'estimated', id
        LIMIT 1 BY channel, recorded_at
      )
      SELECT raw_count, digest, (
        SELECT groupArray(tuple(
          formatDateTime(recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC'),
          channel, if(isFinite(scalar), scalar, NULL), measurement_kind
        )) FROM selected_samples
      ) AS observations
      FROM ghost_scalar_proofs`,
    format: "JSONEachRow",
    query_params: {
      ...ghostScalarProofProviders,
      userId,
      windowColumns: ghostScalarProofWindowColumns,
      window: JSON.stringify(ghostScalarProofWindowRow(window, 0)),
      ghostScalarFetchLimit: fetchLimit,
    },
    clickhouse_settings: {
      date_time_input_format: "best_effort",
      enable_materialized_cte: 1,
      max_threads: 1,
      log_queries: 0,
    },
  });
  const [evidence] = measuredScalarResultSchema.array().parse(await result.json());
  const rawCount = evidence?.raw_count ?? 0;
  if (!evidence || rawCount >= fetchLimit) return { rawCount, observationRows: [], proof: null };
  const proof: GhostScalarWindowProof = { ...window, count: rawCount, digest: evidence.digest };
  return { rawCount, observationRows: evidence.observations, proof };
}

export interface GhostAltitudeWindow extends MeasuredWindow {
  providerId: string;
  deviceId: string | null;
}

export interface GhostAltitudeWindowProof extends GhostAltitudeWindow {
  count: number;
  digest: string;
}

const altitudeFetchLimit = 20_001;
const altitudeWindowLimitMicroseconds = 24 * 60 * 60 * 1_000_000;
const altitudeTimestamp = z.iso.datetime().regex(/:\d{2}(?:\.\d{1,6})?Z$/);
const altitudeResultSchema = scalarProofRowSchema.extend({
  observations: z.array(z.tuple([z.number(), z.number().nullable()])),
});
type AltitudeProofQuery = (
  schema: typeof scalarProofRowSchema,
  query: string,
  params: Record<string, unknown>,
) => Promise<z.infer<typeof scalarProofRowSchema>[]>;

function subMillisecondMicroseconds(timestamp: string): number {
  const [, fraction = ""] = timestamp.slice(0, -1).split(".");
  return Number(fraction.padEnd(6, "0").slice(3));
}

function isBoundedAltitudeWindow({ startedAt, endedAt }: GhostAltitudeWindow): boolean {
  if (
    !altitudeTimestamp.safeParse(startedAt).success ||
    !altitudeTimestamp.safeParse(endedAt).success
  )
    return false;
  const elapsedMicroseconds =
    (Date.parse(endedAt) - Date.parse(startedAt)) * 1_000 +
    subMillisecondMicroseconds(endedAt) -
    subMillisecondMicroseconds(startedAt);
  return elapsedMicroseconds > 0 && elapsedMicroseconds <= altitudeWindowLimitMicroseconds;
}

function altitudeWindowKey({
  activityId,
  memberActivityId,
  providerId,
  deviceId,
  startedAt,
  endedAt,
}: GhostAltitudeWindow): GhostAltitudeWindow {
  return { activityId, memberActivityId, providerId, deviceId, startedAt, endedAt };
}

function altitudeWindowSql(includeObservations: boolean): string {
  return `
    WITH altitude_window AS MATERIALIZED (
      SELECT toUInt16(0) AS window_id, {activityId:UUID} AS activity_id,
        {memberActivityId:UUID} AS member_activity_id,
        parseDateTime64BestEffort({startedAt:String}, 6, 'UTC') AS started_at,
        parseDateTime64BestEffort({endedAt:String}, 6, 'UTC') AS ended_at
    ), ${ghostScalarProofSql("altitude_window", "altitude")}
    SELECT raw_count, digest
    ${
      includeObservations
        ? `, if(raw_count < {ghostScalarFetchLimit:UInt32}, (
      SELECT arraySort(groupArray(tuple(toUnixTimestamp64Micro(recorded_at) / 1000, altitude)))
      FROM (
        SELECT recorded_at, if(live_count > 0 AND finite_count = live_count AND minimum = maximum,
          minimum, NULL) AS altitude
        FROM (
          SELECT recorded_at, countIf(deleted = 0) AS live_count,
            countIf(deleted = 0 AND isFinite(scalar)) AS finite_count,
            minIf(scalar, deleted = 0 AND isFinite(scalar)) AS minimum,
            maxIf(scalar, deleted = 0 AND isFinite(scalar)) AS maximum
          FROM ghost_scalar_inputs
          GROUP BY recorded_at
        )
      )
    ), []) AS observations`
        : ""
    }
    FROM ghost_scalar_proofs
    SETTINGS enable_materialized_cte = 1, max_threads = 1, log_queries = 0`;
}

function altitudeProof(
  window: GhostAltitudeWindow,
  row: z.infer<typeof scalarProofRowSchema>,
): GhostAltitudeWindowProof {
  return { ...window, count: row.raw_count, digest: row.digest };
}

/** Reads compact current evidence for an already verified GPS recording. */
export async function readGhostAltitudeWindowProof(
  query: AltitudeProofQuery,
  userId: string,
  window: GhostAltitudeWindow,
): Promise<GhostAltitudeWindowProof | null> {
  if (!isBoundedAltitudeWindow(window)) return null;
  const key = altitudeWindowKey(window);
  const [row] = await query(scalarProofRowSchema, altitudeWindowSql(false), {
    ...key,
    userId,
    ghostScalarFetchLimit: altitudeFetchLimit,
  });
  return row && row.raw_count < altitudeFetchLimit ? altitudeProof(key, row) : null;
}

/** Reads recorded altitude and its proof together. Conflicts and missing values remain barriers. */
export async function getGhostAltitudeWindow(
  client: Pick<ClickHouseClient, "query">,
  userId: string,
  window: GhostAltitudeWindow,
) {
  if (!isBoundedAltitudeWindow(window)) {
    return { status: "unavailable", observations: [], proof: null } as const;
  }
  const key = altitudeWindowKey(window);
  const result = await client.query({
    query: altitudeWindowSql(true),
    format: "JSONEachRow",
    query_params: { ...key, userId, ghostScalarFetchLimit: altitudeFetchLimit },
  });
  const [row] = altitudeResultSchema.array().parse(await result.json());
  if (!row) return { status: "unavailable", observations: [], proof: null } as const;
  if (row.raw_count >= altitudeFetchLimit) {
    return { status: "over-limit", observations: [], proof: null } as const;
  }
  return {
    status: "ready",
    observations: row.observations.map(([timestampMs, altitudeMeters]) => ({
      timestampMs,
      altitudeMeters,
    })),
    proof: altitudeProof(key, row),
  } as const;
}
