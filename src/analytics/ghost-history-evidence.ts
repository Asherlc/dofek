import { createHash } from "node:crypto";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { ACCOUNT_ERASURE_FENCE_TABLE } from "../metric-stream/clickhouse-table.ts";
import {
  ghostTrackInputVersionsMatchSql,
  ghostTrackInputVersionsSql,
} from "./ghost-track-index.ts";

const historyGroupLimit = 256;

const evidenceSchema = z.object({
  activityId: z.uuid(),
  isAnchor: z.coerce.number(),
  cutoffReached: z.coerce.number(),
  hasEligibleMembers: z.coerce.number(),
  hasGpsEvidence: z.coerce.number(),
  currentIndex: z.coerce.number(),
  indexStatus: z.enum(["missing", "ready", "over-limit"]).nullable(),
  hasMatchableBounds: z.coerce.number(),
  everHadLiveGps: z.coerce.number(),
  snapshot: z.string(),
});

type EvidenceRow = z.infer<typeof evidenceSchema>;
type AnchorStatus = "ready" | "pending" | "unavailable" | "over-limit";

interface GhostHistoryEvidence {
  anchorStatus: AnchorStatus;
  historyGeneration: string | null;
  historyCoverage: "complete" | "partial";
  checkedGroups: number;
  checkedActivityIds: readonly string[];
  incompleteGroups: number;
  cutoffReached: boolean;
}

const unavailableHistory: GhostHistoryEvidence = {
  anchorStatus: "unavailable",
  historyGeneration: null,
  historyCoverage: "partial",
  checkedGroups: 0,
  checkedActivityIds: [],
  incompleteGroups: 0,
  cutoffReached: false,
};

function readAnchorStatus(anchor: EvidenceRow | undefined): AnchorStatus {
  if (!anchor?.hasEligibleMembers || !anchor.hasGpsEvidence) return "unavailable";
  if (!anchor.currentIndex) return "pending";
  if (anchor.indexStatus === "over-limit") return "over-limit";
  return anchor.indexStatus === "ready" && anchor.hasMatchableBounds ? "ready" : "unavailable";
}

function groupNeedsPreparation(row: EvidenceRow): boolean {
  if (!row.hasGpsEvidence) return false;
  if (!row.currentIndex) return true;
  // The aggregate marker remembers prior live GPS, including after deletion.
  if (row.indexStatus === "missing") return Boolean(row.everHadLiveGps);
  return row.indexStatus !== "ready" || !row.hasMatchableBounds;
}

/** Bounded normalized source evidence for one anchor. Match traversal and visibility are separate. */
export async function getGhostHistoryEvidence(
  client: Pick<ClickHouseClient, "query">,
  input: { userId: string; activityId: string },
): Promise<GhostHistoryEvidence> {
  const result = await client.query({
    query: `
      WITH anchor_key AS (
        SELECT {userId:UUID} AS user_id, {activityId:UUID} AS activity_id
        WHERE lower(hex(SHA256(toString({userId:UUID})))) NOT IN (
          SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
        )
      ), anchor_index AS (
        SELECT sport, started_at
        FROM analytics.ghost_track FINAL
        WHERE (user_id, activity_id) IN (SELECT user_id, activity_id FROM anchor_key)
          AND status = 'ready' AND started_at IS NOT NULL
      ), eligible_members AS MATERIALIZED (
        SELECT assumeNotNull(source.user_id) AS user_id,
          assumeNotNull(source.group_id) AS activity_id, source.activity_id AS member_activity_id,
          source.canonical_type AS sport, source.started_at AS started_at
        FROM analytics.activity_source_records AS source FINAL
        WHERE source.user_id IN (SELECT user_id FROM anchor_key) AND source.group_id IS NOT NULL
          AND source.is_deleted = 0 AND source.provider_id != 'strava'
          AND source.canonical_type IN ('running', 'cycling')
          AND (source.modality IS NULL OR source.modality NOT IN ('indoor', 'virtual'))
          AND NOT (
            source.provider_id = 'apple_health'
            AND (
              lowerUTF8(trim(BOTH ' ' FROM coalesce(source.source_name, ''))) = 'strava'
              OR lowerUTF8(trim(BOTH ' ' FROM JSONExtractString(
                coalesce(source.raw, '{}'), 'sourceBundle'
              ))) = 'com.strava.strava'
            )
          )
      ), earlier_members AS MATERIALIZED (
        SELECT member.*
        FROM eligible_members AS member CROSS JOIN (
          SELECT sport AS anchor_sport, started_at AS anchor_started_at FROM anchor_index
        ) AS anchor
        WHERE member.activity_id != {activityId:UUID} AND member.sport = anchor.anchor_sport
          AND (member.started_at < anchor.anchor_started_at OR member.started_at IS NULL)
      ), earlier_groups AS MATERIALIZED (
        SELECT user_id, activity_id, min(started_at) AS history_started_at,
          max(started_at IS NULL) AS unknown_date
        FROM earlier_members
        GROUP BY user_id, activity_id
        ORDER BY history_started_at DESC NULLS FIRST, activity_id DESC
        LIMIT ${historyGroupLimit + 1}
      ), checked_prefix AS (
        SELECT user_id, activity_id, unknown_date FROM earlier_groups
        ORDER BY history_started_at DESC NULLS FIRST, activity_id DESC LIMIT ${historyGroupLimit}
      ), checked_keys AS MATERIALIZED (
        SELECT user_id, activity_id, unknown_date, toUInt8(0) AS is_anchor FROM checked_prefix
        UNION ALL
        SELECT user_id, activity_id, toUInt8(0) AS unknown_date, toUInt8(1) AS is_anchor
        FROM anchor_key
      ), checked_members AS MATERIALIZED (
        SELECT user_id, activity_id, member_activity_id FROM eligible_members
        WHERE (user_id, activity_id) IN (SELECT user_id, activity_id FROM checked_keys)
      ), member_markers AS (
        SELECT user_id, member_activity_id, toUnixTimestamp64Nano(max(changed_at)) AS changed_ns,
          max(has_live_sample) AS ever_live
        FROM analytics.activity_location_member_change
        WHERE user_id = {userId:UUID} AND member_activity_id IN (
          SELECT member_activity_id FROM checked_members
        )
        GROUP BY user_id, member_activity_id
      ), group_markers AS (
        SELECT member.user_id AS user_id, member.activity_id AS activity_id,
          max(marker.changed_ns) AS latest_change_ns, max(marker.ever_live) AS ever_live,
          hex(SHA256(toJSONString(arraySort(groupArray(tuple(
            member.member_activity_id, marker.changed_ns, marker.ever_live
          )))))) AS marker_signature
        FROM checked_members AS member
        LEFT JOIN member_markers AS marker USING (user_id, member_activity_id)
        GROUP BY member.user_id, member.activity_id
      ), ${ghostTrackInputVersionsSql("checked_keys")}, checked_index AS (
        SELECT *
        FROM analytics.ghost_track FINAL
        WHERE (user_id, activity_id) IN (SELECT user_id, activity_id FROM checked_keys)
      )
      SELECT history.activity_id AS activityId, history.is_anchor AS isAnchor,
        toUInt8((SELECT count() FROM earlier_groups) > ${historyGroupLimit}) AS cutoffReached,
        toUInt8(members.member_signature IS NOT NULL) AS hasEligibleMembers,
        toUInt8(gps.gps_refresh_version IS NOT NULL OR markers.latest_change_ns IS NOT NULL
          OR indexed.activity_id IS NOT NULL) AS hasGpsEvidence,
        toUInt8(coalesce(indexed.activity_id IS NOT NULL
          AND (${ghostTrackInputVersionsMatchSql("indexed")})
          AND (markers.latest_change_ns IS NULL OR markers.latest_change_ns <=
            coalesce(gps.gps_source_refreshed_at_ns, 0)), 0)) AS currentIndex,
        indexed.status AS indexStatus,
        toUInt8(coalesce(indexed.started_at IS NOT NULL
          AND indexed.sport IN ('running', 'cycling') AND indexed.point_count >= 2
          AND indexed.min_lat IS NOT NULL AND indexed.max_lat IS NOT NULL
          AND indexed.min_lng IS NOT NULL AND indexed.max_lng IS NOT NULL
          AND (indexed.min_lat < indexed.max_lat OR indexed.min_lng < indexed.max_lng)
          AND (history.is_anchor = 1 OR (
            history.unknown_date = 0 AND indexed.sport = (SELECT sport FROM anchor_index)
            AND indexed.started_at < (SELECT started_at FROM anchor_index)
          )), 0)) AS hasMatchableBounds,
        toUInt8(coalesce(markers.ever_live, 0)) AS everHadLiveGps,
        toJSONString(tuple(
          history.user_id, history.activity_id, history.unknown_date, members.member_signature,
          gps.gps_source_refreshed_at_ns, gps.gps_refresh_version, markers.marker_signature,
          indexed.status, indexed.member_activity_id, indexed.provider_id, indexed.device_id,
          indexed.sport, indexed.modality, indexed.started_at, indexed.ended_at,
          indexed.track_refresh_version, indexed.track_source_refreshed_at_ns,
          indexed.member_source_synced_at_ns, indexed.point_count, currentIndex, hasMatchableBounds
        )) AS snapshot
      FROM checked_keys AS history LEFT JOIN gps USING (user_id, activity_id)
      LEFT JOIN members USING (user_id, activity_id)
      LEFT JOIN group_markers AS markers USING (user_id, activity_id)
      LEFT JOIN checked_index AS indexed USING (user_id, activity_id)
      ORDER BY history.is_anchor DESC, history.activity_id`,
    query_params: input,
    format: "JSONEachRow",
    clickhouse_settings: { join_use_nulls: 1, max_threads: 1, enable_materialized_cte: 1 },
  });
  const [anchor, ...history] = evidenceSchema.array().parse(await result.json());
  const anchorStatus = readAnchorStatus(anchor);
  if (!anchor || anchorStatus !== "ready") return { ...unavailableHistory, anchorStatus };

  const incompleteGroups = history.filter(groupNeedsPreparation).length;
  const cutoffReached = Boolean(anchor.cutoffReached);
  const historyGeneration = createHash("sha256")
    .update(
      JSON.stringify([
        "ghost-history-v1",
        cutoffReached,
        anchor.snapshot,
        history.map((group) => group.snapshot),
      ]),
    )
    .digest("hex");
  return {
    anchorStatus,
    historyGeneration,
    historyCoverage: cutoffReached || incompleteGroups > 0 ? "partial" : "complete",
    checkedGroups: history.length,
    checkedActivityIds: history.map((group) => group.activityId),
    incompleteGroups,
    cutoffReached,
  };
}
