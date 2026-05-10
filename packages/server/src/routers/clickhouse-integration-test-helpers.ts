import { randomBytes } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
  parsePostgresConnectionForClickHouse,
} from "../../../../src/db/clickhouse.ts";
import { runClickHouseMigrations } from "../../../../src/db/clickhouse-migrations.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { ClickHouseActivitySensorStore } from "../repositories/clickhouse-activity-sensor-store.ts";

interface ClickHouseSyncTestContext {
  addCleanup(cleanup: () => Promise<void>): void;
  connectionString: string;
}

interface IsolatedClickHouseDatabases {
  analytics: string;
  postgresFitness: string;
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
    tableName: "metric_stream",
    columns: [
      "id",
      "activity_id",
      "user_id",
      "recorded_at",
      "channel",
      "provider_id",
      "external_id",
      "device_id",
      "source_type",
      "scalar",
    ],
  },
  {
    tableName: "activity",
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
      "sleep_type",
      "sleep_need_baseline_minutes",
      "sleep_need_from_debt_minutes",
      "sleep_need_from_strain_minutes",
      "sleep_need_from_nap_minutes",
      "source_name",
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
      "active_energy_kcal",
      "basal_energy_kcal",
      "distance_km",
      "cycling_distance_km",
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
const analyticsRefreshOrder = [
  "analytics.v_activity",
  "analytics.v_activity_members",
  "analytics.v_sleep",
  "analytics.v_body_measurement",
  "analytics.v_daily_metrics",
  "analytics.provider_stats",
  "analytics.deduped_sensor",
  "analytics.deduped_location",
  "analytics.activity_summary",
  "analytics.activity_trend_daily",
] as const;

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

function rewriteClickHouseDatabaseNames(
  query: string,
  databases: IsolatedClickHouseDatabases,
): string {
  return query
    .replace(/\bpostgres_fitness\b/g, databases.postgresFitness)
    .replace(/\banalytics\b/g, databases.analytics);
}

function buildTestReadModelTableStatement(viewName: string): string | null {
  const columnDefinitionsByViewName: Record<string, string> = {
    v_activity: `id UUID,
provider_id String,
user_id UUID,
primary_activity_id UUID,
activity_type String,
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
source_name Nullable(String),
name Nullable(String),
notes Nullable(String),
timezone Nullable(String),
raw Nullable(String),
source_providers Array(String),
source_external_ids Array(Map(String, Nullable(String))),
member_activity_ids Array(UUID)`,
    v_activity_members: `activity_id UUID,
user_id UUID,
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
member_activity_id UUID`,
    v_sleep: `id UUID,
provider_id String,
user_id UUID,
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
duration_minutes Nullable(Int32),
deep_minutes Nullable(Int32),
rem_minutes Nullable(Int32),
light_minutes Nullable(Int32),
awake_minutes Nullable(Int32),
efficiency_pct Nullable(Float64),
sleep_type Nullable(String),
is_nap Nullable(Bool),
source_name Nullable(String),
source_providers Array(String)`,
    v_body_measurement: `id UUID,
provider_id String,
user_id UUID,
external_id String,
recorded_at DateTime64(6, 'UTC'),
created_at DateTime64(9),
weight_kg Nullable(Float32),
body_fat_pct Nullable(Float32),
muscle_mass_kg Nullable(Float32),
bone_mass_kg Nullable(Float32),
water_pct Nullable(Float32),
bmi Nullable(Float32),
height_cm Nullable(Float32),
waist_circumference_cm Nullable(Float32),
systolic_bp Nullable(Int32),
diastolic_bp Nullable(Int32),
heart_pulse Nullable(Int32),
temperature_c Nullable(Float32),
source_name Nullable(String),
source_providers Array(String)`,
    v_daily_metrics: `date Date,
user_id UUID,
hrv Nullable(Float32),
spo2_avg Nullable(Float32),
respiratory_rate_avg Nullable(Float32),
skin_temp_c Nullable(Float32),
steps Nullable(Int32),
active_energy_kcal Nullable(Float32),
basal_energy_kcal Nullable(Float32),
distance_km Nullable(Float32),
flights_climbed Nullable(Int32),
exercise_minutes Nullable(Int32),
stand_hours Nullable(Int32),
walking_speed Nullable(Float32),
walking_step_length Nullable(Float32),
walking_double_support_pct Nullable(Float32),
walking_asymmetry_pct Nullable(Float32),
walking_steadiness Nullable(Float32),
source_providers Array(String)`,
    provider_stats: `user_id UUID,
provider_id String,
activities UInt64,
daily_metrics UInt64,
sleep_sessions UInt64,
body_measurements UInt64,
food_entries UInt64,
health_events UInt64,
metric_stream UInt64,
nutrition_daily UInt64,
lab_panels UInt64,
lab_results UInt64,
journal_entries UInt64`,
    deduped_sensor: `activity_id Nullable(UUID),
user_id UUID,
recorded_at DateTime64(6, 'UTC'),
channel String,
scalar Nullable(Float32)`,
    deduped_location: `activity_id UUID,
user_id UUID,
recorded_at DateTime64(6, 'UTC'),
lat Nullable(Float32),
lng Nullable(Float32)`,
    activity_summary: `activity_id UUID,
user_id UUID,
activity_type String,
name Nullable(String),
started_at DateTime64(6, 'UTC'),
ended_at Nullable(DateTime64(6, 'UTC')),
avg_hr Nullable(Float64),
max_hr Nullable(Int16),
min_hr Nullable(Int16),
avg_power Nullable(Float64),
max_power Nullable(Int16),
avg_speed Nullable(Float64),
max_speed Nullable(Float64),
avg_cadence Nullable(Float64),
elevation_gain_legacy Nullable(Float64),
total_distance Nullable(Float64),
avg_left_balance Nullable(Float64),
avg_left_torque_eff Nullable(Float64),
avg_right_torque_eff Nullable(Float64),
avg_left_pedal_smooth Nullable(Float64),
avg_right_pedal_smooth Nullable(Float64),
elevation_gain_m Nullable(Float64),
elevation_loss_m Nullable(Float64),
avg_stance_time Nullable(Float64),
avg_vertical_osc Nullable(Float64),
avg_ground_contact_time Nullable(Float64),
avg_stride_length Nullable(Float64),
sample_count UInt64,
hr_sample_count UInt64,
power_sample_count UInt64,
first_sample_at DateTime64(6, 'UTC'),
last_sample_at DateTime64(6, 'UTC')`,
    activity_trend_daily: `user_id UUID,
bucket_date Date,
avg_hr Nullable(Float64),
max_hr Nullable(Int16),
avg_power Nullable(Float64),
max_power Nullable(Int16),
avg_cadence Nullable(Float64),
avg_speed Nullable(Float64),
total_samples UInt64,
hr_samples UInt64,
power_samples UInt64,
cadence_samples UInt64,
speed_samples UInt64,
activity_count UInt64`,
  };
  const shortViewName = viewName.split(".").at(-1);
  if (!shortViewName) {
    return null;
  }
  const columnDefinitions = columnDefinitionsByViewName[shortViewName];
  if (!columnDefinitions) {
    return null;
  }
  return `CREATE TABLE IF NOT EXISTS ${viewName} (
${columnDefinitions}
)
ENGINE = MergeTree
ORDER BY tuple()`;
}

function rewriteClickHouseTestCommand(
  query: string,
  databases: IsolatedClickHouseDatabases,
  readModelSelectByName: Map<string, string>,
): string[] {
  const rewrittenQuery = rewriteClickHouseDatabaseNames(query, databases).trim();
  const materializedViewMatch = rewrittenQuery.match(
    /^CREATE MATERIALIZED VIEW IF NOT EXISTS ([A-Za-z0-9_]+\.[A-Za-z0-9_]+)\nREFRESH EVERY[^\n]*\nENGINE = MergeTree\nORDER BY [^\n]+\n(?:SETTINGS allow_nullable_key = 1\n)?AS\n?([\s\S]*)$/,
  );

  if (materializedViewMatch) {
    const viewName = materializedViewMatch[1];
    const selectSql = materializedViewMatch[2];
    if (!viewName || !selectSql) {
      throw new Error("Could not parse ClickHouse test materialized view statement");
    }
    const trimmedSelectSql = selectSql.trim();
    readModelSelectByName.set(viewName, trimmedSelectSql);
    const tableStatement = buildTestReadModelTableStatement(viewName);
    if (!tableStatement) {
      throw new Error(`Missing ClickHouse test read-model table schema for ${viewName}`);
    }
    return [tableStatement];
  }

  if (rewrittenQuery.startsWith(`DROP VIEW IF EXISTS ${databases.analytics}.`)) {
    return [rewrittenQuery.replace("DROP VIEW IF EXISTS", "DROP TABLE IF EXISTS")];
  }

  const refreshViewPrefix = `SYSTEM REFRESH VIEW ${databases.analytics}.`;
  if (rewrittenQuery.startsWith(refreshViewPrefix)) {
    const viewName = rewrittenQuery.slice("SYSTEM REFRESH VIEW ".length);
    const selectSql = readModelSelectByName.get(viewName);
    if (!selectSql) {
      throw new Error(`Missing ClickHouse test read-model SELECT for ${viewName}`);
    }
    return [`TRUNCATE TABLE ${viewName}`, `INSERT INTO ${viewName}\n${selectSql}`];
  }

  if (rewrittenQuery.startsWith(`SYSTEM WAIT VIEW ${databases.analytics}.`)) {
    return ["SELECT 1"];
  }

  return [rewrittenQuery];
}

function createIsolatedClickHouseClient(
  client: ClickHouseClient,
  databases: IsolatedClickHouseDatabases,
): ClickHouseClient {
  const readModelSelectByName = new Map<string, string>();
  return {
    command: async (options) => {
      const queries = rewriteClickHouseTestCommand(options.query, databases, readModelSelectByName);
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
    }) =>
      client.query<TRow>({
        ...options,
        query: rewriteClickHouseDatabaseNames(options.query, databases),
      }),
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
    postgresFitness: `postgres_fitness_test_${suffix}`,
  };
  const rawClient = createClickHouseClientFromEnv();
  const setupClient = createIsolatedClickHouseClient(rawClient, databases);
  const client = setupClient;
  handlesByContext.set(testContext, { client, setupClient });

  testContext.addCleanup(async () => {
    handlesByContext.delete(testContext);
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.analytics} SYNC` });
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.postgresFitness} SYNC` });
    await rawClient.close?.();
  });

  const releaseSlot = await acquireClickHouseTestSetupSlot();
  try {
    await runClickHouseMigrations(setupClient, testContext.connectionString);
    await syncClickHouseTestActivitySensorStoreWithClient(
      setupClient,
      testContext.connectionString,
    );
  } finally {
    await releaseSlot();
  }

  return new ClickHouseActivitySensorStore(client);
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

  for (const viewName of analyticsRefreshOrder) {
    await client.command({ query: `SYSTEM REFRESH VIEW ${viewName}` });
    await client.command({ query: `SYSTEM WAIT VIEW ${viewName}` });
  }
}
