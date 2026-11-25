import { z } from "zod";
import type { ClickHouseClient } from "./clickhouse.ts";

const maximumTrackPoints = 20_000;

const trackMetadataSchema = z.object({
  memberActivityId: z.string(),
  providerId: z.string(),
  deviceId: z.string().nullable(),
  sport: z.enum(["running", "cycling"]),
  modality: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  refreshVersion: z.string(),
  sourceRefreshedAtNs: z.string(),
  memberSourceSyncedAtNs: z.string().nullable(),
});

const trackPointsSchema = z.array(
  z.object({
    timestampMs: z.number(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
  }),
);

/** Reads one independently recorded track for the worker's bounded comparison work. */
export async function getGhostTrack(
  client: Pick<ClickHouseClient, "query">,
  key: { userId: string; activityId: string },
) {
  const result = await client.query({
    query: `
      WITH scoped_samples AS (
        SELECT *
        FROM analytics.activity_ghost_location_sample FINAL
        WHERE user_id = {userId:UUID} AND activity_id = {activityId:UUID}
      ), independent_members AS (
        SELECT activity_id, provider_id, canonical_type, modality, started_at, ended_at, source_synced_at
        FROM analytics.activity_source_records FINAL
        WHERE activity_id IN (SELECT assumeNotNull(member_activity_id) FROM scoped_samples
            WHERE member_activity_id IS NOT NULL)
          AND user_id = {userId:UUID}
          AND group_id = {activityId:UUID}
          AND is_deleted = 0
          AND provider_id != 'strava'
          AND canonical_type IN ('running', 'cycling')
          AND (modality IS NULL OR modality NOT IN ('indoor', 'virtual'))
          -- Match the Ghost GPS source-record evidence for Strava imports.
          AND NOT (
            provider_id = 'apple_health'
            AND (
              lowerUTF8(trim(BOTH ' ' FROM coalesce(source_name, ''))) = 'strava'
              OR lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(
                coalesce(raw, '{}'), 'sourceBundle'
              ))) = 'com.strava.strava'
            )
          )
      ), readings_by_timestamp AS (
        SELECT member_activity_id, provider_id, device_id, recorded_at,
          countIf(is_deleted = 0) AS live_count,
          countIf(is_deleted = 0 AND abs(lat) <= 90 AND abs(lng) <= 180) AS valid_count,
          minIf(lat, is_deleted = 0) = maxIf(lat, is_deleted = 0)
            AND minIf(lng, is_deleted = 0) = maxIf(lng, is_deleted = 0) AS coordinates_agree,
          max(refresh_version) AS refresh_version,
          max(greatest(source_refreshed_at, refreshed_at)) AS source_refreshed_at
        FROM scoped_samples
        GROUP BY member_activity_id, provider_id, device_id, recorded_at
      ), track_candidates AS (
        SELECT member_activity_id, provider_id, device_id,
          -- The matcher treats ties with any missing or disagreeing position as barriers.
          countIf(live_count > 0 AND valid_count = live_count AND coordinates_agree) AS usable_times,
          max(refresh_version) AS refresh_version,
          max(source_refreshed_at) AS source_refreshed_at
        FROM readings_by_timestamp
        GROUP BY member_activity_id, provider_id, device_id
        HAVING sum(live_count) > 0
      ), chosen_track AS (
        SELECT candidate.member_activity_id AS member_activity_id, candidate.provider_id AS provider_id,
          candidate.device_id AS device_id, member.canonical_type AS sport, member.modality AS modality,
          member.started_at AS started_at, member.ended_at AS ended_at,
          member.source_synced_at AS source_synced_at, candidate.refresh_version AS refresh_version,
          candidate.source_refreshed_at AS source_refreshed_at
        FROM track_candidates AS candidate
        INNER JOIN independent_members AS member
          ON candidate.member_activity_id = member.activity_id AND candidate.provider_id = member.provider_id
        ORDER BY candidate.usable_times DESC, candidate.provider_id, candidate.member_activity_id,
          candidate.device_id ASC NULLS LAST
        LIMIT 1
      )
      SELECT track.member_activity_id AS memberActivityId, track.provider_id AS providerId,
        track.device_id AS deviceId, track.sport AS sport, track.modality AS modality,
        formatDateTime(track.started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS startedAt,
        formatDateTime(track.ended_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS endedAt,
        toString(track.refresh_version) AS refreshVersion,
        toString(toUnixTimestamp64Nano(track.source_refreshed_at)) AS sourceRefreshedAtNs,
        toString(toUnixTimestamp64Nano(track.source_synced_at)) AS memberSourceSyncedAtNs,
        toUnixTimestamp64Micro(sample.recorded_at) / 1000 AS timestampMs,
        sample.lat AS lat, sample.lng AS lng
      FROM scoped_samples AS sample
      INNER JOIN chosen_track AS track
        ON sample.member_activity_id = track.member_activity_id AND sample.provider_id = track.provider_id
        AND isNotDistinctFrom(sample.device_id, track.device_id)
      WHERE sample.is_deleted = 0
      ORDER BY sample.recorded_at, sample.source_metric_stream_id
      LIMIT {pointFetchLimit:UInt32}`,
    query_params: { ...key, pointFetchLimit: maximumTrackPoints + 1 },
    format: "JSONEachRow",
  });
  const rows = await result.json();
  const first = rows[0];
  if (!first) return { status: "missing" } as const;

  const metadata = trackMetadataSchema.parse(first);
  if (rows.length > maximumTrackPoints) {
    return { status: "over-limit", ...metadata, pointLimit: maximumTrackPoints } as const;
  }
  return { status: "ready", ...metadata, points: trackPointsSchema.parse(rows) } as const;
}
