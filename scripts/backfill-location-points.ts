import { spawn } from "node:child_process";
import { z } from "zod";

export type DateWindow = {
  startDate: string;
  endDate: string;
};

export type BuildWindowsInput = {
  startDate: string;
  endDate: string;
  windowDays: number;
};

export type BackfillSqlInput = {
  startDate: string;
  endDate: string;
  statementTimeout: string;
  recompress: boolean;
};

export type CliOptions = {
  startDate: string;
  endDate: string;
  windowDays: number;
  maxWindows: number;
  sshHost: string;
  statementTimeout: string;
  recompress: boolean;
  execute: boolean;
  dryRun: boolean;
};

type SpawnResult = {
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

export function formatSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseDate(dateValue: string): Date {
  const validDateValue = dateStringSchema.parse(dateValue);
  return new Date(`${validDateValue}T00:00:00.000Z`);
}

function formatDate(dateValue: Date): string {
  return dateValue.toISOString().slice(0, 10);
}

function addDays(dateValue: Date, days: number): Date {
  const nextDate = new Date(dateValue);
  nextDate.setUTCDate(nextDate.getUTCDate() + days);
  return nextDate;
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function buildWindows(input: BuildWindowsInput): DateWindow[] {
  requirePositiveInteger("windowDays", input.windowDays);

  const endDate = parseDate(input.endDate);
  let currentStartDate = parseDate(input.startDate);
  const windows: DateWindow[] = [];

  if (currentStartDate >= endDate) {
    throw new Error("start date must be before end date");
  }

  while (currentStartDate < endDate) {
    const nextEndDate = addDays(currentStartDate, input.windowDays);
    const currentEndDate = nextEndDate < endDate ? nextEndDate : endDate;

    windows.push({
      startDate: formatDate(currentStartDate),
      endDate: formatDate(currentEndDate),
    });

    currentStartDate = currentEndDate;
  }

  return windows;
}

export function buildBackfillSql(input: BackfillSqlInput): string {
  const startDateLiteral = formatSqlLiteral(input.startDate);
  const endDateLiteral = formatSqlLiteral(input.endDate);
  const statementTimeoutLiteral = formatSqlLiteral(input.statementTimeout);

  const recompressSql = input.recompress
    ? `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = ${statementTimeoutLiteral};

SELECT compress_chunk(chunk_regclass, if_not_compressed => true)::text
FROM pg_temp.location_backfill_chunks;

COMMIT;`
    : "";

  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = ${statementTimeoutLiteral};

CREATE TEMPORARY TABLE pg_temp.location_backfill_chunks ON COMMIT PRESERVE ROWS AS
SELECT format('%I.%I', chunk_schema, chunk_name)::regclass AS chunk_regclass
FROM timescaledb_information.chunks
WHERE hypertable_schema = 'fitness'
  AND hypertable_name = 'metric_stream'
  AND is_compressed
  AND range_start < ${endDateLiteral}::timestamptz
  AND range_end > ${startDateLiteral}::timestamptz;

SELECT decompress_chunk(chunk_regclass, if_compressed => true)::text
FROM pg_temp.location_backfill_chunks;

COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = ${statementTimeoutLiteral};

DROP TABLE IF EXISTS pg_temp.location_source_rows;
DROP TABLE IF EXISTS pg_temp.existing_location_rows;

CREATE TEMPORARY TABLE pg_temp.location_source_rows ON COMMIT DROP AS
WITH lat_rows AS MATERIALIZED (
  SELECT
    recorded_at,
    user_id,
    provider_id,
    device_id,
    source_type,
    activity_id,
    scalar AS latitude,
    row_number() OVER (
      PARTITION BY recorded_at, user_id, provider_id, source_type, activity_id, device_id
      ORDER BY tableoid::text, ctid
    ) AS location_sample_index
  FROM fitness.metric_stream
  WHERE channel = 'lat'
    AND scalar IS NOT NULL
    AND recorded_at >= ${startDateLiteral}::timestamptz
    AND recorded_at < ${endDateLiteral}::timestamptz
),
lng_rows AS MATERIALIZED (
  SELECT
    recorded_at,
    user_id,
    provider_id,
    device_id,
    source_type,
    activity_id,
    scalar AS longitude,
    row_number() OVER (
      PARTITION BY recorded_at, user_id, provider_id, source_type, activity_id, device_id
      ORDER BY tableoid::text, ctid
    ) AS location_sample_index
  FROM fitness.metric_stream
  WHERE channel = 'lng'
    AND scalar IS NOT NULL
    AND recorded_at >= ${startDateLiteral}::timestamptz
    AND recorded_at < ${endDateLiteral}::timestamptz
),
gps_rows AS MATERIALIZED (
  SELECT
    recorded_at,
    user_id,
    provider_id,
    device_id,
    source_type,
    activity_id,
    scalar AS gps_accuracy_m,
    row_number() OVER (
      PARTITION BY recorded_at, user_id, provider_id, source_type, activity_id, device_id
      ORDER BY tableoid::text, ctid
    ) AS location_sample_index
  FROM fitness.metric_stream
  WHERE channel = 'gps_accuracy'
    AND scalar IS NOT NULL
    AND recorded_at >= ${startDateLiteral}::timestamptz
    AND recorded_at < ${endDateLiteral}::timestamptz
),
source_rows AS MATERIALIZED (
  SELECT
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
   AND gps.location_sample_index = lat.location_sample_index
)
SELECT *
FROM source_rows;

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
FROM fitness.metric_stream
WHERE channel = 'location'
  AND point IS NOT NULL
  AND recorded_at >= ${startDateLiteral}::timestamptz
  AND recorded_at < ${endDateLiteral}::timestamptz;

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
FROM inserted_location_rows;

COMMIT;${recompressSql}
`;
}

function readOptionValue(args: string[], optionIndex: number, optionName: string): string {
  const value = args[optionIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }

  return value;
}

function parseIntegerOption(args: string[], optionIndex: number, optionName: string): number {
  const value = Number.parseInt(readOptionValue(args, optionIndex, optionName), 10);
  requirePositiveInteger(optionName, value);
  return value;
}

export function parseCliOptions(args: string[]): CliOptions {
  let startDate: string | undefined;
  let endDate: string | undefined;
  let windowDays = 1;
  let maxWindows = 1;
  let sshHost = "dofek-server";
  let statementTimeout = "15min";
  let recompress = false;
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
      case "--window-days":
        windowDays = parseIntegerOption(args, argumentIndex, argument);
        argumentIndex += 1;
        break;
      case "--max-windows":
        maxWindows = parseIntegerOption(args, argumentIndex, argument);
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
      case "--no-recompress":
        recompress = false;
        break;
      case "--recompress":
        recompress = true;
        break;
      case "--execute":
        execute = true;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (startDate === undefined) {
    throw new Error("--start is required");
  }
  if (endDate === undefined) {
    throw new Error("--end is required");
  }

  parseDate(startDate);
  parseDate(endDate);
  requirePositiveInteger("windowDays", windowDays);
  requirePositiveInteger("maxWindows", maxWindows);

  return {
    startDate,
    endDate,
    windowDays,
    maxWindows,
    sshHost,
    statementTimeout,
    recompress,
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

    childProcess.stdout.pipe(process.stdout);
    childProcess.stderr.pipe(process.stderr);
    childProcess.stdin.end(sql);

    childProcess.on("error", reject);
    childProcess.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
}

export async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const plannedWindows = buildWindows(options).slice(0, options.maxWindows);

  console.log(
    `[backfill-location] planned ${plannedWindows.length} window(s), execute=${String(options.execute)}`,
  );

  for (const dateWindow of plannedWindows) {
    const sql = buildBackfillSql({
      startDate: dateWindow.startDate,
      endDate: dateWindow.endDate,
      statementTimeout: options.statementTimeout,
      recompress: options.recompress,
    });

    console.log(`[backfill-location] window ${dateWindow.startDate}..${dateWindow.endDate}`);

    if (options.dryRun) {
      console.log(sql);
      continue;
    }

    const result = await runRemoteSql(sql, options.sshHost);
    if (result.exitCode !== 0) {
      throw new Error(
        `remote psql failed for ${dateWindow.startDate}..${dateWindow.endDate} with exit code ${String(
          result.exitCode,
        )} signal ${String(result.signal)}`,
      );
    }
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[backfill-location] ${error}`);
    process.exit(1);
  });
}
