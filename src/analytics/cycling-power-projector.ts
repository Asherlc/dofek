import { normalizedPower, type PowerCoveragePolicy } from "@dofek/cycling-power/power";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { ACCOUNT_ERASURE_FENCE_TABLE } from "../metric-stream/clickhouse-table.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";

const NP_ALGORITHM_VERSION = "elapsed-power-full-30s-v1";
const ACTIVITY_BATCH_SIZE = 100;

export interface CyclingPowerPolicy {
  coveragePolicy: PowerCoveragePolicy;
}

export interface CyclingPowerProjectionResult {
  pendingActivities: number;
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
const countSchema = z.object({ count: z.coerce.number() });

// Include tombstones in each watermark so removed and corrected sources dirty NP.

const sources = `
  sample_versions AS (
    SELECT user_id, activity_id, max(refresh_version) AS version
    FROM analytics.activity_sensor_sample
    GROUP BY user_id, activity_id
  ),
  effort_versions AS (
    SELECT user_id, activity_id, max(refresh_version) AS version
    FROM analytics.activity_power_curve
    GROUP BY user_id, activity_id
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
  client: Pick<ClickHouseClient, "query">,
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

/** Incrementally compute normalized power for bounded batches of changed activities. */
export async function projectCyclingPower(
  owner: Pick<AnalyticsQueryOwner, "client" | "assertActive">,
  policy: CyclingPowerPolicy,
  asOf: Date = new Date(),
): Promise<CyclingPowerProjectionResult> {
  await owner.assertActive();
  const client = owner.client;
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
  const computedObservations: Array<{
    activity: z.infer<typeof sourceSchema>;
    np: number | null;
    version: string;
  }> = [];
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
    computedObservations.push({ activity, np, version: refreshVersion() });
  }
  if (computedObservations.length > 0) {
    // Keep raw sample reads sequential: the retained batch contains only compact
    // observations, so one write does not multiply native-sample peak memory.
    await client.command({
      query: `INSERT INTO analytics.cycling_power_observation_rows
        (user_id,activity_id,normalized_power,source_refresh_version,is_deleted,model_version,refresh_version,refreshed_at)
        SELECT observation.1,observation.2,observation.3,toUInt64(observation.4),observation.5,
          {modelVersion:String},toUInt64(observation.6),parseDateTime64BestEffort({refreshedAt:String},6)
        FROM (SELECT arrayJoin(arrayZip({userIds:Array(UUID)},{activityIds:Array(UUID)},
          {normalizedPowers:Array(Nullable(Float64))},{sourceVersions:Array(String)},
          {deletedFlags:Array(UInt8)},{refreshVersions:Array(String)})) AS observation)
        WHERE lower(hex(SHA256(toString(observation.1)))) NOT IN
          (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL)`,
      query_params: {
        userIds: computedObservations.map(({ activity }) => activity.user_id),
        activityIds: computedObservations.map(({ activity }) => activity.activity_id),
        normalizedPowers: computedObservations.map(({ np }) => np),
        sourceVersions: computedObservations.map(({ activity }) => activity.source_refresh_version),
        deletedFlags: computedObservations.map(({ activity }) => activity.is_deleted),
        refreshVersions: computedObservations.map(({ version }) => version),
        modelVersion: npVersion,
        refreshedAt: asOf.toISOString(),
      },
      clickhouse_settings: { log_queries: 0 },
    });
  }

  const pendingActivityRows = await rows(
    client,
    countSchema,
    `WITH ${sources} SELECT count() AS count FROM source_state WHERE dirty`,
    params,
  );
  return {
    pendingActivities: pendingActivityRows[0]?.count ?? 0,
  };
}
