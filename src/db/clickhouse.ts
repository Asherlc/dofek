import { createClient } from "@clickhouse/client";

export interface ClickHouseCommandClient {
  command(options: {
    query: string;
    clickhouse_settings?: Record<string, string | number | boolean>;
  }): Promise<unknown>;
  query?<TRow extends object>(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<TRow[]> }>;
  close?(): Promise<void>;
}

export interface ClickHouseClient extends ClickHouseCommandClient {
  query<TRow extends object>(options: {
    query: string;
    format: "JSONEachRow";
    query_params?: Record<string, unknown>;
  }): Promise<{ json(): Promise<TRow[]> }>;
}

interface TableCountRow {
  table_count: number | string;
}

interface ClickHousePostgresConnection {
  hostAndPort: string;
  database: string;
  user: string;
  password: string;
}

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function normalizePostgresHostForClickHouse(hostname: string): string {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return "host.docker.internal";
  }
  return hostname;
}

export function parsePostgresConnectionForClickHouse(
  connectionString: string,
): ClickHousePostgresConnection {
  const url = new URL(connectionString);
  const database = url.pathname.replace(/^\//, "");
  if (!database) {
    throw new Error(
      "DATABASE_URL must include a database name for ClickHouse Postgres replication",
    );
  }

  const host = normalizePostgresHostForClickHouse(url.hostname);
  const port = url.port || "5432";

  return {
    hostAndPort: `${host}:${port}`,
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export function buildClickHouseBootstrapStatements(postgresConnectionString: string): string[] {
  const postgres = parsePostgresConnectionForClickHouse(postgresConnectionString);
  const hostAndPort = clickHouseStringLiteral(postgres.hostAndPort);
  const database = clickHouseStringLiteral(postgres.database);
  const user = clickHouseStringLiteral(postgres.user);
  const password = clickHouseStringLiteral(postgres.password);

  return [
    "CREATE DATABASE IF NOT EXISTS analytics",
    `CREATE DATABASE IF NOT EXISTS postgres_fitness
ENGINE = MaterializedPostgreSQL(${hostAndPort}, ${database}, ${user}, ${password})
SETTINGS materialized_postgresql_schema = 'fitness',
         materialized_postgresql_tables_list = 'metric_stream'`,
    `CREATE DATABASE IF NOT EXISTS postgres_fitness_live
ENGINE = PostgreSQL(${hostAndPort}, ${database}, ${user}, ${password}, 'clickhouse')`,
    `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor
REFRESH EVERY 1 MINUTE
ENGINE = MergeTree
ORDER BY (user_id, activity_id, channel, recorded_at)
SETTINGS allow_nullable_key = 1
AS
WITH
activity_members AS (
  SELECT
    activity_id,
    user_id,
    started_at,
    ended_at,
    member_activity_id
  FROM postgres_fitness_live.v_activity_members
),
linked_best_source AS (
  SELECT
    best_source.activity_id AS activity_id,
    best_source.channel AS channel,
    best_source.provider_id AS provider_id
  FROM (
    SELECT
      activity_members.activity_id AS activity_id,
      metric_stream.metric_channel AS channel,
      metric_stream.metric_provider_id AS provider_id,
      count() AS sample_count,
      row_number() OVER (
        PARTITION BY activity_members.activity_id, metric_stream.metric_channel
        ORDER BY count() DESC, metric_stream.metric_provider_id ASC
      ) AS row_number
    FROM (
      SELECT
        activity_id AS metric_activity_id,
        channel AS metric_channel,
        provider_id AS metric_provider_id,
        scalar AS metric_scalar
      FROM postgres_fitness.metric_stream
    ) AS metric_stream
    INNER JOIN activity_members
      ON metric_stream.metric_activity_id = activity_members.member_activity_id
    WHERE metric_stream.metric_activity_id IS NOT NULL
      AND metric_stream.metric_scalar IS NOT NULL
    GROUP BY activity_members.activity_id, metric_stream.metric_channel, metric_stream.metric_provider_id
  ) AS best_source
  WHERE best_source.row_number = 1
),
linked_sample_bounds AS (
  SELECT
    activity_members.activity_id AS activity_id,
    max(metric_stream.metric_recorded_at) AS last_linked_sample_at
  FROM (
    SELECT
      activity_id AS metric_activity_id,
      recorded_at AS metric_recorded_at
    FROM postgres_fitness.metric_stream
  ) AS metric_stream
  INNER JOIN activity_members
    ON metric_stream.metric_activity_id = activity_members.member_activity_id
  WHERE metric_stream.metric_activity_id IS NOT NULL
  GROUP BY activity_members.activity_id
),
fallback_windows AS (
  SELECT
    activity.id AS activity_id,
    activity.user_id AS user_id,
    activity.started_at AS started_at,
    coalesce(activity.ended_at, linked_sample_bounds.last_linked_sample_at) AS fallback_ended_at
  FROM postgres_fitness_live.v_activity AS activity
  LEFT JOIN linked_sample_bounds
    ON linked_sample_bounds.activity_id = activity.id
),
ambient_best_source AS (
  SELECT
    best_source.activity_id AS activity_id,
    best_source.channel AS channel,
    best_source.provider_id AS provider_id
  FROM (
    SELECT
      fallback_windows.activity_id AS activity_id,
      metric_stream.metric_channel AS channel,
      metric_stream.metric_provider_id AS provider_id,
      count() AS sample_count,
      row_number() OVER (
        PARTITION BY fallback_windows.activity_id, metric_stream.metric_channel
        ORDER BY count() DESC, metric_stream.metric_provider_id ASC
      ) AS row_number
    FROM (
      SELECT
        activity_id AS metric_activity_id,
        user_id AS metric_user_id,
        recorded_at AS metric_recorded_at,
        channel AS metric_channel,
        provider_id AS metric_provider_id,
        scalar AS metric_scalar
      FROM postgres_fitness.metric_stream
    ) AS metric_stream
    INNER JOIN fallback_windows
      ON fallback_windows.user_id = metric_stream.metric_user_id
    LEFT JOIN linked_best_source
      ON linked_best_source.activity_id = fallback_windows.activity_id
     AND linked_best_source.channel = metric_stream.metric_channel
    WHERE metric_stream.metric_activity_id IS NULL
      AND fallback_windows.fallback_ended_at IS NOT NULL
      AND metric_stream.metric_recorded_at >= fallback_windows.started_at
      AND metric_stream.metric_recorded_at <= fallback_windows.fallback_ended_at
      AND metric_stream.metric_scalar IS NOT NULL
      AND linked_best_source.activity_id IS NULL
    GROUP BY fallback_windows.activity_id, metric_stream.metric_channel, metric_stream.metric_provider_id
  ) AS best_source
  WHERE best_source.row_number = 1
),
linked_samples AS (
  SELECT
    activity_members.activity_id AS activity_id,
    activity_members.user_id AS user_id,
    metric_stream.metric_recorded_at AS recorded_at,
    metric_stream.metric_channel AS channel,
    max(metric_stream.metric_scalar) AS scalar
  FROM (
    SELECT
      activity_id AS metric_activity_id,
      recorded_at AS metric_recorded_at,
      channel AS metric_channel,
      provider_id AS metric_provider_id,
      scalar AS metric_scalar
    FROM postgres_fitness.metric_stream
  ) AS metric_stream
  INNER JOIN activity_members
    ON metric_stream.metric_activity_id = activity_members.member_activity_id
  INNER JOIN linked_best_source
    ON linked_best_source.activity_id = activity_members.activity_id
   AND linked_best_source.channel = metric_stream.metric_channel
   AND linked_best_source.provider_id = metric_stream.metric_provider_id
  WHERE metric_stream.metric_activity_id IS NOT NULL
    AND metric_stream.metric_scalar IS NOT NULL
  GROUP BY activity_members.activity_id, activity_members.user_id, metric_stream.metric_recorded_at, metric_stream.metric_channel
),
ambient_samples AS (
  SELECT
    fallback_windows.activity_id AS activity_id,
    fallback_windows.user_id AS user_id,
    metric_stream.metric_recorded_at AS recorded_at,
    metric_stream.metric_channel AS channel,
    max(metric_stream.metric_scalar) AS scalar
  FROM (
    SELECT
      activity_id AS metric_activity_id,
      user_id AS metric_user_id,
      recorded_at AS metric_recorded_at,
      channel AS metric_channel,
      provider_id AS metric_provider_id,
      scalar AS metric_scalar
    FROM postgres_fitness.metric_stream
  ) AS metric_stream
  INNER JOIN fallback_windows
    ON fallback_windows.user_id = metric_stream.metric_user_id
  INNER JOIN ambient_best_source
    ON ambient_best_source.activity_id = fallback_windows.activity_id
   AND ambient_best_source.channel = metric_stream.metric_channel
   AND ambient_best_source.provider_id = metric_stream.metric_provider_id
  WHERE metric_stream.metric_activity_id IS NULL
    AND fallback_windows.fallback_ended_at IS NOT NULL
    AND metric_stream.metric_recorded_at >= fallback_windows.started_at
    AND metric_stream.metric_recorded_at <= fallback_windows.fallback_ended_at
    AND metric_stream.metric_scalar IS NOT NULL
  GROUP BY fallback_windows.activity_id, fallback_windows.user_id, metric_stream.metric_recorded_at, metric_stream.metric_channel
)
SELECT
  linked_samples.activity_id AS activity_id,
  linked_samples.user_id AS user_id,
  linked_samples.recorded_at AS recorded_at,
  linked_samples.channel AS channel,
  linked_samples.scalar AS scalar
FROM linked_samples
UNION ALL
SELECT
  ambient_samples.activity_id AS activity_id,
  ambient_samples.user_id AS user_id,
  ambient_samples.recorded_at AS recorded_at,
  ambient_samples.channel AS channel,
  ambient_samples.scalar AS scalar
FROM ambient_samples`,
    "SYSTEM REFRESH VIEW analytics.deduped_sensor",
    "SYSTEM WAIT VIEW analytics.deduped_sensor",
    `CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary
REFRESH EVERY 1 MINUTE OFFSET 10 SECOND
ENGINE = MergeTree
ORDER BY (user_id, started_at, activity_id)
SETTINGS allow_nullable_key = 1
AS
WITH
deduped_samples AS (
  SELECT activity_id, user_id, recorded_at, channel, scalar
  FROM analytics.deduped_sensor
),
activity_bounds AS (
  SELECT
    id AS activity_id,
    user_id,
    activity_type,
    name,
    started_at,
    ended_at
  FROM postgres_fitness_live.v_activity
),
altitude_deltas AS (
  SELECT
    activity_id,
    scalar AS altitude,
    lagInFrame(scalar) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS prev_altitude
  FROM deduped_samples
  WHERE channel = 'altitude'
),
elevation_per_activity AS (
  SELECT
    activity_id,
    CAST(sum(if(altitude - prev_altitude > 0, altitude - prev_altitude, 0)), 'Nullable(Float64)') AS elevation_gain_m,
    CAST(sum(if(altitude - prev_altitude < 0, abs(altitude - prev_altitude), 0)), 'Nullable(Float64)') AS elevation_loss_m
  FROM altitude_deltas
  WHERE prev_altitude IS NOT NULL
  GROUP BY activity_id
),
gps_points AS (
  SELECT
    lat_samples.activity_id AS activity_id,
    lat_samples.recorded_at AS recorded_at,
    lat_samples.scalar AS lat,
    lng_samples.scalar AS lng
  FROM deduped_samples AS lat_samples
  INNER JOIN deduped_samples AS lng_samples
    ON lat_samples.activity_id = lng_samples.activity_id
   AND lat_samples.recorded_at = lng_samples.recorded_at
   AND lng_samples.channel = 'lng'
  WHERE lat_samples.channel = 'lat'
),
gps_deltas AS (
  SELECT
    activity_id,
    lat,
    lng,
    lagInFrame(lat) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS prev_lat,
    lagInFrame(lng) OVER (
      PARTITION BY activity_id
      ORDER BY recorded_at
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS prev_lng
  FROM gps_points
),
distance_per_activity AS (
  SELECT
    activity_id,
    CAST(sum(
      2 * 6371000 * asin(sqrt(
        pow(sin(radians(lat - prev_lat) / 2), 2)
        + cos(radians(prev_lat)) * cos(radians(lat))
        * pow(sin(radians(lng - prev_lng) / 2), 2)
      ))
    ), 'Nullable(Float64)') AS total_distance
  FROM gps_deltas
  WHERE prev_lat IS NOT NULL
  GROUP BY activity_id
),
channel_aggs AS (
  SELECT
    activity_id,
    user_id,
    CAST(avgIf(scalar, channel = 'heart_rate'), 'Nullable(Float64)') AS avg_hr,
    CAST(maxIf(scalar, channel = 'heart_rate'), 'Nullable(Int16)') AS max_hr,
    CAST(minIf(scalar, channel = 'heart_rate'), 'Nullable(Int16)') AS min_hr,
    CAST(avgIf(scalar, channel = 'power' AND scalar > 0), 'Nullable(Float64)') AS avg_power,
    CAST(maxIf(scalar, channel = 'power' AND scalar > 0), 'Nullable(Int16)') AS max_power,
    CAST(avgIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS avg_speed,
    CAST(maxIf(scalar, channel = 'speed'), 'Nullable(Float64)') AS max_speed,
    CAST(avgIf(scalar, channel = 'cadence' AND scalar > 0), 'Nullable(Float64)') AS avg_cadence,
    CAST(maxIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS max_altitude,
    CAST(minIf(scalar, channel = 'altitude'), 'Nullable(Float64)') AS min_altitude,
    CAST(avgIf(scalar, channel = 'left_right_balance'), 'Nullable(Float64)') AS avg_left_balance,
    CAST(avgIf(scalar, channel = 'left_torque_effectiveness'), 'Nullable(Float64)') AS avg_left_torque_eff,
    CAST(avgIf(scalar, channel = 'right_torque_effectiveness'), 'Nullable(Float64)') AS avg_right_torque_eff,
    CAST(avgIf(scalar, channel = 'left_pedal_smoothness'), 'Nullable(Float64)') AS avg_left_pedal_smooth,
    CAST(avgIf(scalar, channel = 'right_pedal_smoothness'), 'Nullable(Float64)') AS avg_right_pedal_smooth,
    CAST(avgIf(scalar, channel = 'stance_time'), 'Nullable(Float64)') AS avg_stance_time,
    CAST(avgIf(scalar, channel = 'vertical_oscillation'), 'Nullable(Float64)') AS avg_vertical_osc,
    CAST(avgIf(scalar, channel = 'ground_contact_time'), 'Nullable(Float64)') AS avg_ground_contact_time,
    CAST(avgIf(scalar, channel = 'stride_length'), 'Nullable(Float64)') AS avg_stride_length,
    count() AS sample_count,
    countIf(channel = 'heart_rate') AS hr_sample_count,
    countIf(channel = 'power' AND scalar > 0) AS power_sample_count,
    min(recorded_at) AS first_sample_at,
    max(recorded_at) AS last_sample_at
  FROM deduped_samples
  GROUP BY activity_id, user_id
)
SELECT
  activity_bounds.activity_id AS activity_id,
  activity_bounds.user_id AS user_id,
  activity_bounds.activity_type AS activity_type,
  activity_bounds.name AS name,
  activity_bounds.started_at AS started_at,
  activity_bounds.ended_at AS ended_at,
  channel_aggs.avg_hr AS avg_hr,
  channel_aggs.max_hr AS max_hr,
  channel_aggs.min_hr AS min_hr,
  channel_aggs.avg_power AS avg_power,
  channel_aggs.max_power AS max_power,
  if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'),
     NULL,
     channel_aggs.avg_speed) AS avg_speed,
  if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'),
     NULL,
     channel_aggs.max_speed) AS max_speed,
  channel_aggs.avg_cadence AS avg_cadence,
  if(channel_aggs.max_altitude IS NOT NULL AND channel_aggs.min_altitude IS NOT NULL,
     channel_aggs.max_altitude - channel_aggs.min_altitude,
     NULL) AS elevation_gain_legacy,
  if(activity_bounds.activity_type IN ('indoor_cycling', 'virtual_cycling'),
     CAST(0, 'Nullable(Float64)'),
     coalesce(distance_per_activity.total_distance, CAST(0, 'Nullable(Float64)'))) AS total_distance,
  channel_aggs.avg_left_balance AS avg_left_balance,
  channel_aggs.avg_left_torque_eff AS avg_left_torque_eff,
  channel_aggs.avg_right_torque_eff AS avg_right_torque_eff,
  channel_aggs.avg_left_pedal_smooth AS avg_left_pedal_smooth,
  channel_aggs.avg_right_pedal_smooth AS avg_right_pedal_smooth,
  coalesce(elevation_per_activity.elevation_gain_m, CAST(0, 'Nullable(Float64)')) AS elevation_gain_m,
  coalesce(elevation_per_activity.elevation_loss_m, CAST(0, 'Nullable(Float64)')) AS elevation_loss_m,
  channel_aggs.avg_stance_time AS avg_stance_time,
  channel_aggs.avg_vertical_osc AS avg_vertical_osc,
  channel_aggs.avg_ground_contact_time AS avg_ground_contact_time,
  channel_aggs.avg_stride_length AS avg_stride_length,
  channel_aggs.sample_count AS sample_count,
  channel_aggs.hr_sample_count AS hr_sample_count,
  channel_aggs.power_sample_count AS power_sample_count,
  channel_aggs.first_sample_at AS first_sample_at,
  channel_aggs.last_sample_at AS last_sample_at
FROM activity_bounds
LEFT JOIN channel_aggs
  ON channel_aggs.activity_id = activity_bounds.activity_id
LEFT JOIN elevation_per_activity
  ON elevation_per_activity.activity_id = activity_bounds.activity_id
LEFT JOIN distance_per_activity
  ON distance_per_activity.activity_id = activity_bounds.activity_id`,
    "SYSTEM REFRESH VIEW analytics.activity_summary",
    "SYSTEM WAIT VIEW analytics.activity_summary",
  ];
}

export function createClickHouseClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClickHouseClient {
  const url = env.CLICKHOUSE_URL;
  if (!url) {
    throw new Error("CLICKHOUSE_URL environment variable is required");
  }
  return createClient({ url });
}

export async function bootstrapClickHouseFromEnv(client: ClickHouseCommandClient): Promise<void> {
  await waitForClickHouseTable(client, "postgres_fitness", "metric_stream");
  await waitForClickHouseTable(client, "analytics", "deduped_sensor");
  await waitForClickHouseTable(client, "analytics", "activity_summary");
  await smokeTestClickHouseTable(client, "postgres_fitness.metric_stream");
  await smokeTestClickHouseTable(client, "analytics.deduped_sensor");
  await smokeTestClickHouseTable(client, "analytics.activity_summary");
}

async function smokeTestClickHouseTable(
  client: ClickHouseCommandClient,
  tableName: string,
): Promise<void> {
  if (!client.query) {
    throw new Error("ClickHouse smoke verification requires a query-capable client");
  }
  const result = await client.query({
    query: `SELECT count() AS smoke_count FROM ${tableName} LIMIT 1`,
    format: "JSONEachRow",
  });
  await result.json();
}

export async function waitForClickHouseTable(
  client: ClickHouseCommandClient,
  database: string,
  table: string,
): Promise<void> {
  if (!client.query) {
    throw new Error("ClickHouse table verification requires a query-capable client");
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await client.query<TableCountRow>({
      query: `SELECT count() AS table_count FROM system.tables WHERE database = ${clickHouseStringLiteral(
        database,
      )} AND name = ${clickHouseStringLiteral(table)}`,
      format: "JSONEachRow",
    });
    const rows = await result.json();
    if (Number(rows[0]?.table_count ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for ClickHouse table ${database}.${table}`);
}
