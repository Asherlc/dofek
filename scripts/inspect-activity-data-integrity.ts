import { parseArgs } from "node:util";
import * as Sentry from "@sentry/node";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "../src/db/typed-sql.ts";
import { captureException } from "../src/lib/error-reporting.ts";

const activityRowSchema = z.object({
  requested_activity_id: z.string(),
  activity_id: z.string(),
  provider_id: z.string(),
  canonical_type: z.string(),
  provider_type: z.string(),
  member_activity_ids: z.array(z.string()),
});

const activityMemberSchema = z.object({
  activity_id: z.string(),
  provider_id: z.string(),
  canonical_type: z.string(),
  provider_type: z.string(),
  external_id: z.string(),
  name: z.string().nullable(),
  name_utf8_hex: z.string().nullable(),
  set_count: z.coerce.number().int().nonnegative(),
  set_activity_ids: z.array(z.string()),
});

const sensorSummarySchema = z.object({
  activity_id: z.string(),
  avg_speed: z.coerce.number().nullable(),
  max_hr: z.coerce.number().int().nullable(),
});

const sourceHeartRateSampleSchema = z.object({
  activity_id: z.string(),
  summary_max_hr: z.coerce.number().int(),
  recorded_at: z.string(),
  scalar: z.coerce.number(),
  source_metric_stream_id: z.string(),
  source_provider_id: z.string(),
  source_external_id: z.string().nullable(),
  source_device_id: z.string().nullable(),
  source_type: z.string().nullable(),
  source_metadata: z.string(),
});

const userIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "--user-id must be a UUID",
  );
const activityIdPrefixSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{1,8}|[0-9a-f]{8}(?:-[0-9a-f]{1,4}(?:-[0-9a-f]{1,4}(?:-[0-9a-f]{1,4}(?:-[0-9a-f]{1,12})?)?)?)?)$/i,
    "--activity-id must be a hexadecimal UUID prefix",
  );
const inspectionInputSchema = z.object({
  userId: userIdSchema,
  activityIds: z
    .array(activityIdPrefixSchema)
    .min(1, "At least one non-empty --activity-id is required"),
});

export interface ActivityIntegrityInspectionDatabase {
  postgres: SchemaExecutionDatabase;
  clickHouse: Pick<ClickHouseClient, "query">;
}

export interface ActivityIntegrityInspectionInput {
  userId: string;
  activityIds: string[];
}

function textArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function assertInspectionInput(input: ActivityIntegrityInspectionInput): void {
  inspectionInputSchema.parse(input);
}

/**
 * Reads only the supplied user's selected activity groups and their raw source
 * records. Activity IDs may be unique UUID prefixes so operators can use the
 * short IDs in the incident record.
 */
export async function inspectActivityDataIntegrity(
  db: ActivityIntegrityInspectionDatabase,
  input: ActivityIntegrityInspectionInput,
) {
  assertInspectionInput(input);

  const activityRows = await executeWithSchema(
    db.postgres,
    activityRowSchema,
    sql`WITH requested AS (
          SELECT requested_activity_id
          FROM unnest(${textArray(input.activityIds)}) AS requested_activity_id
        )
        SELECT
          requested.requested_activity_id,
          activity.id::text AS activity_id,
          activity.provider_id,
          activity.canonical_type,
          activity.provider_type,
          activity.member_activity_ids::text[] AS member_activity_ids
        FROM requested
        INNER JOIN fitness.v_activity AS activity
          ON EXISTS (
            SELECT 1
            FROM unnest(activity.member_activity_ids) AS member_activity_id
            WHERE member_activity_id::text LIKE requested.requested_activity_id || '%'
          )
        WHERE activity.user_id = ${input.userId}::uuid
        ORDER BY array_position(${textArray(input.activityIds)}, requested.requested_activity_id)`,
  );

  const inspectedMemberIds = [
    ...new Set([...input.activityIds, ...activityRows.flatMap((row) => row.member_activity_ids)]),
  ];
  const activityMembers = await executeWithSchema(
    db.postgres,
    activityMemberSchema,
    sql`WITH requested AS (
          SELECT requested_activity_id
          FROM unnest(${textArray(inspectedMemberIds)}) AS requested_activity_id
        )
        SELECT
          activity.id::text AS activity_id,
          activity.provider_id,
          activity.canonical_type,
          activity.provider_type,
          activity.external_id,
          activity.name,
          encode(convert_to(activity.name, 'UTF8'), 'hex') AS name_utf8_hex,
          count(strength_set.id)::integer AS set_count,
          COALESCE(
            array_agg(DISTINCT strength_set.activity_id::text)
              FILTER (WHERE strength_set.activity_id IS NOT NULL),
            ARRAY[]::text[]
          ) AS set_activity_ids
        FROM fitness.activity AS activity
        INNER JOIN requested
          ON activity.id::text LIKE requested.requested_activity_id || '%'
        LEFT JOIN fitness.strength_set AS strength_set
          ON strength_set.activity_id = activity.id
        WHERE activity.user_id = ${input.userId}::uuid
        GROUP BY activity.id
        ORDER BY activity.id`,
  );

  const fullMemberIds = activityMembers.map((member) => member.activity_id);
  const summaryResult = await db.clickHouse.query<z.infer<typeof sensorSummarySchema>>({
    query: `SELECT
      activity_id,
      avg_speed,
      max_hr
    FROM analytics.activity_sensor_summary_rows FINAL
    WHERE user_id = {userId:UUID}
      AND activity_id IN {activityIds:Array(UUID)}
      AND is_deleted = 0`,
    query_params: { userId: input.userId, activityIds: fullMemberIds },
    format: "JSONEachRow",
  });
  const summaries = z.array(sensorSummarySchema).parse(await summaryResult.json());

  const heartRateResult = await db.clickHouse.query<z.infer<typeof sourceHeartRateSampleSchema>>({
    query: `SELECT
      sample.activity_id AS activity_id,
      summary.max_hr AS summary_max_hr,
      toString(sample.recorded_at) AS recorded_at,
      sample.scalar AS scalar,
      toString(sensor.source_metric_stream_id) AS source_metric_stream_id,
      source.provider_id AS source_provider_id,
      source.external_id AS source_external_id,
      source.device_id AS source_device_id,
      source.source_type AS source_type,
      source.metadata AS source_metadata
    FROM analytics.activity_sensor_sample AS sample FINAL
    INNER JOIN analytics.activity_sensor_summary_rows AS summary FINAL
      ON summary.user_id = sample.user_id
      AND summary.activity_id = sample.activity_id
      AND summary.is_deleted = 0
    INNER JOIN analytics.deduped_sensor AS sensor FINAL
      ON sensor.user_id = sample.user_id
      AND sensor.recorded_at = sample.recorded_at
      AND sensor.channel = sample.channel
      AND sensor.is_deleted = 0
    INNER JOIN ingest.metric_stream AS source FINAL
      ON source.id = sensor.source_metric_stream_id
      AND source.is_deleted = 0
    WHERE sample.user_id = {userId:UUID}
      AND sample.activity_id IN {activityIds:Array(UUID)}
      AND sample.channel = 'heart_rate'
      AND sample.is_deleted = 0
      AND sample.scalar = summary.max_hr`,
    query_params: { userId: input.userId, activityIds: fullMemberIds },
    format: "JSONEachRow",
  });
  const sourceHeartRateSamples = z
    .array(sourceHeartRateSampleSchema)
    .parse(await heartRateResult.json())
    .map((sample) => ({
      activityId: sample.activity_id,
      summaryMaxHr: sample.summary_max_hr,
      recordedAt: sample.recorded_at,
      scalar: sample.scalar,
      sourceMetricStreamId: sample.source_metric_stream_id,
      sourceProviderId: sample.source_provider_id,
      sourceExternalId: sample.source_external_id,
      sourceDeviceId: sample.source_device_id,
      sourceType: sample.source_type,
      sourceMetadata: sample.source_metadata,
    }));

  const memberById = new Map(activityMembers.map((member) => [member.activity_id, member]));
  const summaryByActivityId = new Map(summaries.map((summary) => [summary.activity_id, summary]));

  return {
    activities: activityRows.map((activity) => {
      const selectedSummaryActivityId = [
        activity.activity_id,
        ...activity.member_activity_ids,
      ].find((activityId) => summaryByActivityId.has(activityId));
      const selectedSummary = selectedSummaryActivityId
        ? summaryByActivityId.get(selectedSummaryActivityId)
        : undefined;
      const selectedSummaryMember = selectedSummaryActivityId
        ? memberById.get(selectedSummaryActivityId)
        : undefined;

      return {
        requestedActivityId: activity.requested_activity_id,
        activityId: activity.activity_id,
        providerId: activity.provider_id,
        canonicalType: activity.canonical_type,
        providerType: activity.provider_type,
        memberActivityIds: activity.member_activity_ids,
        selectedSummaryActivityId: selectedSummaryActivityId ?? null,
        selectedSummaryMember: selectedSummaryMember
          ? {
              providerId: selectedSummaryMember.provider_id,
              canonicalType: selectedSummaryMember.canonical_type,
              providerType: selectedSummaryMember.provider_type,
            }
          : null,
        selectedSummary: selectedSummary
          ? {
              avgSpeed: selectedSummary.avg_speed,
              maxHr: selectedSummary.max_hr,
            }
          : null,
      };
    }),
    strongSessions: activityMembers
      .filter((activity) => activity.provider_id === "strong-csv")
      .map((activity) => ({
        activityId: activity.activity_id,
        externalId: activity.external_id,
        providerId: activity.provider_id,
        canonicalType: activity.canonical_type,
        providerType: activity.provider_type,
        name: activity.name,
        nameUtf8Hex: activity.name_utf8_hex,
        setCount: activity.set_count,
        setActivityIds: activity.set_activity_ids,
      })),
    sourceHeartRateSamples,
  };
}

export function parseInspectionArgs(args: readonly string[]): ActivityIntegrityInspectionInput {
  const { values } = parseArgs({
    args,
    options: {
      "user-id": { type: "string" },
      "activity-id": { type: "string", multiple: true },
    },
    strict: true,
  });
  return inspectionInputSchema.parse({
    userId: values["user-id"],
    activityIds: values["activity-id"],
  });
}

function initializeSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  initializeSentry();
  const input = parseInspectionArgs(args);
  const postgres = createDatabaseFromEnv();
  let clickHouse: ReturnType<typeof createClickHouseClientFromEnv> | undefined;

  try {
    clickHouse = createClickHouseClientFromEnv();
    const result = await inspectActivityDataIntegrity({ postgres, clickHouse }, input);
    console.log(JSON.stringify(result, null, 2));
  } catch (error: unknown) {
    captureException(error);
    throw error;
  } finally {
    await postgres.$client.end();
    await clickHouse?.close?.();
    await Sentry.close(2_000);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[inspect-activity-data-integrity] ${error}`);
    process.exit(1);
  });
}
