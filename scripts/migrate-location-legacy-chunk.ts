import { spawn } from "node:child_process";
import { z } from "zod";
import { formatSqlLiteral } from "./backfill-location-points.ts";

export type ChunkListSqlInput = {
  startDate: string;
  endDate: string;
};

export type ChunkMigrationSqlInput = {
  chunkSchema: string;
  chunkName: string;
  statementTimeout: string;
  write: boolean;
  recompress: boolean;
};

export type CliOptions = {
  startDate?: string;
  endDate?: string;
  chunkSchema?: string;
  chunkName?: string;
  maxChunks: number;
  sshHost: string;
  statementTimeout: string;
  recompress: boolean;
  write: boolean;
  execute: boolean;
  dryRun: boolean;
};

type ChunkRow = {
  chunkSchema: string;
  chunkName: string;
};

type SpawnResult = {
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const dateStringSchema = z
  .string()
  .regex(datePattern, "Expected YYYY-MM-DD date")
  .refine((dateValue) => {
    const [yearText, monthText, dayText] = dateValue.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const parsedDate = new Date(Date.UTC(year, month - 1, day));
    return (
      parsedDate.getUTCFullYear() === year &&
      parsedDate.getUTCMonth() === month - 1 &&
      parsedDate.getUTCDate() === day
    );
  }, "Invalid YYYY-MM-DD date");

function parseDate(dateValue: string): void {
  dateStringSchema.parse(dateValue);
}

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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function qualifiedChunkIdentifier(chunkSchema: string, chunkName: string): string {
  return `${quoteIdentifier(chunkSchema)}.${quoteIdentifier(chunkName)}`;
}

export function buildChunkListSql(input: ChunkListSqlInput): string {
  const startDateLiteral = formatSqlLiteral(input.startDate);
  const endDateLiteral = formatSqlLiteral(input.endDate);

  return `SELECT chunk_schema || '.' || chunk_name
FROM timescaledb_information.chunks
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream'
  AND range_start < ${endDateLiteral}::timestamptz
  AND range_end > ${startDateLiteral}::timestamptz
ORDER BY range_start, chunk_schema, chunk_name;`;
}

export function buildChunkMigrationSql(input: ChunkMigrationSqlInput): string {
  const statementTimeoutLiteral = formatSqlLiteral(input.statementTimeout);
  const chunkIdentifier = qualifiedChunkIdentifier(input.chunkSchema, input.chunkName);
  const chunkRegclassLiteral = formatSqlLiteral(chunkIdentifier);
  const insertMissingSql = input.write
    ? `
WITH inserted_location_rows AS (
  INSERT INTO fitness.metric_stream (
    recorded_at,
    user_id,
    provider_id,
    device_id,
    source_type,
    channel,
    activity_id,
    point,
    metadata
  )
  SELECT
    source_rows.recorded_at,
    source_rows.user_id,
    source_rows.provider_id,
    source_rows.device_id,
    source_rows.source_type,
    'location',
    source_rows.activity_id,
    public.ST_SetSRID(
      public.ST_MakePoint(
        source_rows.longitude::double precision,
        source_rows.latitude::double precision
      ),
      4326
    ),
    NULLIF(
      jsonb_strip_nulls(jsonb_build_object('gps_accuracy_m', source_rows.gps_accuracy_m)),
      '{}'::jsonb
    )
  FROM pg_temp.location_source_rows AS source_rows
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_temp.existing_location_rows AS location
    WHERE location.recorded_at = source_rows.recorded_at
      AND location.user_id = source_rows.user_id
      AND location.provider_id = source_rows.provider_id
      AND location.source_type = source_rows.source_type
      AND COALESCE(location.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(source_rows.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND COALESCE(location.device_id, '__NULL_DEVICE__')
        = COALESCE(source_rows.device_id, '__NULL_DEVICE__')
      AND location.latitude = source_rows.latitude
      AND location.longitude = source_rows.longitude
  )
  RETURNING 1
)
SELECT 'inserted_location_rows=' || count(*)::text
FROM inserted_location_rows;`
    : "SELECT 'inserted_location_rows=0';";

  const deleteLegacySql = input.write
    ? `
WITH missing_after AS (
  SELECT count(*) AS count
  FROM pg_temp.location_source_rows AS source_rows
  WHERE NOT EXISTS (
    SELECT 1
    FROM ONLY ${chunkIdentifier} AS location
    WHERE location.channel = 'location'
      AND location.point IS NOT NULL
      AND location.recorded_at = source_rows.recorded_at
      AND location.user_id = source_rows.user_id
      AND location.provider_id = source_rows.provider_id
      AND location.source_type = source_rows.source_type
      AND COALESCE(location.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = COALESCE(source_rows.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
      AND COALESCE(location.device_id, '__NULL_DEVICE__')
        = COALESCE(source_rows.device_id, '__NULL_DEVICE__')
      AND public.ST_Y(location.point)::real = source_rows.latitude
      AND public.ST_X(location.point)::real = source_rows.longitude
  )
),
represented_source_rows AS (
  SELECT source_rows.*
  FROM pg_temp.location_source_rows AS source_rows
  WHERE (SELECT count FROM missing_after) = 0
    AND EXISTS (
      SELECT 1
      FROM ONLY ${chunkIdentifier} AS location
      WHERE location.channel = 'location'
        AND location.point IS NOT NULL
        AND location.recorded_at = source_rows.recorded_at
        AND location.user_id = source_rows.user_id
        AND location.provider_id = source_rows.provider_id
        AND location.source_type = source_rows.source_type
        AND COALESCE(location.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(source_rows.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND COALESCE(location.device_id, '__NULL_DEVICE__')
          = COALESCE(source_rows.device_id, '__NULL_DEVICE__')
        AND public.ST_Y(location.point)::real = source_rows.latitude
        AND public.ST_X(location.point)::real = source_rows.longitude
    )
),
metadata_represented_gps_rows AS (
  SELECT source_rows.gps_ctid
  FROM represented_source_rows AS source_rows
  WHERE source_rows.gps_ctid IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM ONLY ${chunkIdentifier} AS location
      WHERE location.channel = 'location'
        AND location.point IS NOT NULL
        AND location.recorded_at = source_rows.recorded_at
        AND location.user_id = source_rows.user_id
        AND location.provider_id = source_rows.provider_id
        AND location.source_type = source_rows.source_type
        AND COALESCE(location.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE(source_rows.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND COALESCE(location.device_id, '__NULL_DEVICE__')
          = COALESCE(source_rows.device_id, '__NULL_DEVICE__')
        AND public.ST_Y(location.point)::real = source_rows.latitude
        AND public.ST_X(location.point)::real = source_rows.longitude
        AND (location.metadata ->> 'gps_accuracy_m')::real = source_rows.gps_accuracy_m
    )
),
deleted_coordinate_rows AS (
  DELETE FROM ONLY ${chunkIdentifier} AS metric_stream
  WHERE metric_stream.channel IN ('lat', 'lng')
    AND (
      metric_stream.ctid IN (SELECT lat_ctid FROM represented_source_rows)
      OR metric_stream.ctid IN (SELECT lng_ctid FROM represented_source_rows)
    )
  RETURNING 1
),
deleted_gps_rows AS (
  DELETE FROM ONLY ${chunkIdentifier} AS metric_stream
  WHERE metric_stream.channel = 'gps_accuracy'
    AND metric_stream.ctid IN (SELECT gps_ctid FROM metadata_represented_gps_rows)
  RETURNING 1
)
SELECT
  'exact_missing_after=' || (SELECT count FROM missing_after)::text
  || '|deleted_coordinate_rows=' || (SELECT count(*) FROM deleted_coordinate_rows)::text
  || '|deleted_gps_rows=' || (SELECT count(*) FROM deleted_gps_rows)::text;`
    : "SELECT 'exact_missing_after=' || (SELECT count(*) FROM pg_temp.missing_location_rows)::text || '|deleted_coordinate_rows=0|deleted_gps_rows=0';";

  const decompressSql = input.write
    ? `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = ${statementTimeoutLiteral};

SELECT decompress_chunk(${chunkRegclassLiteral}::regclass, if_compressed => true)::text;

COMMIT;`
    : "";

  const recompressSql =
    input.write && input.recompress
      ? `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = ${statementTimeoutLiteral};

SELECT compress_chunk(${chunkRegclassLiteral}::regclass, if_not_compressed => true)::text;

COMMIT;`
      : "";

  return `${decompressSql}
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = ${statementTimeoutLiteral};

DROP TABLE IF EXISTS pg_temp.location_source_rows;
DROP TABLE IF EXISTS pg_temp.existing_location_rows;
DROP TABLE IF EXISTS pg_temp.missing_location_rows;

CREATE TEMPORARY TABLE pg_temp.location_source_rows ON COMMIT DROP AS
WITH lat_rows AS MATERIALIZED (
  SELECT
    ctid AS lat_ctid,
    recorded_at,
    user_id,
    provider_id,
    device_id,
    source_type,
    activity_id,
    scalar AS latitude,
    row_number() OVER (
      PARTITION BY recorded_at, user_id, provider_id, source_type, activity_id, device_id
      ORDER BY ctid
    ) AS location_sample_index
  FROM ONLY ${chunkIdentifier}
  WHERE channel = 'lat'
    AND scalar IS NOT NULL
),
lng_rows AS MATERIALIZED (
  SELECT
    ctid AS lng_ctid,
    recorded_at,
    user_id,
    provider_id,
    device_id,
    source_type,
    activity_id,
    scalar AS longitude,
    row_number() OVER (
      PARTITION BY recorded_at, user_id, provider_id, source_type, activity_id, device_id
      ORDER BY ctid
    ) AS location_sample_index
  FROM ONLY ${chunkIdentifier}
  WHERE channel = 'lng'
    AND scalar IS NOT NULL
),
gps_rows AS MATERIALIZED (
  SELECT
    ctid AS gps_ctid,
    recorded_at,
    user_id,
    provider_id,
    device_id,
    source_type,
    activity_id,
    scalar AS gps_accuracy_m,
    row_number() OVER (
      PARTITION BY recorded_at, user_id, provider_id, source_type, activity_id, device_id
      ORDER BY ctid
    ) AS location_sample_index
  FROM ONLY ${chunkIdentifier}
  WHERE channel = 'gps_accuracy'
    AND scalar IS NOT NULL
)
SELECT
  lat.lat_ctid,
  lng.lng_ctid,
  gps.gps_ctid,
  lat.recorded_at,
  lat.user_id,
  lat.provider_id,
  lat.device_id,
  lat.source_type,
  lat.activity_id,
  lat.latitude,
  lng.longitude,
  gps.gps_accuracy_m
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
 AND gps.location_sample_index = lat.location_sample_index;

CREATE TEMPORARY TABLE pg_temp.existing_location_rows ON COMMIT DROP AS
SELECT
  recorded_at,
  user_id,
  provider_id,
  device_id,
  source_type,
  activity_id,
  public.ST_Y(point)::real AS latitude,
  public.ST_X(point)::real AS longitude
FROM ONLY ${chunkIdentifier}
WHERE channel = 'location'
  AND point IS NOT NULL;

CREATE INDEX existing_location_rows_lookup_idx
ON pg_temp.existing_location_rows (
  recorded_at,
  user_id,
  provider_id,
  source_type,
  COALESCE(activity_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(device_id, '__NULL_DEVICE__'),
  latitude,
  longitude
);

ANALYZE pg_temp.location_source_rows;
ANALYZE pg_temp.existing_location_rows;

CREATE TEMPORARY TABLE pg_temp.missing_location_rows ON COMMIT DROP AS
SELECT source_rows.*
FROM pg_temp.location_source_rows AS source_rows
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_temp.existing_location_rows AS location
  WHERE location.recorded_at = source_rows.recorded_at
    AND location.user_id = source_rows.user_id
    AND location.provider_id = source_rows.provider_id
    AND location.source_type = source_rows.source_type
    AND COALESCE(location.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = COALESCE(source_rows.activity_id, '00000000-0000-0000-0000-000000000000'::uuid)
    AND COALESCE(location.device_id, '__NULL_DEVICE__')
      = COALESCE(source_rows.device_id, '__NULL_DEVICE__')
    AND location.latitude = source_rows.latitude
    AND location.longitude = source_rows.longitude
);

SELECT
  'chunk=${input.chunkSchema}.${input.chunkName}'
  || '|source_pairs=' || (SELECT count(*) FROM pg_temp.location_source_rows)::text
  || '|existing_location_rows=' || (SELECT count(*) FROM pg_temp.existing_location_rows)::text
  || '|exact_missing_before=' || (SELECT count(*) FROM pg_temp.missing_location_rows)::text;

${insertMissingSql}

${deleteLegacySql}

COMMIT;${recompressSql}
`;
}

export function parseCliOptions(args: string[]): CliOptions {
  let startDate: string | undefined;
  let endDate: string | undefined;
  let optionsChunkSchema: string | undefined;
  let optionsChunkName: string | undefined;
  let maxChunks = 1;
  let sshHost = "dofek-server";
  let statementTimeout = "15min";
  let recompress = false;
  let write = false;
  let execute = false;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];

    switch (argument) {
      case "--start":
        startDate = readOptionValue(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      case "--end":
        endDate = readOptionValue(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      case "--chunk-schema":
        optionsChunkSchema = readOptionValue(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      case "--chunk-name":
        optionsChunkName = readOptionValue(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      case "--max-chunks":
        maxChunks = parsePositiveInteger(args, argumentIndex, argument);
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
      case "--recompress":
        recompress = true;
        break;
      case "--no-recompress":
        recompress = false;
        break;
      case "--write":
        write = true;
        break;
      case "--execute":
        execute = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  const hasChunkTarget = optionsChunkSchema !== undefined || optionsChunkName !== undefined;
  if (hasChunkTarget) {
    if (optionsChunkSchema === undefined || optionsChunkName === undefined) {
      throw new Error("--chunk-schema and --chunk-name must be provided together");
    }
  } else {
    if (startDate === undefined) {
      throw new Error("--start is required");
    }
    if (endDate === undefined) {
      throw new Error("--end is required");
    }
  }

  if (startDate !== undefined) {
    parseDate(startDate);
  }
  if (endDate !== undefined) {
    parseDate(endDate);
  }

  return {
    startDate,
    endDate,
    chunkSchema: optionsChunkSchema,
    chunkName: optionsChunkName,
    maxChunks,
    sshHost,
    statementTimeout,
    recompress,
    write,
    execute,
    dryRun: !execute,
  };
}

function runRemoteSql(sql: string, sshHost: string): Promise<SpawnResult> {
  const remoteCommand = [
    "set -euo pipefail",
    'container_name=$(docker ps --filter label=com.docker.swarm.service.name=dofek_db --format "{{.Names}}" | head -1)',
    'test -n "$container_name"',
    'docker exec -i "$container_name" sh -lc \'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U health -d health -P pager=off -v ON_ERROR_STOP=1 -At -f -\'',
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
    const stdoutChunks: Buffer[] = [];

    childProcess.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdoutChunks.push(chunk);
    });
    childProcess.stderr.pipe(process.stderr);
    childProcess.stdin.end(sql);

    childProcess.on("error", reject);
    childProcess.on("close", (exitCode, signal) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        exitCode,
        signal,
      });
    });
  });
}

function parseChunkRows(stdout: string): ChunkRow[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf(".");
      if (separatorIndex === -1) {
        throw new Error(`Invalid chunk row: ${line}`);
      }
      return {
        chunkSchema: line.slice(0, separatorIndex),
        chunkName: line.slice(separatorIndex + 1),
      };
    });
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const chunks =
    options.chunkSchema !== undefined && options.chunkName !== undefined
      ? [{ chunkSchema: options.chunkSchema, chunkName: options.chunkName }]
      : undefined;

  if (options.dryRun) {
    if (chunks !== undefined) {
      console.log(`${chunks[0].chunkSchema}.${chunks[0].chunkName}`);
    } else if (options.startDate !== undefined && options.endDate !== undefined) {
      console.log(
        buildChunkListSql({
          startDate: options.startDate,
          endDate: options.endDate,
        }),
      );
    }
    return;
  }

  const selectedChunks =
    chunks ??
    (await (async (): Promise<ChunkRow[]> => {
      if (options.startDate === undefined || options.endDate === undefined) {
        throw new Error("--start and --end are required unless targeting a chunk directly");
      }
      const chunkListResult = await runRemoteSql(
        buildChunkListSql({
          startDate: options.startDate,
          endDate: options.endDate,
        }),
        options.sshHost,
      );
      if (chunkListResult.exitCode !== 0) {
        throw new Error(
          `remote chunk list failed with exit code ${String(chunkListResult.exitCode)}`,
        );
      }
      return parseChunkRows(chunkListResult.stdout).slice(0, options.maxChunks);
    })());
  console.log(`[migrate-location-legacy-chunk] planned ${selectedChunks.length} chunk(s)`);

  for (const chunk of selectedChunks) {
    console.log(`[migrate-location-legacy-chunk] chunk ${chunk.chunkSchema}.${chunk.chunkName}`);
    const migrationSql = buildChunkMigrationSql({
      chunkSchema: chunk.chunkSchema,
      chunkName: chunk.chunkName,
      statementTimeout: options.statementTimeout,
      write: options.write,
      recompress: options.recompress,
    });
    const migrationResult = await runRemoteSql(migrationSql, options.sshHost);
    if (migrationResult.exitCode !== 0) {
      throw new Error(
        `remote chunk migration failed for ${chunk.chunkSchema}.${chunk.chunkName} with exit code ${String(
          migrationResult.exitCode,
        )} signal ${String(migrationResult.signal)}`,
      );
    }
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[migrate-location-legacy-chunk] ${error}`);
    process.exit(1);
  });
}
