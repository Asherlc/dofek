import { spawn } from "node:child_process";
import { formatSqlLiteral } from "./backfill-location-points.ts";

export type SqlInput = {
  statementTimeout: string;
  copyRangeInterval?: string;
};

export type CliOptions = {
  prepare: boolean;
  copy: boolean;
  status: boolean;
  execute: boolean;
  dryRun: boolean;
  maxTasks: number;
  sshHost: string;
  statementTimeout: string;
  copyRangeInterval: string;
};

type SpawnResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

function readOptionValue(args: string[], optionIndex: number, optionName: string): string {
  const value = args[optionIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parsePositiveInteger(args: string[], optionIndex: number, optionName: string): number {
  const value = Number.parseInt(readOptionValue(args, optionIndex, optionName), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return value;
}

function parseCopyRangeInterval(args: string[], optionIndex: number, optionName: string): string {
  const value = readOptionValue(args, optionIndex, optionName);
  if (!/^[1-9][0-9]* (minutes?|hours?|days?)$/.test(value)) {
    throw new Error(`${optionName} must look like "5 minutes", "1 hour", or "1 day"`);
  }
  return value;
}

export function buildPrepareSql(input: SqlInput): string {
  const statementTimeoutLiteral = formatSqlLiteral(input.statementTimeout);

  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = ${statementTimeoutLiteral};

CREATE TABLE IF NOT EXISTS fitness.metric_stream_rebuild (
  id uuid DEFAULT public.gen_random_uuid() NOT NULL,
  recorded_at timestamptz NOT NULL,
  user_id uuid NOT NULL,
  provider_id text NOT NULL,
  external_id text,
  device_id text,
  source_type text NOT NULL,
  channel text NOT NULL,
  activity_id uuid,
  scalar real,
  vector real[],
  point public.geometry(Point, 4326),
  metadata jsonb
);

DO $$
DECLARE
  foreign_key_constraint_name name;
BEGIN
  FOR foreign_key_constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'fitness.metric_stream_rebuild'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE fitness.metric_stream_rebuild DROP CONSTRAINT %I',
      foreign_key_constraint_name
    );
  END LOOP;
END;
$$;

SELECT public.create_hypertable(
  'fitness.metric_stream_rebuild'::regclass,
  'recorded_at'::name,
  if_not_exists => true
);

SELECT public.set_chunk_time_interval('fitness.metric_stream_rebuild', INTERVAL '1 day');

ALTER TABLE fitness.metric_stream_rebuild
SET (
  timescaledb.compress = true,
  timescaledb.compress_segmentby = 'user_id,provider_id,channel',
  timescaledb.compress_orderby = 'recorded_at DESC'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'fitness.metric_stream_rebuild'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE fitness.metric_stream_rebuild
    ADD CONSTRAINT metric_stream_rebuild_pkey PRIMARY KEY (id, recorded_at);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS metric_stream_rebuild_provider_external_channel_time_idx
ON fitness.metric_stream_rebuild (user_id, provider_id, external_id, channel, recorded_at);

CREATE TABLE IF NOT EXISTS fitness.metric_stream_rebuild_task (
  id bigserial PRIMARY KEY,
  source_chunk_schema text NOT NULL,
  source_chunk_name text NOT NULL,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  is_source_compressed boolean NOT NULL,
  next_range_start timestamptz,
  source_row_count bigint,
  passthrough_row_count bigint,
  location_row_count bigint,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_chunk_schema, source_chunk_name)
);

ALTER TABLE fitness.metric_stream_rebuild_task
ADD COLUMN IF NOT EXISTS next_range_start timestamptz;

UPDATE fitness.metric_stream_rebuild_task
SET next_range_start = range_start
WHERE next_range_start IS NULL;

INSERT INTO fitness.metric_stream_rebuild_task (
  source_chunk_schema,
  source_chunk_name,
  range_start,
  range_end,
  is_source_compressed,
  next_range_start
)
SELECT
  chunk_schema,
  chunk_name,
  range_start,
  range_end,
  is_compressed,
  range_start
FROM timescaledb_information.chunks
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream'
  AND range_end <= date_trunc('day', clock_timestamp())
ON CONFLICT (source_chunk_schema, source_chunk_name) DO UPDATE
SET
  range_start = EXCLUDED.range_start,
  range_end = EXCLUDED.range_end,
  is_source_compressed = EXCLUDED.is_source_compressed,
  next_range_start = COALESCE(fitness.metric_stream_rebuild_task.next_range_start, EXCLUDED.range_start);

COMMIT;`;
}

export function buildCopyTaskSql(input: SqlInput): string {
  const statementTimeoutLiteral = formatSqlLiteral(input.statementTimeout);
  const copyRangeIntervalLiteral = formatSqlLiteral(input.copyRangeInterval ?? "5 minutes");

  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = ${statementTimeoutLiteral};

DO $$
DECLARE
  selected_task fitness.metric_stream_rebuild_task%ROWTYPE;
  copy_range_start timestamptz;
  copy_range_end timestamptz;
  copied_source_row_count bigint;
  passthrough_expected_count bigint;
  passthrough_verified_count bigint;
  location_expected_count bigint;
  location_verified_count bigint;
  compressed_chunk_regclass regclass;
  source_has_external_id boolean;
  source_external_id_expression text;
BEGIN
  SELECT *
  INTO selected_task
  FROM fitness.metric_stream_rebuild_task
  WHERE completed_at IS NULL
  ORDER BY
    (COALESCE(next_range_start, range_start) > range_start) DESC,
    CASE
      WHEN COALESCE(next_range_start, range_start) > range_start
        THEN COALESCE(next_range_start, range_start)
      ELSE NULL
    END DESC,
    range_start,
    source_chunk_schema,
    source_chunk_name
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE NOTICE 'metric_stream rebuild copy skipped: no pending task';
    RETURN;
  END IF;

  copy_range_start := COALESCE(selected_task.next_range_start, selected_task.range_start);
  copy_range_end := LEAST(copy_range_start + ${copyRangeIntervalLiteral}::interval, selected_task.range_end);

  IF copy_range_start >= selected_task.range_end THEN
    UPDATE fitness.metric_stream_rebuild_task
    SET completed_at = clock_timestamp(), error_message = NULL
    WHERE id = selected_task.id;
    RAISE NOTICE 'metric_stream rebuild completed %.% with no remaining subranges',
      selected_task.source_chunk_schema,
      selected_task.source_chunk_name;
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'fitness.metric_stream'::regclass
      AND attname = 'external_id'
      AND NOT attisdropped
  )
  INTO source_has_external_id;
  source_external_id_expression := CASE
    WHEN source_has_external_id THEN 'metric_stream.external_id'
    ELSE 'NULL::text'
  END;

  DROP TABLE IF EXISTS pg_temp.metric_stream_rebuild_location_source_rows;
  DROP TABLE IF EXISTS pg_temp.metric_stream_rebuild_passthrough_source_rows;

  EXECUTE format(
    $copy$
    CREATE TEMPORARY TABLE pg_temp.metric_stream_rebuild_location_source_rows ON COMMIT DROP AS
    WITH lat_rows AS MATERIALIZED (
      SELECT
        metric_stream.id AS lat_id,
        metric_stream.recorded_at,
        metric_stream.user_id,
        metric_stream.provider_id,
        metric_stream.device_id,
        metric_stream.source_type,
        metric_stream.activity_id,
        metric_stream.scalar AS latitude,
        row_number() OVER (
          PARTITION BY metric_stream.recorded_at, metric_stream.user_id, metric_stream.provider_id,
            metric_stream.source_type, metric_stream.activity_id, metric_stream.device_id
          ORDER BY metric_stream.id
        ) AS location_sample_index
      FROM fitness.metric_stream AS metric_stream
      WHERE metric_stream.channel = 'lat'
        AND metric_stream.scalar IS NOT NULL
        AND metric_stream.recorded_at >= %L::timestamptz
        AND metric_stream.recorded_at < %L::timestamptz
    ),
    lng_rows AS MATERIALIZED (
      SELECT
        metric_stream.id AS lng_id,
        metric_stream.recorded_at,
        metric_stream.user_id,
        metric_stream.provider_id,
        metric_stream.device_id,
        metric_stream.source_type,
        metric_stream.activity_id,
        metric_stream.scalar AS longitude,
        row_number() OVER (
          PARTITION BY metric_stream.recorded_at, metric_stream.user_id, metric_stream.provider_id,
            metric_stream.source_type, metric_stream.activity_id, metric_stream.device_id
          ORDER BY metric_stream.id
        ) AS location_sample_index
      FROM fitness.metric_stream AS metric_stream
      WHERE metric_stream.channel = 'lng'
        AND metric_stream.scalar IS NOT NULL
        AND metric_stream.recorded_at >= %L::timestamptz
        AND metric_stream.recorded_at < %L::timestamptz
    ),
    gps_rows AS MATERIALIZED (
      SELECT
        metric_stream.id AS gps_id,
        metric_stream.recorded_at,
        metric_stream.user_id,
        metric_stream.provider_id,
        metric_stream.device_id,
        metric_stream.source_type,
        metric_stream.activity_id,
        metric_stream.scalar AS gps_accuracy_m,
        row_number() OVER (
          PARTITION BY metric_stream.recorded_at, metric_stream.user_id, metric_stream.provider_id,
            metric_stream.source_type, metric_stream.activity_id, metric_stream.device_id
          ORDER BY metric_stream.id
        ) AS location_sample_index
      FROM fitness.metric_stream AS metric_stream
      WHERE metric_stream.channel = 'gps_accuracy'
        AND metric_stream.scalar IS NOT NULL
        AND metric_stream.recorded_at >= %L::timestamptz
        AND metric_stream.recorded_at < %L::timestamptz
    ),
    location_rows AS MATERIALIZED (
      SELECT
        metric_stream.id AS existing_location_id,
        metric_stream.recorded_at,
        metric_stream.user_id,
        metric_stream.provider_id,
        metric_stream.device_id,
        metric_stream.source_type,
        metric_stream.activity_id,
        public.ST_Y(metric_stream.point)::real AS latitude,
        public.ST_X(metric_stream.point)::real AS longitude,
        metric_stream.metadata AS existing_location_metadata,
        row_number() OVER (
          PARTITION BY metric_stream.recorded_at, metric_stream.user_id, metric_stream.provider_id,
            metric_stream.source_type, metric_stream.activity_id, metric_stream.device_id
          ORDER BY metric_stream.id
        ) AS location_sample_index
      FROM fitness.metric_stream AS metric_stream
      WHERE metric_stream.channel = 'location'
        AND metric_stream.point IS NOT NULL
        AND metric_stream.recorded_at >= %L::timestamptz
        AND metric_stream.recorded_at < %L::timestamptz
    )
    SELECT
      lat.lat_id,
      lng.lng_id,
      gps.gps_id,
      location.existing_location_id,
      lat.recorded_at,
      lat.user_id,
      lat.provider_id,
      lat.device_id,
      lat.source_type,
      lat.activity_id,
      lat.latitude,
      lng.longitude,
      gps.gps_accuracy_m,
      location.existing_location_metadata
    FROM lat_rows AS lat
    INNER JOIN lng_rows AS lng
      ON lng.recorded_at = lat.recorded_at
     AND lng.user_id = lat.user_id
     AND lng.provider_id = lat.provider_id
     AND lng.source_type = lat.source_type
     AND lng.activity_id IS NOT DISTINCT FROM lat.activity_id
     AND lng.device_id IS NOT DISTINCT FROM lat.device_id
     AND lng.location_sample_index = lat.location_sample_index
    LEFT JOIN gps_rows AS gps
      ON gps.recorded_at = lat.recorded_at
     AND gps.user_id = lat.user_id
     AND gps.provider_id = lat.provider_id
     AND gps.source_type = lat.source_type
     AND gps.activity_id IS NOT DISTINCT FROM lat.activity_id
     AND gps.device_id IS NOT DISTINCT FROM lat.device_id
     AND gps.location_sample_index = lat.location_sample_index
    LEFT JOIN location_rows AS location
      ON location.recorded_at = lat.recorded_at
     AND location.user_id = lat.user_id
     AND location.provider_id = lat.provider_id
     AND location.source_type = lat.source_type
     AND location.activity_id IS NOT DISTINCT FROM lat.activity_id
     AND location.device_id IS NOT DISTINCT FROM lat.device_id
     AND location.location_sample_index = lat.location_sample_index
     AND location.latitude = lat.latitude
     AND location.longitude = lng.longitude
    $copy$,
    copy_range_start,
    copy_range_end,
    copy_range_start,
    copy_range_end,
    copy_range_start,
    copy_range_end,
    copy_range_start,
    copy_range_end
  );

  CREATE INDEX metric_stream_rebuild_location_source_gps_id_idx
  ON pg_temp.metric_stream_rebuild_location_source_rows (gps_id)
  WHERE gps_id IS NOT NULL;

  CREATE INDEX metric_stream_rebuild_location_source_existing_location_id_idx
  ON pg_temp.metric_stream_rebuild_location_source_rows (existing_location_id)
  WHERE existing_location_id IS NOT NULL;

  ANALYZE pg_temp.metric_stream_rebuild_location_source_rows;

  EXECUTE format(
    'SELECT count(*) FROM fitness.metric_stream AS metric_stream WHERE metric_stream.recorded_at >= %L::timestamptz AND metric_stream.recorded_at < %L::timestamptz',
    copy_range_start,
    copy_range_end
  )
  INTO copied_source_row_count;

  EXECUTE format(
    $copy$
    CREATE TEMPORARY TABLE pg_temp.metric_stream_rebuild_passthrough_source_rows ON COMMIT DROP AS
    SELECT
      metric_stream.id,
      metric_stream.recorded_at,
      metric_stream.user_id,
      metric_stream.provider_id,
      %s AS external_id,
      metric_stream.device_id,
      metric_stream.source_type,
      metric_stream.channel,
      metric_stream.activity_id,
      metric_stream.scalar,
      metric_stream.vector,
      metric_stream.point,
      metric_stream.metadata
    FROM fitness.metric_stream AS metric_stream
    WHERE metric_stream.recorded_at >= %L::timestamptz
      AND metric_stream.recorded_at < %L::timestamptz
      AND metric_stream.channel NOT IN ('lat', 'lng')
      AND NOT (
        metric_stream.channel = 'gps_accuracy'
        AND EXISTS (
          SELECT 1
          FROM pg_temp.metric_stream_rebuild_location_source_rows AS source_rows
          WHERE source_rows.gps_id = metric_stream.id
        )
      )
      AND NOT (
        metric_stream.channel = 'location'
        AND EXISTS (
          SELECT 1
          FROM pg_temp.metric_stream_rebuild_location_source_rows AS source_rows
          WHERE source_rows.existing_location_id = metric_stream.id
        )
      )
    $copy$,
    source_external_id_expression,
    copy_range_start,
    copy_range_end
  );

  ANALYZE pg_temp.metric_stream_rebuild_passthrough_source_rows;

  SELECT count(*)
  INTO passthrough_expected_count
  FROM pg_temp.metric_stream_rebuild_passthrough_source_rows;

  SELECT count(*)
  INTO location_expected_count
  FROM pg_temp.metric_stream_rebuild_location_source_rows;

  EXECUTE format(
    $copy$
    INSERT INTO fitness.metric_stream_rebuild (
      id,
      recorded_at,
      user_id,
      provider_id,
      external_id,
      device_id,
      source_type,
      channel,
      activity_id,
      scalar,
      vector,
      point,
      metadata
    )
    SELECT
      source_rows.id,
      source_rows.recorded_at,
      source_rows.user_id,
      source_rows.provider_id,
      source_rows.external_id,
      source_rows.device_id,
      source_rows.source_type,
      source_rows.channel,
      source_rows.activity_id,
      source_rows.scalar,
      source_rows.vector,
      source_rows.point,
      source_rows.metadata
    FROM pg_temp.metric_stream_rebuild_passthrough_source_rows AS source_rows
    $copy$
  );

  SELECT count(*)
  INTO passthrough_verified_count
  FROM fitness.metric_stream_rebuild AS rebuild_rows
  WHERE rebuild_rows.recorded_at >= copy_range_start
    AND rebuild_rows.recorded_at < copy_range_end
    AND EXISTS (
    SELECT 1
    FROM pg_temp.metric_stream_rebuild_passthrough_source_rows AS source_rows
    WHERE source_rows.id = rebuild_rows.id
      AND source_rows.recorded_at = rebuild_rows.recorded_at
  );

  IF passthrough_verified_count <> passthrough_expected_count THEN
    RAISE EXCEPTION 'metric_stream rebuild passthrough mismatch for %.%: expected %, verified %',
      selected_task.source_chunk_schema,
      selected_task.source_chunk_name,
      passthrough_expected_count,
      passthrough_verified_count;
  END IF;

  INSERT INTO fitness.metric_stream_rebuild (
    id,
    recorded_at,
    user_id,
    provider_id,
    external_id,
    device_id,
    source_type,
    channel,
    activity_id,
    scalar,
    vector,
    point,
    metadata
  )
  SELECT
    COALESCE(source_rows.existing_location_id, source_rows.lat_id),
    source_rows.recorded_at,
    source_rows.user_id,
    source_rows.provider_id,
    NULL,
    source_rows.device_id,
    source_rows.source_type,
    'location',
    source_rows.activity_id,
    NULL,
    NULL,
    public.ST_SetSRID(
      public.ST_MakePoint(
        source_rows.longitude::double precision,
        source_rows.latitude::double precision
      ),
      4326
    ),
    NULLIF(
      COALESCE(source_rows.existing_location_metadata, '{}'::jsonb)
        || jsonb_strip_nulls(jsonb_build_object('gps_accuracy_m', source_rows.gps_accuracy_m)),
      '{}'::jsonb
    )
  FROM pg_temp.metric_stream_rebuild_location_source_rows AS source_rows;

  SELECT count(*)
  INTO location_verified_count
  FROM fitness.metric_stream_rebuild AS rebuild_rows
  WHERE rebuild_rows.recorded_at >= copy_range_start
    AND rebuild_rows.recorded_at < copy_range_end
    AND EXISTS (
    SELECT 1
    FROM pg_temp.metric_stream_rebuild_location_source_rows AS source_rows
    WHERE COALESCE(source_rows.existing_location_id, source_rows.lat_id) = rebuild_rows.id
      AND source_rows.recorded_at = rebuild_rows.recorded_at
  );

  IF location_verified_count <> location_expected_count THEN
    RAISE EXCEPTION 'metric_stream rebuild location mismatch for %.%: expected %, verified %',
      selected_task.source_chunk_schema,
      selected_task.source_chunk_name,
      location_expected_count,
      location_verified_count;
  END IF;

  UPDATE fitness.metric_stream_rebuild_task
  SET
    source_row_count = COALESCE(source_row_count, 0) + copied_source_row_count,
    passthrough_row_count = COALESCE(passthrough_row_count, 0) + passthrough_verified_count,
    location_row_count = COALESCE(location_row_count, 0) + location_verified_count,
    next_range_start = copy_range_end,
    completed_at = CASE
      WHEN copy_range_end >= range_end THEN clock_timestamp()
      ELSE completed_at
    END,
    error_message = NULL
  WHERE id = selected_task.id;

  FOR compressed_chunk_regclass IN
    SELECT format('%I.%I', chunk_schema, chunk_name)::regclass
    FROM timescaledb_information.chunks
    WHERE hypertable_schema = 'fitness'
      AND hypertable_name = 'metric_stream_rebuild'
      AND range_start < copy_range_end
      AND range_end > copy_range_start
      AND range_end <= date_trunc('day', clock_timestamp())
    ORDER BY range_start, chunk_schema, chunk_name
  LOOP
    PERFORM public.compress_chunk(compressed_chunk_regclass, if_not_compressed => true);
  END LOOP;

  RAISE NOTICE 'metric_stream rebuild copied %.% range=[%, %) source_rows=% passthrough=% location=%',
    selected_task.source_chunk_schema,
    selected_task.source_chunk_name,
    copy_range_start,
    copy_range_end,
    copied_source_row_count,
    passthrough_verified_count,
    location_verified_count;
EXCEPTION
  WHEN OTHERS THEN
    UPDATE fitness.metric_stream_rebuild_task
    SET error_message = SQLERRM
    WHERE id = selected_task.id;
    RAISE;
END;
$$;

COMMIT;`;
}

export function buildStatusSql(): string {
  return `SELECT
  count(*)::bigint AS total_tasks,
  count(*) FILTER (WHERE completed_at IS NOT NULL)::bigint AS completed_tasks,
  count(*) FILTER (WHERE completed_at IS NULL)::bigint AS pending_tasks,
  round(
    100 * count(*) FILTER (WHERE completed_at IS NOT NULL)::numeric / NULLIF(count(*), 0),
    2
  ) AS percent_done,
  (
    SELECT total_bytes
    FROM public.hypertable_detailed_size('fitness.metric_stream'::regclass)
  ) AS source_size_bytes,
  CASE
    WHEN to_regclass('fitness.metric_stream_rebuild') IS NULL THEN NULL
    ELSE (
      SELECT total_bytes
      FROM public.hypertable_detailed_size('fitness.metric_stream_rebuild'::regclass)
    )
  END AS rebuild_size_bytes
FROM fitness.metric_stream_rebuild_task;`;
}

export function parseCliOptions(args: string[]): CliOptions {
  let prepare = false;
  let copy = false;
  let status = false;
  let execute = false;
  let maxTasks = 1;
  let sshHost = "dofek-server";
  let statementTimeout = "30min";
  let copyRangeInterval = "5 minutes";

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];

    switch (argument) {
      case "--prepare":
        prepare = true;
        break;
      case "--copy":
        copy = true;
        break;
      case "--status":
        status = true;
        break;
      case "--execute":
        execute = true;
        break;
      case "--max-tasks":
        maxTasks = parsePositiveInteger(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      case "--ssh-host":
        sshHost = readOptionValue(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      case "--statement-timeout":
        statementTimeout = readOptionValue(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      case "--slice-interval":
        copyRangeInterval = parseCopyRangeInterval(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!prepare && !copy && !status) {
    status = true;
  }

  return {
    prepare,
    copy,
    status,
    execute,
    dryRun: !execute,
    maxTasks,
    sshHost,
    statementTimeout,
    copyRangeInterval,
  };
}

function runRemoteSql(sql: string, sshHost: string): Promise<SpawnResult> {
  const remoteCommand = [
    "set -euo pipefail",
    'container_name=$(docker ps --filter label=com.docker.swarm.service.name=dofek_db --format "{{.Names}}" | head -1)',
    'test -n "$container_name"',
    'docker exec -i "$container_name" sh -lc \'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U health -d health -P pager=off -v ON_ERROR_STOP=1 -f -\'',
  ].join("; ");

  return new Promise((resolve, reject) => {
    const childProcess = spawn("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      sshHost,
      remoteCommand,
    ]);

    childProcess.stdout.pipe(process.stdout);
    childProcess.stderr.pipe(process.stderr);
    childProcess.stdin.end(sql);

    childProcess.on("error", reject);
    childProcess.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}

async function executeSql(sql: string, options: CliOptions): Promise<void> {
  if (options.dryRun) {
    console.log(sql);
    return;
  }

  const result = await runRemoteSql(sql, options.sshHost);
  if (result.exitCode !== 0) {
    throw new Error(
      `remote SQL failed with exit code ${String(result.exitCode)} signal ${String(result.signal)}`,
    );
  }
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  if (options.prepare) {
    await executeSql(buildPrepareSql({ statementTimeout: options.statementTimeout }), options);
  }

  if (options.copy) {
    for (let taskIndex = 0; taskIndex < options.maxTasks; taskIndex += 1) {
      await executeSql(
        buildCopyTaskSql({
          copyRangeInterval: options.copyRangeInterval,
          statementTimeout: options.statementTimeout,
        }),
        options,
      );
    }
  }

  if (options.status) {
    await executeSql(buildStatusSql(), options);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[rebuild-metric-stream-location] ${error}`);
    process.exit(1);
  });
}
