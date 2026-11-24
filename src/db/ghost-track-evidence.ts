import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ghostLocationMemberMarkersSql } from "../analytics/ghost-history-evidence.ts";
import {
  ghostTrackInputVersionsMatchSql,
  ghostTrackInputVersionsSql,
} from "../analytics/ghost-track-index.ts";
import { ACCOUNT_ERASURE_FENCE_TABLE } from "../metric-stream/clickhouse-table.ts";
import type { ClickHouseClient } from "./clickhouse.ts";
import { executeWithSchema } from "./execute-with-schema.ts";
import type { Database } from "./index.ts";

const selectedMemberSchema = z.object({
  activityId: z.uuid(),
  memberActivityId: z.uuid(),
  providerId: z.string(),
});
export type SelectedGhostMember = z.infer<typeof selectedMemberSchema>;
const activeMemberSchema = selectedMemberSchema.extend({
  sport: z.enum(["running", "cycling"]),
  modality: z.string().nullable(),
});

// This field order is used by the persisted Ghost comparison stamp.
export const ghostTrackStampSchema = selectedMemberSchema.extend({
  deviceId: z.string().nullable(),
  sport: z.enum(["running", "cycling"]),
  modality: z.string().nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  refreshVersion: z.string(),
  sourceRefreshedAtNs: z.string(),
  memberSourceSyncedAtNs: z.string().nullable(),
  gpsRefreshVersion: z.string(),
  gpsSourceRefreshedAtNs: z.string(),
  memberSignature: z.string(),
});

const trackEvidenceSchema = z.discriminatedUnion("status", [
  z.object({ activityId: z.uuid(), status: z.enum(["pending", "unavailable"]) }),
  ghostTrackStampSchema.extend({
    status: z.literal("ready"),
    markerSignature: z.string().nullable(),
  }),
]);
export type GhostTrackEvidence = z.infer<typeof trackEvidenceSchema>;

/** Exact selected recording, group source versions and scoped input marker identity. */
export function ghostRouteLabelsSourceVersion(
  source: Extract<GhostTrackEvidence, { status: "ready" }>,
): string {
  return createHash("sha256")
    .update(JSON.stringify([ghostTrackStampSchema.parse(source), source.markerSignature]))
    .digest("hex");
}

type EvidenceKeys = { userId: string; activityIds: readonly string[] };
type EvidenceQuery = (
  schema: typeof trackEvidenceSchema,
  statement: string,
  keys: EvidenceKeys,
) => Promise<GhostTrackEvidence[]>;

/** Reads compact source evidence for already selected owner/activity keys. */
export async function readGhostTrackEvidence(query: EvidenceQuery, keys: EvidenceKeys) {
  const rows = await query(
    trackEvidenceSchema,
    `
    WITH owned_keys AS MATERIALIZED (
      SELECT {userId:UUID} AS user_id, arrayJoin({activityIds:Array(UUID)}) AS activity_id
      WHERE lower(hex(SHA256(toString({userId:UUID})))) NOT IN (
        SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
      )
    ), ${ghostTrackInputVersionsSql("owned_keys")}, checked_members AS MATERIALIZED (
      SELECT assumeNotNull(user_id) AS user_id, assumeNotNull(activity_id) AS activity_id,
        arrayJoin(eligible_member_ids) AS member_activity_id FROM members
    ), ${ghostLocationMemberMarkersSql("checked_members")}, checked_index AS (
      SELECT * FROM analytics.ghost_track FINAL
      WHERE (user_id, activity_id) IN (SELECT user_id, activity_id FROM owned_keys)
    )
    SELECT scope.activity_id AS activityId,
      multiIf(members.member_signature IS NULL OR (gps.gps_refresh_version IS NULL
          AND markers.latest_change_ns IS NULL AND indexed.activity_id IS NULL), 'unavailable',
        NOT coalesce(indexed.activity_id IS NOT NULL
          AND (${ghostTrackInputVersionsMatchSql("indexed")})
          AND (markers.latest_change_ns IS NULL OR markers.latest_change_ns <=
            coalesce(gps.gps_source_refreshed_at_ns, 0)), 0), 'pending',
        indexed.status = 'ready' AND indexed.started_at IS NOT NULL AND indexed.min_lat IS NOT NULL,
          'ready', 'unavailable') AS status,
      indexed.member_activity_id AS memberActivityId,
      indexed.provider_id AS providerId, indexed.device_id AS deviceId, indexed.sport AS sport,
      indexed.modality AS modality,
      formatDateTime(indexed.started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS startedAt,
      formatDateTime(indexed.ended_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS endedAt,
      toString(indexed.track_refresh_version) AS refreshVersion,
      toString(indexed.track_source_refreshed_at_ns) AS sourceRefreshedAtNs,
      toString(indexed.member_source_synced_at_ns) AS memberSourceSyncedAtNs,
      toString(indexed.gps_refresh_version) AS gpsRefreshVersion,
      toString(indexed.gps_source_refreshed_at_ns) AS gpsSourceRefreshedAtNs,
      indexed.member_signature AS memberSignature,
      markers.marker_signature AS markerSignature
    FROM owned_keys AS scope LEFT JOIN gps USING (user_id, activity_id)
    LEFT JOIN members USING (user_id, activity_id)
    LEFT JOIN group_markers AS markers USING (user_id, activity_id)
    LEFT JOIN checked_index AS indexed USING (user_id, activity_id)
    SETTINGS join_use_nulls = 1, max_threads = 1, enable_materialized_cte = 1, log_queries = 0`,
    { ...keys, activityIds: [...new Set(keys.activityIds)] },
  );
  return new Map(rows.map((row) => [row.activityId, row]));
}

export async function getGhostTrackEvidence(
  client: Pick<ClickHouseClient, "query">,
  key: { userId: string; activityId: string },
) {
  const tracks = await readGhostTrackEvidence(
    async (schema, query, queryParams) => {
      const result = await client.query({
        query,
        query_params: queryParams,
        format: "JSONEachRow",
      });
      return schema.array().parse(await result.json());
    },
    { userId: key.userId, activityIds: [key.activityId] },
  );
  return tracks.get(key.activityId);
}

/** Verifies the exact selected sources on the primary PostgreSQL database. */
export async function resolveActiveGhostMembers(
  db: Pick<Database, "execute">,
  userId: string,
  memberIds: readonly string[],
) {
  if (memberIds.length === 0) return new Map<string, z.infer<typeof activeMemberSchema>>();
  const ids = sql.join(
    memberIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await executeWithSchema(
    db,
    activeMemberSchema,
    sql`
    SELECT group_id::text AS "activityId", id::text AS "memberActivityId", provider_id AS "providerId",
      canonical_type::text AS sport, modality::text AS modality
    FROM fitness.activity
    WHERE user_id = ${userId}::uuid AND id IN (${ids}) AND group_id IS NOT NULL
      AND deleted_at IS NULL AND provider_absent_at IS NULL
      AND provider_id != 'strava'
      AND canonical_type IN ('running', 'cycling')
      AND (modality IS NULL OR modality NOT IN ('indoor', 'virtual'))
      AND NOT (
        provider_id = 'apple_health'
        AND (
          lower(btrim(coalesce(source_name, ''))) = 'strava'
          OR lower(btrim(coalesce(raw->>'sourceName', ''))) = 'strava'
          OR lower(btrim(coalesce(raw->>'sourceBundle', ''))) = 'com.strava.strava'
        )
      )`,
  );
  return new Map(rows.map((member) => [member.memberActivityId, member]));
}

export function hasActiveGhostMember(
  active: ReadonlyMap<string, SelectedGhostMember>,
  expected: SelectedGhostMember,
): boolean {
  const member = active.get(expected.memberActivityId);
  return member?.activityId === expected.activityId && member.providerId === expected.providerId;
}
