import { pathToFileURL } from "node:url";
import {
  createClickHouseClientFromEnv,
  parsePostgresConnectionForClickHouse,
} from "../src/db/clickhouse.ts";
import { USER_ID } from "./seed/helpers.ts";

interface ReviewRawTableCopy {
  targetTable: string;
  sourceTable: string;
  columns: readonly string[];
  selectExpressions: readonly string[];
  whereClause?: string;
}

const peerDbMetadataColumns = [
  "_peerdb_synced_at",
  "_peerdb_is_deleted",
  "_peerdb_version",
] as const;
const peerDbMetadataExpressions = [
  "now64(9)",
  "0",
  "toInt64(toUnixTimestamp64Micro(now64(6)))",
] as const;

const seedProviderIds = ["whoop", "apple_health", "strava", "bodyspec", "manual_review"];
const seedProviderList = seedProviderIds.map(clickHouseStringLiteral).join(", ");
const reviewUserId = clickHouseStringLiteral(USER_ID);
const reviewBodyWeightPrefix = "review-seed-body-weight-";
const metricStreamTargetColumns = `(
  id,
  activity_id,
  user_id,
  recorded_at,
  channel,
  provider_id,
  external_id,
  device_id,
  source_type,
  scalar,
  vector,
  point,
  metadata,
  ingested_at,
  is_deleted,
  version,
  generation
)`;

const reviewRawTableCopies: readonly ReviewRawTableCopy[] = [
  {
    targetTable: "postgres_fitness.user_profile",
    sourceTable: "user_profile",
    columns: [
      "id",
      "name",
      "email",
      "birth_date",
      "max_hr",
      "resting_hr",
      "ftp",
      "is_admin",
      "created_at",
      "updated_at",
    ],
    selectExpressions: [
      "id",
      "name",
      "email",
      "birth_date",
      "max_hr",
      "resting_hr",
      "ftp",
      "is_admin",
      "created_at",
      "updated_at",
    ],
    whereClause: `id = ${clickHouseStringLiteral(USER_ID)}`,
  },
  {
    targetTable: "postgres_fitness.provider",
    sourceTable: "provider",
    columns: ["id", "name", "api_base_url", "user_id", "created_at"],
    selectExpressions: ["id", "name", "api_base_url", "user_id", "created_at"],
  },
  {
    targetTable: "postgres_fitness.provider_connection",
    sourceTable: "provider_connection",
    columns: ["user_id", "provider_id", "created_at", "updated_at"],
    selectExpressions: ["user_id", "provider_id", "created_at", "updated_at"],
    whereClause: `user_id = ${clickHouseStringLiteral(USER_ID)}`,
  },
  {
    targetTable: "postgres_fitness.provider_priority",
    sourceTable: "provider_priority",
    columns: [
      "provider_id",
      "priority",
      "sleep_priority",
      "body_priority",
      "recovery_priority",
      "daily_activity_priority",
    ],
    selectExpressions: [
      "provider_id",
      "priority",
      "sleep_priority",
      "body_priority",
      "recovery_priority",
      "daily_activity_priority",
    ],
    whereClause: `provider_id IN (${seedProviderList})`,
  },
  {
    targetTable: "postgres_fitness.device_priority",
    sourceTable: "device_priority",
    columns: [
      "provider_id",
      "source_name_pattern",
      "priority",
      "sleep_priority",
      "body_priority",
      "recovery_priority",
      "daily_activity_priority",
    ],
    selectExpressions: [
      "provider_id",
      "source_name_pattern",
      "priority",
      "sleep_priority",
      "body_priority",
      "recovery_priority",
      "daily_activity_priority",
    ],
    whereClause: `provider_id IN (${seedProviderList})`,
  },
  {
    targetTable: "postgres_fitness.sensor_provider_priority",
    sourceTable: "sensor_provider_priority",
    columns: ["provider_id", "channel", "priority"],
    selectExpressions: ["provider_id", "channel", "priority"],
    whereClause: `provider_id IN (${seedProviderList})`,
  },
  {
    targetTable: "postgres_fitness.sensor_device_priority",
    sourceTable: "sensor_device_priority",
    columns: ["provider_id", "source_name_pattern", "channel", "priority"],
    selectExpressions: ["provider_id", "source_name_pattern", "channel", "priority"],
    whereClause: `provider_id IN (${seedProviderList})`,
  },
  {
    targetTable: "postgres_fitness.activity",
    sourceTable: "activity",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "activity_type",
      "started_at",
      "ended_at",
      "name",
      "notes",
      "perceived_exertion",
      "source_name",
      "timezone",
      "strava_id",
      "raw",
      "created_at",
    ],
    selectExpressions: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "activity_type",
      "started_at",
      "ended_at",
      "name",
      "notes",
      "perceived_exertion",
      "source_name",
      "timezone",
      "strava_id",
      "toString(raw)",
      "created_at",
    ],
    whereClause: `user_id = ${clickHouseStringLiteral(USER_ID)}`,
  },
];

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function buildReviewPostgresTableFunction(
  postgresConnectionString: string,
  tableName: string,
): string {
  const postgres = parsePostgresConnectionForClickHouse(postgresConnectionString);
  return `postgresql(${[
    postgres.hostAndPort,
    postgres.database,
    tableName,
    postgres.user,
    postgres.password,
    "fitness",
  ]
    .map(clickHouseStringLiteral)
    .join(", ")})`;
}

function buildCopyStatement(
  postgresConnectionString: string,
  tableCopy: ReviewRawTableCopy,
): string {
  const source = buildReviewPostgresTableFunction(postgresConnectionString, tableCopy.sourceTable);
  const allColumns = [...tableCopy.columns, ...peerDbMetadataColumns];
  const allExpressions = [...tableCopy.selectExpressions, ...peerDbMetadataExpressions];
  const whereClause = tableCopy.whereClause ? `\nWHERE ${tableCopy.whereClause}` : "";

  return `INSERT INTO ${tableCopy.targetTable} (${allColumns.join(", ")})
SELECT
  ${allExpressions.join(",\n  ")}
FROM ${source}${whereClause}`;
}

export function buildReviewClickHouseCopyStatements(postgresConnectionString: string): string[] {
  return [
    ...reviewRawTableCopies.map((tableCopy) => `TRUNCATE TABLE IF EXISTS ${tableCopy.targetTable}`),
    ...reviewRawTableCopies.map((tableCopy) =>
      buildCopyStatement(postgresConnectionString, tableCopy),
    ),
    buildReviewBodyWeightTombstoneStatement(),
    buildReviewBodyWeightInsertStatement(),
  ];
}

function buildReviewBodyWeightTombstoneStatement(): string {
  return `INSERT INTO ingest.metric_stream ${metricStreamTargetColumns}
SELECT
  id,
  activity_id,
  user_id,
  recorded_at,
  channel,
  provider_id,
  external_id,
  device_id,
  source_type,
  scalar,
  vector,
  point,
  metadata,
  now64(9),
  1,
  toInt64(toUnixTimestamp64Nano(now64(9))),
  generation
FROM ingest.metric_stream FINAL
WHERE user_id = toUUID(${reviewUserId})
  AND provider_id = 'manual_review'
  AND channel = 'body_weight'
  AND startsWith(ifNull(external_id, ''), '${reviewBodyWeightPrefix}')
  AND is_deleted = 0`;
}

function buildReviewBodyWeightInsertStatement(): string {
  return `INSERT INTO ingest.metric_stream ${metricStreamTargetColumns}
SELECT
  reinterpretAsUUID(
    MD5(concat('${reviewBodyWeightPrefix}', toString(today() - toIntervalDay(number))))
  ),
  NULL,
  toUUID(${reviewUserId}),
  toDateTime64(today() - toIntervalDay(number), 6, 'UTC') + toIntervalHour(8),
  'body_weight',
  'manual_review',
  concat('${reviewBodyWeightPrefix}', toString(today() - toIntervalDay(number))),
  'Review scale',
  'review_seed',
  toFloat32(78 + number * 0.012),
  [],
  '',
  '{"fixture":"review"}',
  now64(9),
  0,
  toInt64(toUnixTimestamp64Nano(now64(9))),
  0
FROM numbers(90)`;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const clickHouseClient = createClickHouseClientFromEnv();
  try {
    for (const statement of buildReviewClickHouseCopyStatements(databaseUrl)) {
      await clickHouseClient.command({ query: statement });
    }
  } finally {
    await clickHouseClient.close?.();
  }

  console.log("Seeded ClickHouse raw tables for review activity data");
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
