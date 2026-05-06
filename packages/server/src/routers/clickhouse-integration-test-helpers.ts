import { randomBytes } from "node:crypto";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
  parsePostgresConnectionForClickHouse,
} from "../../../../src/db/clickhouse.ts";
import { runClickHouseMigrations } from "../../../../src/db/clickhouse-migrations.ts";
import type { TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { ClickHouseActivitySensorStore } from "../repositories/clickhouse-activity-sensor-store.ts";

interface IsolatedClickHouseDatabases {
  analytics: string;
  postgresFitness: string;
  postgresFitnessLive: string;
}

interface ClickHouseTestHandle {
  client: ClickHouseClient;
}

interface RawTableSync {
  columns: string[];
  tableName: string;
}

const handlesByContext = new WeakMap<TestContext, ClickHouseTestHandle>();
const rawTableSyncs: RawTableSync[] = [
  {
    tableName: "metric_stream",
    columns: ["id", "activity_id", "user_id", "recorded_at", "channel", "provider_id", "scalar"],
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
    tableName: "body_measurement",
    columns: [
      "id",
      "recorded_at",
      "provider_id",
      "user_id",
      "external_id",
      "weight_kg",
      "body_fat_pct",
      "muscle_mass_kg",
      "bone_mass_kg",
      "water_pct",
      "bmi",
      "height_cm",
      "waist_circumference_cm",
      "systolic_bp",
      "diastolic_bp",
      "heart_pulse",
      "temperature_c",
      "source_name",
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
  "analytics.derived_resting_heart_rate",
  "analytics.provider_stats",
  "analytics.deduped_sensor",
  "analytics.activity_summary",
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
    .replace(/\bpostgres_fitness_live\b/g, databases.postgresFitnessLive)
    .replace(/\bpostgres_fitness\b/g, databases.postgresFitness)
    .replace(/\banalytics\b/g, databases.analytics);
}

function createIsolatedClickHouseClient(
  client: ClickHouseClient,
  databases: IsolatedClickHouseDatabases,
): ClickHouseClient {
  return {
    command: (options) =>
      client.command({
        ...options,
        query: rewriteClickHouseDatabaseNames(options.query, databases),
      }),
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

export async function createClickHouseTestActivitySensorStore(
  testContext: TestContext,
): Promise<ActivitySensorStore> {
  const suffix = randomBytes(6).toString("hex");
  const databases = {
    analytics: `analytics_test_${suffix}`,
    postgresFitness: `postgres_fitness_test_${suffix}`,
    postgresFitnessLive: `postgres_fitness_live_test_${suffix}`,
  };
  const rawClient = createClickHouseClientFromEnv();
  const client = createIsolatedClickHouseClient(rawClient, databases);
  handlesByContext.set(testContext, { client });

  testContext.addCleanup(async () => {
    handlesByContext.delete(testContext);
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.analytics} SYNC` });
    await rawClient.command({ query: `DROP DATABASE IF EXISTS ${databases.postgresFitness} SYNC` });
    await rawClient.command({
      query: `DROP DATABASE IF EXISTS ${databases.postgresFitnessLive} SYNC`,
    });
    await rawClient.close?.();
  });

  await runClickHouseMigrations(client, testContext.connectionString);
  await syncClickHouseTestActivitySensorStore(testContext);

  return new ClickHouseActivitySensorStore(client);
}

export async function syncClickHouseTestActivitySensorStore(
  testContext: TestContext,
): Promise<void> {
  const handle = handlesByContext.get(testContext);
  if (!handle) {
    throw new Error("ClickHouse test activity sensor store has not been created");
  }

  for (const rawTableSync of rawTableSyncs) {
    await handle.client.command({
      query: `TRUNCATE TABLE postgres_fitness.${rawTableSync.tableName}`,
    });
    await handle.client.command({
      query: buildRawTableInsertStatement(testContext.connectionString, rawTableSync),
    });
  }

  for (const viewName of analyticsRefreshOrder) {
    await handle.client.command({ query: `SYSTEM REFRESH VIEW ${viewName}` });
    await handle.client.command({ query: `SYSTEM WAIT VIEW ${viewName}` });
  }
}
