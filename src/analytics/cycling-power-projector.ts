import { normalizedPower, type PowerCoveragePolicy } from "@dofek/cycling-power/power";
import {
  estimateThreshold,
  type HistoryPolicy,
  projectThresholdHistory,
  type ReferenceCurve,
  type ThresholdPolicy,
} from "@dofek/cycling-power/threshold";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { ACCOUNT_ERASURE_FENCE_TABLE } from "../metric-stream/clickhouse-table.ts";

const NP_ALGORITHM_VERSION = "elapsed-power-full-30s-v1";
const ACTIVITY_BATCH_SIZE = 100;
const USER_BATCH_SIZE = 32;

export interface CyclingPowerPolicy {
  coveragePolicy: PowerCoveragePolicy;
  referenceCurves: readonly ReferenceCurve[];
  thresholdPolicy: ThresholdPolicy;
  historyPolicy: HistoryPolicy;
  modelVersion: string;
}

export interface CyclingPowerProjectionResult {
  pendingActivities: number;
  pendingUsers: number;
  projectedUsers: number;
}

const sourceSchema = z.object({
  user_id: z.string().uuid(),
  activity_id: z.string().uuid(),
  started_seconds: z.coerce.number(),
  elapsed_seconds: z.coerce.number(),
  source_refresh_version: z.string(),
  is_deleted: z.coerce.number(),
  canonical_type: z.string(),
});
const userSchema = z.object({
  user_id: z.string().uuid(),
  source_refresh_version: z.string(),
  pending_activities: z.coerce.number(),
  np_refresh_version: z.string(),
});
const countSchema = z.object({ count: z.coerce.number() });

// Include tombstones in each watermark so corrections and removed sources dirty
// downstream histories even when the former strongest evidence is now absent.
const accountIsWritable = `lower(hex(SHA256(toString({userId:UUID})))) NOT IN (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL)`;

const sources = `
  sample_versions AS (
    SELECT user_id, activity_id, max(refresh_version) AS version
    FROM analytics.activity_sensor_sample
    GROUP BY user_id, activity_id
  ),
  effort_versions AS (
    SELECT user_id, activity_id, max(refresh_version) AS version
    FROM analytics.activity_power_curve GROUP BY user_id, activity_id
  ),
  activity_sources AS (
    SELECT summary.user_id AS user_id, summary.activity_id AS activity_id,
      coalesce(toFloat64(toUnixTimestamp64Milli(summary.started_at)) / 1000, 0) AS started_seconds,
      greatest(coalesce(dateDiff('second', summary.started_at, summary.ended_at), 0), 0) AS elapsed_seconds,
      greatest(summary.refresh_version, coalesce(samples.version, 0), coalesce(efforts.version, 0)) AS source_refresh_version,
      summary.is_deleted AS is_deleted,
      coalesce(summary.canonical_type, '') AS canonical_type
    FROM analytics.activity_summary_rows AS summary FINAL
    LEFT JOIN sample_versions AS samples USING (user_id, activity_id)
    LEFT JOIN effort_versions AS efforts USING (user_id, activity_id)
    WHERE (coalesce(summary.power_sample_count, 0)>0 OR summary.canonical_type='cycling')
      AND (summary.is_deleted=1 OR (summary.started_at IS NOT NULL AND summary.ended_at IS NOT NULL
        AND summary.ended_at <= fromUnixTimestamp64Milli({asOfMilliseconds:Int64})))
      AND lower(hex(SHA256(toString(summary.user_id)))) NOT IN (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL)
  ),
  observations AS (SELECT * FROM analytics.cycling_power_observation_rows FINAL
    WHERE lower(hex(SHA256(toString(user_id)))) NOT IN (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL)),
  source_state AS (
    SELECT source.*,
      observation.activity_id IS NULL OR observation.source_refresh_version != source.source_refresh_version
        OR observation.is_deleted != source.is_deleted OR observation.model_version != {npVersion:String} AS dirty
    FROM activity_sources AS source
    LEFT JOIN observations AS observation USING (user_id, activity_id)
    UNION ALL
    SELECT observation.user_id AS user_id, observation.activity_id AS activity_id, 0 AS started_seconds, 0 AS elapsed_seconds,
      observation.refresh_version AS source_refresh_version, toUInt8(1) AS is_deleted, '' AS canonical_type,
      observation.is_deleted = 0 OR observation.model_version != {npVersion:String} AS dirty
    FROM observations AS observation
    LEFT JOIN activity_sources AS source USING (user_id, activity_id)
    WHERE source.activity_id IS NULL
  )`;

let previousRefreshVersion = 0n;
function refreshVersion(): string {
  const clock = BigInt(Date.now()) * 1_000_000n;
  previousRefreshVersion = clock > previousRefreshVersion ? clock : previousRefreshVersion + 1n;
  return previousRefreshVersion.toString();
}

async function rows<TSchema extends z.ZodType>(
  client: ClickHouseClient,
  schema: TSchema,
  query: string,
  queryParams: Record<string, unknown>,
): Promise<z.infer<TSchema>[]> {
  const result = await client.query({
    query,
    query_params: queryParams,
    format: "JSONEachRow",
    clickhouse_settings: { join_use_nulls: 1, max_threads: 1 },
  });
  return z.array(schema).parse(await result.json());
}

/** Incrementally compute native activity NP, then atomically replay ready users. */
export async function projectCyclingPower(
  client: ClickHouseClient,
  policy: CyclingPowerPolicy,
  asOf: Date = new Date(),
): Promise<CyclingPowerProjectionResult> {
  if (!Number.isFinite(asOf.getTime()))
    throw new Error("Cycling power projection requires a valid date");
  const coverage = policy.coveragePolicy;
  const npVersion = [
    NP_ALGORITHM_VERSION,
    coverage.maximumHoldSeconds,
    coverage.minimumGapSeconds,
    coverage.gapIntervalMultiplier,
    coverage.maximumGapSeconds,
  ].join(":");
  const params = {
    npVersion,
    modelVersion: policy.modelVersion,
    asOfDay: asOf.toISOString().slice(0, 10),
    asOfMilliseconds: asOf.getTime(),
  };
  const dirtyActivities = await rows(
    client,
    sourceSchema,
    `WITH ${sources}
    SELECT user_id, activity_id, started_seconds, elapsed_seconds,
      toString(source_refresh_version) AS source_refresh_version, is_deleted, canonical_type
    FROM source_state WHERE dirty
    ORDER BY source_refresh_version, user_id, activity_id LIMIT ${ACTIVITY_BATCH_SIZE}`,
    params,
  );
  for (const activity of dirtyActivities) {
    let np: number | null = null;
    if (!activity.is_deleted && activity.elapsed_seconds > 0) {
      const samples = await rows(
        client,
        z.object({
          at_seconds: z.coerce.number(),
          watts: z.union([z.number(), z.string(), z.null()]),
        }),
        `SELECT toFloat64(toUnixTimestamp64Milli(recorded_at)) / 1000 AS at_seconds, scalar AS watts
         FROM analytics.activity_sensor_sample FINAL
         WHERE user_id={userId:UUID} AND activity_id={activityId:UUID} AND channel='power' AND is_deleted=0
           AND recorded_at >= fromUnixTimestamp64Milli({startMilliseconds:Int64})
           AND recorded_at < fromUnixTimestamp64Milli({endMilliseconds:Int64})
         ORDER BY recorded_at`,
        {
          userId: activity.user_id,
          activityId: activity.activity_id,
          startMilliseconds: Math.round(activity.started_seconds * 1000),
          endMilliseconds: Math.round((activity.started_seconds + activity.elapsed_seconds) * 1000),
        },
      );
      np = normalizedPower(
        samples.map((sample) => {
          const watts = sample.watts === null ? null : Number(sample.watts);
          return {
            elapsedSeconds: sample.at_seconds - activity.started_seconds,
            watts: watts !== null && Number.isFinite(watts) && watts >= 0 ? watts : null,
          };
        }),
        activity.elapsed_seconds,
        policy.coveragePolicy,
      );
    }
    await client.command({
      query: `INSERT INTO analytics.cycling_power_observation_rows
        (user_id,activity_id,normalized_power,source_refresh_version,is_deleted,model_version,refresh_version,refreshed_at)
        SELECT {userId:UUID},{activityId:UUID},{normalizedPower:Nullable(Float64)},
          {sourceVersion:UInt64},{isDeleted:UInt8},{modelVersion:String},{refreshVersion:UInt64},
          parseDateTime64BestEffort({refreshedAt:String},6)
        WHERE ${accountIsWritable}`,
      query_params: {
        userId: activity.user_id,
        activityId: activity.activity_id,
        normalizedPower: np,
        sourceVersion: activity.source_refresh_version,
        isDeleted: activity.is_deleted,
        modelVersion: npVersion,
        refreshVersion: refreshVersion(),
        refreshedAt: asOf.toISOString(),
      },
      clickhouse_settings: { log_queries: 0 },
    });
  }
  const userState = `WITH ${sources},
    user_sources AS (
      SELECT user_id, max(source_refresh_version) AS source_refresh_version, countIf(dirty) AS pending_activities
      FROM source_state GROUP BY user_id
    ),
    np_versions AS (SELECT user_id,max(refresh_version) AS np_refresh_version FROM observations GROUP BY user_id),
    histories AS (SELECT * FROM analytics.cycling_power_history_rows FINAL),
    dirty_users AS (
      SELECT source.user_id AS user_id, source.source_refresh_version AS source_refresh_version, source.pending_activities AS pending_activities, np.np_refresh_version AS np_refresh_version
      FROM user_sources AS source LEFT JOIN histories AS history USING (user_id)
      LEFT JOIN np_versions AS np ON np.user_id=source.user_id
      WHERE history.user_id IS NULL OR history.source_refresh_version != source.source_refresh_version
        OR history.as_of_day != toDate({asOfDay:String}) OR history.model_version != {modelVersion:String}
        OR source.pending_activities > 0 OR history.refresh_version < np.np_refresh_version
    )`;
  const readyUsers = await rows(
    client,
    userSchema,
    `${userState}
    SELECT user_id,toString(source_refresh_version) AS source_refresh_version,pending_activities,toString(np_refresh_version) AS np_refresh_version
    FROM dirty_users WHERE pending_activities=0 ORDER BY user_id LIMIT ${USER_BATCH_SIZE}`,
    params,
  );
  const publishedVersions = new Map<string, string>();
  for (const user of readyUsers) {
    const activities = await rows(
      client,
      sourceSchema.extend({ normalized_power: z.coerce.number().nullable() }),
      `WITH ${sources}
      SELECT source.user_id,source.activity_id,source.started_seconds,source.elapsed_seconds,
        toString(source.source_refresh_version) AS source_refresh_version,source.is_deleted,source.canonical_type AS canonical_type,
        observation.normalized_power
      FROM source_state AS source INNER JOIN observations AS observation USING (user_id,activity_id)
      WHERE source.user_id={userId:UUID} AND source.is_deleted=0 AND source.elapsed_seconds>0 AND source.canonical_type='cycling'
      ORDER BY source.started_seconds,source.activity_id`,
      { ...params, userId: user.user_id },
    );
    const effortRows = await rows(
      client,
      z.object({
        activity_id: z.string().uuid(),
        duration_seconds: z.coerce.number(),
        best_power: z.coerce.number(),
      }),
      `SELECT activity_id,duration_seconds,best_power FROM analytics.activity_power_curve FINAL
       WHERE user_id={userId:UUID} AND is_deleted=0
       ORDER BY activity_id,duration_seconds`,
      { userId: user.user_id },
    );
    const effortsByActivity = new Map<string, { durationSeconds: number; watts: number }[]>();
    for (const effort of effortRows) {
      const efforts = effortsByActivity.get(effort.activity_id) ?? [];
      efforts.push({ durationSeconds: effort.duration_seconds, watts: effort.best_power });
      effortsByActivity.set(effort.activity_id, efforts);
    }
    const history = projectThresholdHistory(
      activities.map((activity) => ({
        id: activity.activity_id,
        atSeconds: activity.started_seconds,
        durationSeconds: activity.elapsed_seconds,
        normalizedPowerWatts: activity.normalized_power,
        candidate: estimateThreshold(
          effortsByActivity.get(activity.activity_id) ?? [],
          policy.referenceCurves,
          policy.thresholdPolicy,
        ),
      })),
      asOf.getTime() / 1000,
      policy.historyPolicy,
    );
    const stillReady = await rows(
      client,
      userSchema,
      `${userState}
      SELECT user_id,toString(source_refresh_version) AS source_refresh_version,pending_activities,toString(np_refresh_version) AS np_refresh_version
      FROM dirty_users WHERE user_id={userId:UUID}`,
      { ...params, userId: user.user_id },
    );
    if (
      stillReady[0]?.pending_activities !== 0 ||
      stillReady[0]?.source_refresh_version !== user.source_refresh_version ||
      stillReady[0]?.np_refresh_version !== user.np_refresh_version
    )
      continue;
    const publicationVersion = refreshVersion();
    await client.command({
      query: `INSERT INTO analytics.cycling_power_history_rows
        (user_id,source_refresh_version,as_of_day,model_version,refresh_version,refreshed_at,events)
        SELECT {userId:UUID},{sourceVersion:UInt64},toDate({asOfDay:String}),{modelVersion:String},
          {refreshVersion:UInt64},parseDateTime64BestEffort({refreshedAt:String},6),
          arrayZip({eventTimes:Array(Float64)},{activityIds:Array(String)},{thresholds:Array(Nullable(Float64))},
            {intensities:Array(Nullable(Float64))},{stresses:Array(Nullable(Float64))},
            {evidenceIds:Array(String)},{evidenceTimes:Array(Float64)},{evidenceDurations:Array(Float64)},
            {evidencePowers:Array(Float64)})
        WHERE ${accountIsWritable}`,
      query_params: {
        userId: user.user_id,
        sourceVersion: user.source_refresh_version,
        asOfDay: params.asOfDay,
        modelVersion: policy.modelVersion,
        refreshVersion: publicationVersion,
        refreshedAt: asOf.toISOString(),
        eventTimes: history.map((point) => point.atSeconds),
        activityIds: history.map((point) => point.id ?? ""),
        thresholds: history.map((point) => point.thresholdWatts),
        intensities: history.map((point) => point.intensityFactor),
        stresses: history.map((point) => point.trainingStressScore),
        evidenceIds: history.map((point) => point.evidence?.id ?? ""),
        evidenceTimes: history.map((point) => point.evidence?.atSeconds ?? 0),
        evidenceDurations: history.map((point) => point.evidence?.effort.durationSeconds ?? 0),
        evidencePowers: history.map((point) => point.evidence?.effort.watts ?? 0),
      },
      clickhouse_settings: { log_queries: 0 },
    });
    publishedVersions.set(user.user_id, publicationVersion);
  }
  const publishedRows = await rows(
    client,
    z.object({ user_id: z.string().uuid(), refresh_version: z.string() }),
    `SELECT user_id,toString(refresh_version) AS refresh_version
     FROM analytics.cycling_power_history_rows FINAL WHERE user_id IN {userIds:Array(UUID)}`,
    { userIds: [...publishedVersions.keys()] },
  );
  const projectedUsers = publishedRows.filter(
    (row) => publishedVersions.get(row.user_id) === row.refresh_version,
  ).length;
  const pendingActivityRows = await rows(
    client,
    countSchema,
    `WITH ${sources} SELECT count() AS count FROM source_state WHERE dirty`,
    params,
  );
  const pendingUserRows = await rows(
    client,
    countSchema,
    `${userState} SELECT count() AS count FROM dirty_users`,
    params,
  );
  return {
    pendingActivities: pendingActivityRows[0]?.count ?? 0,
    pendingUsers: pendingUserRows[0]?.count ?? 0,
    projectedUsers,
  };
}
