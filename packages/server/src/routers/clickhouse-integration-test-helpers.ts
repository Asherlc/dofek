import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildClickHouseBootstrapStatements,
  type ClickHouseClient,
  createClickHouseClientFromEnv,
  parsePostgresConnectionForClickHouse,
} from "../../../../src/db/clickhouse.ts";
import { buildActivityVo2MaxEstimateTableSql } from "../../../../src/db/clickhouse-activity-vo2max-estimate.ts";
import {
  buildDedupedSensorBackfillSql,
  buildSensorScalarSampleBackfillSql,
} from "../../../../src/db/clickhouse-deduped-sensor.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { ClickHouseActivitySensorStore } from "../repositories/clickhouse-activity-sensor-store.ts";
import {
  analyticsBuildOrder,
  buildTestAnalyticsTableStatement,
  CLICKHOUSE_TEST_VIEW_REGEX,
  type IsolatedClickHouseDatabases,
  rewriteClickHouseDatabaseNames,
} from "./clickhouse-integration-test-models.ts";
import {
  buildTestActivityHeartRateZonesSelectSql,
  buildTestActivityLocationSampleSelectSql,
  buildTestActivityLocationSummarySelectSql,
  buildTestActivitySensorSampleSelectSql,
  buildTestActivitySensorSummarySelectSql,
  buildTestActivityStreamPointsSelectSql,
  buildTestActivitySummarySelectSql,
  buildTestDailyRecoveryInputsSelectSql,
  buildTestDedupedActivitiesSelectSql,
  buildTestHikingActivitySelectSql,
  buildTestProviderStatsSelectSql,
  buildTestRestingHeartRateSelectSql,
} from "./clickhouse-integration-test-read-models-a.ts";
import {
  buildTestBodyMeasurementSelectSql,
  buildTestDailyActivityLoadSelectSql,
  buildTestDailyBodyMeasurementSelectSql,
  buildTestDailyEnduranceLoadSelectSql,
  buildTestDailySleepSelectSql,
  buildTestHealthspanActivityZoneMinutesSelectSql,
  buildTestHealthspanReadModelSelectSql,
  buildTestRecoveryReadModelSelectSql,
  buildTestStrainReadModelSelectSql,
  buildTestWeeklyEnduranceRampRateSelectSql,
  buildTestWeeklyTrainingMonotonySelectSql,
} from "./clickhouse-integration-test-read-models-b.ts";

interface ClickHouseSyncTestContext {
  addCleanup(cleanup: () => Promise<void>): void;
  connectionString: string;
}

export interface ClickHouseMetricStreamSeedRow {
  id?: string;
  activityId?: string | null;
  userId: string;
  recordedAt: string;
  channel: string;
  providerId: string;
  externalId?: string | null;
  deviceId?: string | null;
  sourceType?: string | null;
  scalar?: number | null;
  vector?: readonly number[] | null;
  point?: string;
  metadata?: string;
  generation?: number;
}

export interface ClickHouseActivityPolarizationZoneSeedRow {
  activityId: string;
  userId: string;
  startedAt: string;
  maxHr: number;
  z1Seconds: number;
  z2Seconds: number;
  z3Seconds: number;
}

interface ClickHouseTestHandle {
  client: ClickHouseClient;
  setupClient: ClickHouseClient;
}

interface RawTableSync {
  columns: string[];
  tableName: string;
}

const handlesByContext = new WeakMap<ClickHouseSyncTestContext, ClickHouseTestHandle>();
const clickHouseTestSetupSemaphoreDirectory = join(
  tmpdir(),
  "dofek-clickhouse-integration-test-slots",
);
const clickHouseTestSetupSlotCount = 2;
const clickHouseTestSetupSlotTimeoutMilliseconds = 55_000;
const clickHouseTestSetupStaleSlotMilliseconds = 300_000;
const rawTableSyncs: RawTableSync[] = [
  {
    tableName: "activity",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "canonical_type",
      "provider_type",
      "modality",
      "started_at",
      "ended_at",
      "name",
      "notes",
      "perceived_exertion",
      "source_name",
      "timezone",
      "start_utc_offset_minutes",
      "end_utc_offset_minutes",
      "local_time_source",
      "strava_id",
      "raw",
      "created_at",
    ],
  },
  {
    tableName: "sleep_session",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "started_at",
      "ended_at",
      "duration_minutes",
      "deep_minutes",
      "rem_minutes",
      "light_minutes",
      "awake_minutes",
      "efficiency_pct",
      "staging_available",
      "sleep_type",
      "sleep_need_baseline_minutes",
      "sleep_need_from_debt_minutes",
      "sleep_need_from_strain_minutes",
      "sleep_need_from_nap_minutes",
      "source_name",
      "timezone",
      "start_utc_offset_minutes",
      "end_utc_offset_minutes",
      "local_time_source",
      "created_at",
    ],
  },
  {
    tableName: "sleep_stage",
    columns: ["id", "session_id", "stage", "started_at", "ended_at", "source_name", "created_at"],
  },
  {
    tableName: "daily_metrics",
    columns: [
      "id",
      "date",
      "provider_id",
      "user_id",
      "hrv",
      "spo2_avg",
      "respiratory_rate_avg",
      "steps",
      "distance_km",
      "flights_climbed",
      "exercise_minutes",
      "walking_speed",
      "walking_step_length",
      "walking_double_support_pct",
      "walking_asymmetry_pct",
      "walking_steadiness",
      "stand_hours",
      "skin_temp_c",
      "stress_high_minutes",
      "recovery_high_minutes",
      "resilience_level",
      "push_count",
      "wheelchair_distance_km",
      "uv_exposure",
      "source_name",
      "created_at",
    ],
  },
  {
    tableName: "food_entry",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "date",
      "meal",
      "food_name",
      "food_description",
      "category",
      "provider_food_id",
      "provider_serving_id",
      "number_of_units",
      "logged_at",
      "source_name",
      "started_at",
      "ended_at",
      "barcode",
      "serving_unit",
      "serving_weight_grams",
      "raw",
      "confirmed",
      "created_at",
    ],
  },
  {
    tableName: "health_event",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "type",
      "value",
      "value_text",
      "unit",
      "source_name",
      "start_date",
      "end_date",
      "created_at",
    ],
  },
  {
    tableName: "lab_panel",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "external_id",
      "name",
      "loinc_code",
      "status",
      "source_name",
      "recorded_at",
      "issued_at",
      "raw",
      "created_at",
    ],
  },
  {
    tableName: "lab_result",
    columns: [
      "id",
      "provider_id",
      "user_id",
      "panel_id",
      "external_id",
      "test_name",
      "loinc_code",
      "value",
      "value_text",
      "unit",
      "reference_range_low",
      "reference_range_high",
      "reference_range_text",
      "status",
      "source_name",
      "recorded_at",
      "issued_at",
      "raw",
      "created_at",
    ],
  },
  {
    tableName: "journal_entry",
    columns: [
      "id",
      "date",
      "provider_id",
      "user_id",
      "question_slug",
      "answer_text",
      "answer_numeric",
      "impact_score",
      "created_at",
    ],
  },
  {
    tableName: "provider",
    columns: ["id", "name", "api_base_url", "user_id", "created_at"],
  },
  {
    tableName: "provider_priority",
    columns: [
      "provider_id",
      "priority",
      "sleep_priority",
      "body_priority",
      "recovery_priority",
      "daily_activity_priority",
    ],
  },
  {
    tableName: "device_priority",
    columns: [
      "provider_id",
      "source_name_pattern",
      "priority",
      "sleep_priority",
      "body_priority",
      "recovery_priority",
      "daily_activity_priority",
    ],
  },
  {
    tableName: "user_profile",
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
  },
];

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function buildPostgresTableFunction(connectionString: string, tableName: string): string {
  const postgres = parsePostgresConnectionForClickHouse(connectionString);
  return `postgresql(${clickHouseStringLiteral(postgres.hostAndPort)}, ${clickHouseStringLiteral(
    postgres.database,
  )}, ${clickHouseStringLiteral(tableName)}, ${clickHouseStringLiteral(
    postgres.user,
  )}, ${clickHouseStringLiteral(postgres.password)}, 'fitness')`;
}

function buildRawTableInsertStatement(connectionString: string, sync: RawTableSync): string {
  const columnList = sync.columns.join(",\n  ");
  return `INSERT INTO postgres_fitness.${sync.tableName} (
  ${columnList}
)
SELECT
  ${columnList}
FROM ${buildPostgresTableFunction(connectionString, sync.tableName)}`;
}

function rewriteClickHouseTestCommand(
  query: string,
  databases: IsolatedClickHouseDatabases,
  precomputedAnalyticsSelectByName: Map<string, string>,
): string[] {
  const rewrittenQuery = rewriteClickHouseDatabaseNames(query, databases).trim();
  const viewMatch = rewrittenQuery.match(CLICKHOUSE_TEST_VIEW_REGEX);

  if (viewMatch) {
    const viewName = viewMatch[1];
    const selectSql = viewMatch[2];
    if (!viewName || !selectSql) {
      throw new Error("Could not parse ClickHouse test view statement");
    }
    const trimmedSelectSql = selectSql.trim();
    precomputedAnalyticsSelectByName.set(
      viewName,
      buildTestAnalyticsSelectSql(viewName, trimmedSelectSql, databases),
    );
    return [buildTestAnalyticsTableStatement(viewName)];
  }

  if (
    rewrittenQuery.startsWith(
      `CREATE TABLE IF NOT EXISTS ${databases.analytics}.resting_heart_rate_sleep_window`,
    )
  ) {
    precomputedAnalyticsSelectByName.set(
      `${databases.analytics}.resting_heart_rate_sleep_window`,
      buildTestRestingHeartRateSelectSql(databases),
    );
  }

  if (rewrittenQuery.startsWith(`DROP VIEW IF EXISTS ${databases.analytics}.`)) {
    return [rewrittenQuery.replace("DROP VIEW IF EXISTS", "DROP TABLE IF EXISTS")];
  }

  const rebuildAnalyticsPrefix = `REBUILD TEST ANALYTICS TABLE ${databases.analytics}.`;
  if (rewrittenQuery.startsWith(rebuildAnalyticsPrefix)) {
    const viewName = rewrittenQuery.slice("REBUILD TEST ANALYTICS TABLE ".length);
    const selectSql = precomputedAnalyticsSelectByName.get(viewName);
    if (!selectSql) {
      throw new Error(`Missing ClickHouse test analytics SELECT for ${viewName}`);
    }
    return [`TRUNCATE TABLE ${viewName}`, `INSERT INTO ${viewName}\n${selectSql}`];
  }

  return [rewrittenQuery];
}

function buildTestAnalyticsSelectSql(
  viewName: string,
  selectSql: string,
  databases: IsolatedClickHouseDatabases,
): string {
  if (
    viewName.endsWith(".activity_summary") &&
    selectSql.includes(".activity_summary_rows FINAL")
  ) {
    return buildTestActivitySummarySelectSql(databases);
  }
  if (viewName.endsWith(".provider_stats")) {
    return buildTestProviderStatsSelectSql(selectSql);
  }
  return selectSql;
}

function createIsolatedClickHouseClient(
  client: ClickHouseClient,
  databases: IsolatedClickHouseDatabases,
): ClickHouseClient {
  const precomputedAnalyticsSelectByName = new Map<string, string>();
  return {
    command: async (options) => {
      const queries = rewriteClickHouseTestCommand(
        options.query,
        databases,
        precomputedAnalyticsSelectByName,
      );
      let result: unknown;
      for (const query of queries) {
        try {
          result = await client.command({
            ...options,
            query,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`ClickHouse test command failed: ${query}\n${message}`);
        }
      }
      return result;
    },
    query: <TRow extends object>(options: {
      query: string;
      format: "JSONEachRow";
      query_params?: Record<string, unknown>;
    }) => {
      const queryParams = options.query_params ? { ...options.query_params } : undefined;
      if (queryParams?.database_name === "ingest") {
        queryParams.database_name = databases.ingest;
      }
      if (queryParams?.database_name === "analytics") {
        queryParams.database_name = databases.analytics;
      }
      if (queryParams?.database_name === "postgres_fitness") {
        queryParams.database_name = databases.postgresFitness;
      }
      return client.query<TRow>({
        ...options,
        query: rewriteClickHouseDatabaseNames(options.query, databases),
        query_params: queryParams,
      });
    },
    insert: async (options) => {
      if (!client.insert) {
        throw new Error("ClickHouse integration test client does not support inserts");
      }
      return client.insert({
        ...options,
        table: rewriteClickHouseDatabaseNames(options.table, databases),
      });
    },
    close: () => client.close?.() ?? Promise.resolve(),
  };
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function removeStaleClickHouseTestSetupSlot(slotPath: string): Promise<void> {
  try {
    const lockStats = await stat(slotPath);
    if (Date.now() - lockStats.mtimeMs > clickHouseTestSetupStaleSlotMilliseconds) {
      await rm(slotPath, { force: true, recursive: true });
    }
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

async function acquireClickHouseTestSetupSlot(): Promise<() => Promise<void>> {
  await mkdir(clickHouseTestSetupSemaphoreDirectory, { recursive: true });
  const startedAt = Date.now();

  while (true) {
    for (let slotIndex = 0; slotIndex < clickHouseTestSetupSlotCount; slotIndex += 1) {
      const slotPath = join(clickHouseTestSetupSemaphoreDirectory, `slot-${slotIndex}`);
      await removeStaleClickHouseTestSetupSlot(slotPath);
      try {
        await mkdir(slotPath);
        return async () => {
          await rm(slotPath, { force: true, recursive: true });
        };
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) {
          throw error;
        }
      }
    }

    if (Date.now() - startedAt > clickHouseTestSetupSlotTimeoutMilliseconds) {
      throw new Error("Timed out waiting for ClickHouse integration test setup slot");
    }
    await sleep(250);
  }
}

export async function createClickHouseTestActivitySensorStore(
  testContext: ClickHouseSyncTestContext,
): Promise<ActivitySensorStore> {
  const suffix = randomBytes(6).toString("hex");
  const databases = {
    analytics: `analytics_test_${suffix}`,
    ingest: `ingest_test_${suffix}`,
    postgresFitness: `postgres_fitness_test_${suffix}`,
  };
  const rawClient = createClickHouseClientFromEnv();
  const setupClient = createIsolatedClickHouseClient(rawClient, databases);
  const client = setupClient;
  handlesByContext.set(testContext, { client, setupClient });

  testContext.addCleanup(async () => {
    handlesByContext.delete(testContext);
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.analytics} SYNC` });
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.ingest} SYNC` });
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.postgresFitness} SYNC` });
    await rawClient.close?.();
  });

  const releaseSlot = await acquireClickHouseTestSetupSlot();
  try {
    await bootstrapClickHouseTestSchema(setupClient, testContext.connectionString);
    await syncClickHouseTestActivitySensorStoreWithClient(
      setupClient,
      testContext.connectionString,
    );
  } finally {
    await releaseSlot();
  }

  return new ClickHouseActivitySensorStore(client);
}

export function getClickHouseTestClient(testContext: ClickHouseSyncTestContext): ClickHouseClient {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }
  return handle.client;
}

export async function seedClickHouseActivityPolarizationZone(
  testContext: ClickHouseSyncTestContext,
  row: ClickHouseActivityPolarizationZoneSeedRow,
): Promise<void> {
  await getClickHouseTestClient(testContext).command({
    query: `INSERT INTO analytics.activity_polarization_zones (
        activity_id,
        user_id,
        canonical_type,
        started_at,
        max_hr,
        z1_seconds,
        z2_seconds,
        z3_seconds,
        is_deleted,
        refresh_version,
        refreshed_at
      )
      SELECT
        {activityId:UUID},
        {userId:UUID},
        'cycling',
        parseDateTime64BestEffort({startedAt:String}, 6),
        toNullable(toInt16({maxHr:Int16})),
        toInt32({z1Seconds:Int32}),
        toInt32({z2Seconds:Int32}),
        toInt32({z3Seconds:Int32}),
        toUInt8(0),
        toUInt64(1),
        now64(9)`,
    query_params: {
      activityId: row.activityId,
      userId: row.userId,
      startedAt: row.startedAt,
      maxHr: row.maxHr,
      z1Seconds: row.z1Seconds,
      z2Seconds: row.z2Seconds,
      z3Seconds: row.z3Seconds,
    },
  });
}

async function bootstrapClickHouseTestSchema(
  client: ClickHouseClient,
  connectionString: string,
): Promise<void> {
  const defaultTestDatabases: IsolatedClickHouseDatabases = {
    analytics: "analytics",
    ingest: "ingest",
    postgresFitness: "postgres_fitness",
  };

  for (const statement of buildClickHouseBootstrapStatements(connectionString)) {
    await client.command({ query: statement });
  }
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.deduped_activities
AS
${buildTestDedupedActivitiesSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_sensor_sample
AS
${buildTestActivitySensorSampleSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_location_sample
AS
${buildTestActivityLocationSampleSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_location_summary_rows
AS
${buildTestActivityLocationSummarySelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_sensor_summary_rows
AS
${buildTestActivitySensorSummarySelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_stream_points
AS
${buildTestActivityStreamPointsSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.activity_heart_rate_zones
AS
${buildTestActivityHeartRateZonesSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.hiking_activity
AS
${buildTestHikingActivitySelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_recovery_inputs
AS
${buildTestDailyRecoveryInputsSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_sleep
AS
${buildTestDailySleepSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_recovery
AS
${buildTestRecoveryReadModelSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_endurance_load
AS
${buildTestDailyEnduranceLoadSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.weekly_endurance_ramp_rate
AS
${buildTestWeeklyEnduranceRampRateSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.weekly_training_monotony
AS
${buildTestWeeklyTrainingMonotonySelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_activity_load
AS
${buildTestDailyActivityLoadSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_strain
AS
${buildTestStrainReadModelSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.v_body_measurement
AS
${buildTestBodyMeasurementSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.daily_body_measurement
AS
${buildTestDailyBodyMeasurementSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.healthspan_activity_zone_minutes
AS
${buildTestHealthspanActivityZoneMinutesSelectSql(defaultTestDatabases)}`,
  });
  await client.command({
    query: `CREATE VIEW IF NOT EXISTS analytics.weekly_healthspan
AS
${buildTestHealthspanReadModelSelectSql(defaultTestDatabases)}`,
  });
  await client.command({ query: buildActivityVo2MaxEstimateTableSql() });

  // Dbt read model tables — created here as empty ReplacingMergeTree tables so
  // repositories can query them without errors. Tests that exercise these
  // serving paths seed the minimal final rows they need.
  await client.command({
    query: buildTestAnalyticsTableStatement("analytics.activity_power_curve"),
  });
  await client.command({
    query: buildTestAnalyticsTableStatement("analytics.activity_aerobic_efficiency"),
  });
  await client.command({
    query: buildTestAnalyticsTableStatement("analytics.activity_polarization_zones"),
  });
  await client.command({
    query: buildTestAnalyticsTableStatement("analytics.cycling_activity"),
  });
  await client.command({
    query: buildTestAnalyticsTableStatement("analytics.daily_cycling"),
  });
}

export async function syncClickHouseTestActivitySensorStore(
  testContext: ClickHouseSyncTestContext,
): Promise<void> {
  const releaseSlot = await acquireClickHouseTestSetupSlot();
  try {
    await syncClickHouseTestActivitySensorStoreWithSlot(testContext);
  } finally {
    await releaseSlot();
  }
}

async function syncClickHouseTestActivitySensorStoreWithSlot(
  testContext: ClickHouseSyncTestContext,
): Promise<void> {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  await syncClickHouseTestActivitySensorStoreWithClient(
    handle.setupClient,
    testContext.connectionString,
  );
}

async function syncClickHouseTestActivitySensorStoreWithClient(
  client: ClickHouseClient,
  connectionString: string,
): Promise<void> {
  for (const rawTableSync of rawTableSyncs) {
    await client.command({
      query: `TRUNCATE TABLE postgres_fitness.${rawTableSync.tableName}`,
    });
    await client.command({
      query: buildRawTableInsertStatement(connectionString, rawTableSync),
    });
  }

  await rebuildClickHouseSensorAnalyticsWithClient(client);
}

function formatNullableClickHouseString(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return clickHouseStringLiteral(value);
}

function formatNullableClickHouseUuid(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `toUUID(${clickHouseStringLiteral(value)})`;
}

function formatNullableClickHouseFloat(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return String(value);
}

function formatClickHouseVector(value: readonly number[] | null | undefined): string {
  if (!value || value.length === 0) {
    return "[]";
  }
  return `[${value.join(",")}]`;
}

function formatClickHouseMetricStreamSeedValue(row: ClickHouseMetricStreamSeedRow): string {
  const id = row.id ?? randomUUID();
  return `(
    toUUID(${clickHouseStringLiteral(id)}),
    ${formatNullableClickHouseUuid(row.activityId)},
    toUUID(${clickHouseStringLiteral(row.userId)}),
    parseDateTime64BestEffort(${clickHouseStringLiteral(row.recordedAt)}, 6, 'UTC'),
    ${clickHouseStringLiteral(row.channel)},
    ${clickHouseStringLiteral(row.providerId)},
    ${formatNullableClickHouseString(row.externalId)},
    ${formatNullableClickHouseString(row.deviceId)},
    ${formatNullableClickHouseString(row.sourceType)},
    ${formatNullableClickHouseFloat(row.scalar)},
    ${formatClickHouseVector(row.vector)},
    ${formatNullableClickHouseString(row.point ?? "")},
    ${formatNullableClickHouseString(row.metadata ?? "")},
    now64(9),
    0,
    1,
    ${row.generation ?? 0}
  )`;
}

export async function insertClickHouseMetricStreamRows(
  testContext: ClickHouseSyncTestContext,
  rows: readonly ClickHouseMetricStreamSeedRow[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  await handle.setupClient.command({
    query: `INSERT INTO ingest.metric_stream (
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
    ) VALUES ${rows.map(formatClickHouseMetricStreamSeedValue).join(",\n")}`,
  });
}

export async function rebuildClickHouseSensorAnalytics(
  testContext: ClickHouseSyncTestContext,
): Promise<void> {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  await rebuildClickHouseSensorAnalyticsWithClient(handle.setupClient);
}

export async function executeClickHouseTestCommand(
  testContext: ClickHouseSyncTestContext,
  query: string,
): Promise<void> {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  await handle.setupClient.command({ query });
}

export async function seedClickHouseMetricStreamRows(
  testContext: ClickHouseSyncTestContext,
  rows: readonly ClickHouseMetricStreamSeedRow[],
): Promise<void> {
  await insertClickHouseMetricStreamRows(testContext, rows);
  await rebuildClickHouseSensorAnalytics(testContext);
}

async function rebuildClickHouseSensorAnalyticsWithClient(client: ClickHouseClient): Promise<void> {
  await client.command({ query: "TRUNCATE TABLE analytics.sensor_scalar_sample" });
  await client.command({ query: "TRUNCATE TABLE analytics.deduped_sensor" });
  await client.command({ query: "TRUNCATE TABLE analytics.deduped_activities" });
  await client.command({ query: "TRUNCATE TABLE analytics.activity_vo2max_estimate" });
  await client.command({ query: buildSensorScalarSampleBackfillSql() });
  await client.command({ query: buildDedupedSensorBackfillSql() });

  for (const viewName of analyticsBuildOrder) {
    await client.command({ query: `REBUILD TEST ANALYTICS TABLE ${viewName}` });
  }
}
