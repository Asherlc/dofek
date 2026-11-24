import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type GhostScalarWindowProof,
  getMeasuredGhostScalarWindow,
  ghostScalarProofProviders,
  ghostScalarProofSql,
  ghostScalarProofWindowColumns,
  ghostScalarProofWindowRow,
} from "../db/activity-ghost-scalar-sample.ts";
import { getGhostTrack } from "../db/activity-ghost-track.ts";
import { ghostSessionPageColumns } from "../db/ghost-session-result-schema.ts";
import { ACCOUNT_ERASURE_FENCE_TABLE } from "../metric-stream/clickhouse-table.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";
import {
  type GhostRouteMatchResult,
  matchGhostRoutes,
  summarizeGhostTrack,
} from "./ghost-route-matching.ts";
import {
  type GhostSessionScalarObservation,
  measureGhostSession,
} from "./ghost-session-measurement.ts";
import {
  ghostTrackInputVersionsMatchSql,
  ghostTrackInputVersionsSql,
  listGhostTrackCandidates,
} from "./ghost-track-index.ts";

type ProjectionOwner = Pick<AnalyticsQueryOwner, "client" | "assertActive">;
type ProjectionClient = ProjectionOwner["client"];
type Match = GhostRouteMatchResult["matches"][number];
type ReadyTrack = Extract<Awaited<ReturnType<typeof getGhostTrack>>, { status: "ready" }>;
type PageCursor = NonNullable<Awaited<ReturnType<typeof listGhostTrackCandidates>>["nextCursor"]>;

interface PageRequest {
  userId: string;
  activityId: string;
  historyGeneration: string;
  sourceHistoryCoverage: "unverified" | "complete";
  candidateActivityIds?: readonly string[];
  before?: PageCursor;
}

const matchLimit = 32;
const scalarFetchLimitPerInterval = 4_001;
const scalarRowsPerPage = 20_000;
const scalarWindowMilliseconds = 24 * 60 * 60 * 1_000;
const unavailablePage = { nextCursor: null, historyCoverage: "unverified" } as const;
const pageReceiptSchema = z.object({
  payloadDigest: z.string(),
  refreshVersion: z.string(),
  bounded: z.coerce.number().transform((value) => value !== 0),
});
const historyGenerationSchema = z.string().min(1).max(256);
const trackStampSchema = z.object({
  activityId: z.uuid(),
  memberActivityId: z.uuid(),
  providerId: z.string(),
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
type TrackStamp = z.infer<typeof trackStampSchema>;

interface SavedMatch {
  section_id: string;
  pass_id: string;
  match_kind: Match["kind"];
  anchor_interval: string;
  candidate_activity_id: string;
  candidate_started_at: string;
  candidate_pass_started_at_ms: number;
  candidate_pass_ended_at_ms: number;
  candidate_elapsed_ms: number;
  candidate_stamp: string;
  scalar_proof: GhostScalarWindowProof[];
  comparison: string;
}

const ownerCanPublish = `lower(hex(SHA256(toString({userId:UUID})))) NOT IN (
  SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL
)`;
const settings = {
  join_use_nulls: 1,
  max_threads: 1,
  enable_materialized_cte: 1,
  log_queries: 0,
  date_time_input_format: "best_effort",
} as const;

function fingerprint(values: unknown): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function cursorKey(cursor: PageCursor): string {
  return JSON.stringify([cursor.startedAt, cursor.activityId]);
}

function exactUtc(timestampMs: number): string {
  const wholeMs = Math.floor(timestampMs);
  const fractionalMicros = Math.round((timestampMs - wholeMs) * 1_000);
  return new Date(wholeMs + Math.floor(fractionalMicros / 1_000))
    .toISOString()
    .replace("Z", `${String(fractionalMicros % 1_000).padStart(3, "0")}Z`);
}

async function queryRows<Schema extends z.ZodType>(
  client: ProjectionClient,
  schema: Schema,
  query: string,
  queryParams: Record<string, unknown>,
): Promise<z.infer<Schema>[]> {
  const result = await client.query({
    query,
    query_params: queryParams,
    format: "JSONEachRow",
    clickhouse_settings: settings,
  });
  return schema.array().parse(await result.json());
}

async function currentAnchorStamp(client: ProjectionClient, input: PageRequest) {
  const [stamp] = await queryRows(
    client,
    trackStampSchema,
    `WITH anchor_key AS MATERIALIZED (
      SELECT * FROM analytics.ghost_track FINAL
      WHERE user_id = {userId:UUID} AND activity_id = {activityId:UUID}
        AND status = 'ready' AND started_at IS NOT NULL AND min_lat IS NOT NULL
    ), ${ghostTrackInputVersionsSql("anchor_key")}
    SELECT indexed.activity_id AS activityId, indexed.member_activity_id AS memberActivityId,
      indexed.provider_id AS providerId, indexed.device_id AS deviceId, indexed.sport AS sport,
      indexed.modality AS modality,
      formatDateTime(indexed.started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS startedAt,
      formatDateTime(indexed.ended_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS endedAt,
      toString(indexed.track_refresh_version) AS refreshVersion,
      toString(indexed.track_source_refreshed_at_ns) AS sourceRefreshedAtNs,
      toString(indexed.member_source_synced_at_ns) AS memberSourceSyncedAtNs,
      toString(indexed.gps_refresh_version) AS gpsRefreshVersion,
      toString(indexed.gps_source_refreshed_at_ns) AS gpsSourceRefreshedAtNs,
      indexed.member_signature AS memberSignature
    FROM anchor_key AS indexed
    LEFT JOIN gps USING (user_id, activity_id)
    LEFT JOIN members USING (user_id, activity_id)
    WHERE ${ghostTrackInputVersionsMatchSql("indexed")} AND ${ownerCanPublish}`,
    { userId: input.userId, activityId: input.activityId },
  );
  return stamp;
}

function matchesSelectedTrack(
  track: Awaited<ReturnType<typeof getGhostTrack>>,
  stamp: TrackStamp,
): track is ReadyTrack {
  return (
    track.status === "ready" &&
    track.memberActivityId === stamp.memberActivityId &&
    track.providerId === stamp.providerId &&
    track.deviceId === stamp.deviceId &&
    track.sport === stamp.sport &&
    track.modality === stamp.modality &&
    track.refreshVersion === stamp.refreshVersion &&
    track.sourceRefreshedAtNs === stamp.sourceRefreshedAtNs &&
    track.memberSourceSyncedAtNs === stamp.memberSourceSyncedAtNs &&
    (track.startedAt === null || track.startedAt === stamp.startedAt) &&
    (track.endedAt === null || track.endedAt === stamp.endedAt)
  );
}

function scalarReader(client: ProjectionClient, userId: string) {
  let remaining = scalarRowsPerPage;
  return async (activity: TrackStamp, interval: Match["anchor"]) => {
    const fetchLimit = Math.min(scalarFetchLimitPerInterval, remaining);
    if (fetchLimit < 2 || interval.elapsedMs > scalarWindowMilliseconds) return { proof: null };
    const { observationRows, proof, rawCount } = await getMeasuredGhostScalarWindow(
      client,
      userId,
      {
        activityId: activity.activityId,
        memberActivityId: activity.memberActivityId,
        startedAt: exactUtc(interval.start.timestampMs),
        endedAt: exactUtc(interval.end.timestampMs),
      },
      fetchLimit,
    );
    remaining -= rawCount;
    const heartRateBpm: GhostSessionScalarObservation[] = [];
    const powerWatts: GhostSessionScalarObservation[] = [];
    for (const [recordedAt, channel, value, measurementKind] of observationRows) {
      const observation = {
        recordedAt,
        value,
        isEstimated: measurementKind === "estimated",
      };
      if (channel === "heart_rate") heartRateBpm.push(observation);
      if (channel === "power") powerWatts.push(observation);
    }
    return { heartRateBpm, powerWatts, proof };
  };
}

async function makeSavedMatch(
  readScalars: ReturnType<typeof scalarReader>,
  anchor: TrackStamp,
  candidate: TrackStamp,
  match: Match,
): Promise<SavedMatch> {
  const sectionId = fingerprint([
    anchor.activityId,
    match.anchor.start.timestampMs,
    match.anchor.end.timestampMs,
  ]);
  const passId = fingerprint([
    sectionId,
    candidate.activityId,
    match.candidate.start.timestampMs,
    match.candidate.end.timestampMs,
  ]);
  const anchorObservations = await readScalars(anchor, match.anchor);
  const candidateObservations = await readScalars(candidate, match.candidate);
  const comparison = measureGhostSession({
    match,
    sport: anchor.sport,
    anchorObservations,
    candidateObservations,
  });
  const measured =
    comparison.metrics.heartRateBpm !== null || comparison.metrics.powerWatts !== null;
  const scalarProof = measured ? [anchorObservations.proof, candidateObservations.proof] : [];
  if (scalarProof.some((proof) => proof === null))
    throw new Error("Measured Ghost Sessions metrics require a scalar proof for each interval");
  return {
    section_id: sectionId,
    pass_id: passId,
    match_kind: match.kind,
    anchor_interval: JSON.stringify(comparison.anchor),
    candidate_activity_id: candidate.activityId,
    candidate_started_at: candidate.startedAt,
    candidate_pass_started_at_ms: comparison.candidate.start.timestampMs,
    candidate_pass_ended_at_ms: comparison.candidate.end.timestampMs,
    candidate_elapsed_ms: comparison.candidate.elapsedMs,
    candidate_stamp: JSON.stringify(candidate),
    scalar_proof: scalarProof.filter((proof) => proof !== null),
    comparison: JSON.stringify(comparison),
  };
}

const evidenceColumns = `user_id UUID, activity_id UUID, gps_source_refreshed_at_ns Int64,
  gps_refresh_version UInt64, member_signature String`;
const currentEvidenceSql = `evidence_keys AS MATERIALIZED (
  SELECT * FROM format('JSONEachRow', {evidenceColumns:String}, {evidence:String})
), ${ghostTrackInputVersionsSql("evidence_keys")}, current_evidence AS (
  SELECT count() AS count
  FROM evidence_keys AS observed
  LEFT JOIN gps USING (user_id, activity_id)
  LEFT JOIN members USING (user_id, activity_id)
  WHERE ${ghostTrackInputVersionsMatchSql("observed")}
)`;
const publicationFence = `(SELECT count FROM current_evidence) = {evidenceCount:UInt16}
  AND ${ownerCanPublish}`;
const pageKeySql = `user_id = {userId:UUID} AND activity_id = {activityId:UUID}
  AND anchor_generation = {anchorGeneration:String} AND history_generation = {historyGeneration:String}
  AND request_cursor = {requestCursor:String}`;

const currentScalarEvidenceSql = `measured_windows AS MATERIALIZED (
  SELECT * FROM format('JSONEachRow', {scalarWindowColumns:String}, {scalarProofs:String})
), ${ghostScalarProofSql("measured_windows")}, matched_scalar_windows AS (
  SELECT count() AS count
  FROM measured_windows AS recorded
  INNER JOIN ghost_scalar_proofs AS current USING (window_id)
  WHERE current.raw_count = recorded.expected_count AND current.digest = recorded.expected_digest
)`;

async function publishPage(
  owner: ProjectionOwner,
  input: PageRequest,
  anchor: TrackStamp,
  results: {
    observed: TrackStamp[];
    nextCursor: PageCursor | null;
    matches: SavedMatch[];
    bounded: boolean;
    anchorSummary: ReturnType<typeof summarizeGhostTrack> | null;
  },
) {
  const { observed, nextCursor, matches, bounded, anchorSummary } = results;
  const anchorGeneration = fingerprint(anchor);
  const requestCursor = input.before ? cursorKey(input.before) : "";
  const page = {
    user_id: input.userId,
    activity_id: input.activityId,
    anchor_generation: anchorGeneration,
    history_generation: input.historyGeneration,
    request_cursor: requestCursor,
    next_cursor: nextCursor ? cursorKey(nextCursor) : null,
    anchor_stamp: JSON.stringify(anchor),
    anchor_summary: anchorSummary ? JSON.stringify(anchorSummary) : null,
    source_history_coverage: input.sourceHistoryCoverage,
    history_coverage: "unverified",
    bounded: Number(bounded),
    matches: matches.map((match) => ({
      ...match,
      scalar_proof: JSON.stringify(match.scalar_proof),
    })),
  };
  const evidence = observed
    .map((stamp) =>
      JSON.stringify({
        user_id: input.userId,
        activity_id: stamp.activityId,
        gps_source_refreshed_at_ns: stamp.gpsSourceRefreshedAtNs,
        gps_refresh_version: stamp.gpsRefreshVersion,
        member_signature: stamp.memberSignature,
      }),
    )
    .join("\n");
  const payloadDigest = fingerprint([page, evidence]);
  const uniqueProofs = new Map<string, GhostScalarWindowProof>();
  for (const match of matches) {
    for (const proof of match.scalar_proof) uniqueProofs.set(JSON.stringify(proof), proof);
  }
  const proofs = [...uniqueProofs.values()];
  const proofCtes = proofs.length
    ? `${currentEvidenceSql}, ${currentScalarEvidenceSql}`
    : currentEvidenceSql;
  const proofFence = proofs.length
    ? `${publicationFence} AND (SELECT count FROM matched_scalar_windows) = {scalarWindowCount:UInt16}`
    : publicationFence;
  const params = {
    userId: input.userId,
    activityId: input.activityId,
    historyGeneration: input.historyGeneration,
    anchorGeneration,
    requestCursor,
    evidenceColumns,
    evidence,
    evidenceCount: observed.length,
    payloadDigest,
    ...(proofs.length
      ? {
          ...ghostScalarProofProviders,
          ghostScalarFetchLimit: scalarFetchLimitPerInterval,
          scalarWindowColumns: `${ghostScalarProofWindowColumns}, expected_count UInt32, expected_digest String`,
          scalarProofs: proofs
            .map((proof, index) =>
              JSON.stringify({
                ...ghostScalarProofWindowRow(proof, index),
                expected_count: proof.count,
                expected_digest: proof.digest,
              }),
            )
            .join("\n"),
          scalarWindowCount: proofs.length,
        }
      : {}),
  };
  await owner.assertActive();
  await owner.client.command({
    query: `INSERT INTO analytics.ghost_session_page
      WITH prepared_page AS MATERIALIZED (
        SELECT * FROM input({pageColumns:String})
      ), ${proofCtes}, previous_page AS (
        SELECT user_id, activity_id, anchor_generation, history_generation, request_cursor,
          payload_digest, refresh_version
        FROM analytics.ghost_session_page FINAL WHERE ${pageKeySql}
      )
      SELECT prepared.*, greatest(toUInt64(toUnixTimestamp64Nano(now64(9))),
        coalesce(previous.refresh_version, 0) + 1) AS refresh_version
      FROM prepared_page AS prepared
      LEFT JOIN previous_page AS previous
        USING (user_id, activity_id, anchor_generation, history_generation, request_cursor)
      WHERE ${proofFence}
        AND (previous.payload_digest IS NULL OR previous.payload_digest != prepared.payload_digest)
      FORMAT JSONEachRow
      ${JSON.stringify({ ...page, payload_digest: payloadDigest })}`,
    query_params: {
      ...params,
      pageColumns: ghostSessionPageColumns,
    },
    clickhouse_settings: settings,
  });
  // Confirm a current publication before exposing its cursor, including unchanged retries.
  const [pageReceipt] = await queryRows(
    owner.client,
    pageReceiptSchema,
    `WITH ${proofCtes}
      SELECT payload_digest AS payloadDigest, toString(refresh_version) AS refreshVersion, bounded
      FROM analytics.ghost_session_page FINAL
      WHERE ${pageKeySql} AND payload_digest = {payloadDigest:String} AND ${proofFence}`,
    params,
  );
  return pageReceipt ? { anchorGeneration, pageReceipt } : null;
}

/** Projects one bounded candidate page under the owned analytics publication context. */
export async function projectGhostSessionsPage(owner: ProjectionOwner, input: PageRequest) {
  historyGenerationSchema.parse(input.historyGeneration);
  await owner.assertActive();
  const anchor = await currentAnchorStamp(owner.client, input);
  if (!anchor) return { status: "unavailable", ...unavailablePage } as const;
  const anchorTrack = await getGhostTrack(owner.client, input);
  if (!matchesSelectedTrack(anchorTrack, anchor))
    return { status: "stale", ...unavailablePage } as const;
  const page = await listGhostTrackCandidates(owner.client, {
    userId: input.userId,
    anchorActivityId: input.activityId,
    candidateActivityIds: input.candidateActivityIds,
    before: input.before,
  });

  const readScalars = scalarReader(owner.client, input.userId);
  const observed = [anchor];
  const matches: SavedMatch[] = [];
  let bounded = false;
  const measureMatches = async (candidate: TrackStamp, track: ReadyTrack) => {
    const aligned = matchGhostRoutes(anchorTrack.points, track.points);
    bounded ||=
      aligned.status === "bounded" ||
      aligned.candidateCoverage !== "complete" ||
      aligned.anchorCoverage !== "complete";
    for (const match of aligned.matches) {
      if (match.candidate.end.timestampMs > match.anchor.start.timestampMs) continue;
      if (matches.length >= matchLimit) {
        bounded = true;
        break;
      }
      matches.push(await makeSavedMatch(readScalars, anchor, candidate, match));
    }
  };

  if (input.before === undefined) await measureMatches(anchor, anchorTrack);
  for (const entry of page.candidates) {
    if (matches.length >= matchLimit) {
      bounded = true;
      break;
    }
    const candidate = trackStampSchema.parse(entry);
    const track = await getGhostTrack(owner.client, {
      userId: input.userId,
      activityId: candidate.activityId,
    });
    if (!matchesSelectedTrack(track, candidate))
      return { status: "stale", ...unavailablePage } as const;
    observed.push(candidate);
    await measureMatches(candidate, track);
  }

  const publication = await publishPage(owner, input, anchor, {
    observed,
    nextCursor: page.nextCursor,
    matches,
    bounded,
    anchorSummary: input.before === undefined ? summarizeGhostTrack(anchorTrack.points) : null,
  });
  return publication === null
    ? ({ status: "stale", ...unavailablePage } as const)
    : ({
        status: "published",
        ...publication,
        nextCursor: page.nextCursor,
        historyCoverage: page.historyCoverage,
      } as const);
}
