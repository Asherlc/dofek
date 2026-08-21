import * as Sentry from "@sentry/node";
import {
  type ClickHouseCommandClient,
  createClickHouseClientFromEnv,
  parsePostgresConnectionForClickHouse,
  waitForClickHouseTable,
} from "../src/db/clickhouse.ts";
import {
  clickHouseDateTimeLiteral,
  clickHouseStringLiteral,
  parsePostgresTimestamp,
} from "../src/db/clickhouse-migrations/sql.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import { INGEST_DATABASE, METRIC_STREAM_TABLE } from "../src/metric-stream/clickhouse-table.ts";

export interface MetricStreamCatchUpOptions {
  start: Date;
  end: Date;
  windowMinutes: number;
  maxWindows: number;
  execute: boolean;
}

export interface MetricStreamCatchUpWindow {
  start: Date;
  end: Date;
}

interface BuildMetricStreamCatchUpStatementOptions {
  postgresConnectionString: string;
  start: Date;
  end: Date;
}

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MAX_WINDOWS = 48;
const CLICKHOUSE_REQUEST_TIMEOUT_MILLISECONDS = 300_000;

function readOptionValue(
  args: readonly string[],
  argumentIndex: number,
  optionName: string,
): string {
  const value = args[argumentIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, optionName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

export function buildMetricStreamCatchUpWindows(options: {
  start: Date;
  end: Date;
  windowMinutes: number;
}): MetricStreamCatchUpWindow[] {
  const windows: MetricStreamCatchUpWindow[] = [];
  const windowMilliseconds = options.windowMinutes * 60 * 1000;
  let currentStart = options.start;

  while (currentStart.getTime() < options.end.getTime()) {
    const nextEndMilliseconds = Math.min(
      currentStart.getTime() + windowMilliseconds,
      options.end.getTime(),
    );
    const currentEnd = new Date(nextEndMilliseconds);
    windows.push({ start: currentStart, end: currentEnd });
    currentStart = currentEnd;
  }

  return windows;
}

export function parseMetricStreamCatchUpOptions(
  args: readonly string[],
): MetricStreamCatchUpOptions {
  let startValue: string | undefined;
  let endValue: string | undefined;
  let windowMinutes = DEFAULT_WINDOW_MINUTES;
  let maxWindows = DEFAULT_MAX_WINDOWS;
  let execute = false;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];
    switch (argument) {
      case "--start":
        startValue = readOptionValue(args, argumentIndex, "--start");
        argumentIndex += 1;
        break;
      case "--end":
        endValue = readOptionValue(args, argumentIndex, "--end");
        argumentIndex += 1;
        break;
      case "--window-minutes":
        windowMinutes = parsePositiveInteger(
          readOptionValue(args, argumentIndex, "--window-minutes"),
          "--window-minutes",
        );
        argumentIndex += 1;
        break;
      case "--max-windows":
        maxWindows = parsePositiveInteger(
          readOptionValue(args, argumentIndex, "--max-windows"),
          "--max-windows",
        );
        argumentIndex += 1;
        break;
      case "--execute":
        execute = true;
        break;
      case "--":
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!startValue) {
    throw new Error("--start is required");
  }
  if (!endValue) {
    throw new Error("--end is required");
  }

  const start = parsePostgresTimestamp(startValue, "--start");
  const end = parsePostgresTimestamp(endValue, "--end");
  if (start.getTime() >= end.getTime()) {
    throw new Error("--start must be before --end");
  }

  const windows = buildMetricStreamCatchUpWindows({ start, end, windowMinutes });
  if (windows.length > maxWindows) {
    throw new Error(
      `Metric-stream catch-up requires ${windows.length} windows, above --max-windows ${maxWindows}`,
    );
  }

  return {
    end,
    execute,
    maxWindows,
    start,
    windowMinutes,
  };
}

function buildPostgresMetricStreamTableFunction(postgresConnectionString: string): string {
  const postgres = parsePostgresConnectionForClickHouse(postgresConnectionString);
  return `postgresql(${clickHouseStringLiteral(postgres.hostAndPort)}, ${clickHouseStringLiteral(
    postgres.database,
  )}, 'metric_stream', ${clickHouseStringLiteral(postgres.user)}, ${clickHouseStringLiteral(
    postgres.password,
  )}, 'fitness')`;
}

export function buildMetricStreamCatchUpStatement(
  options: BuildMetricStreamCatchUpStatementOptions,
): string {
  const lowerBound = clickHouseDateTimeLiteral(options.start);
  const upperBound = clickHouseDateTimeLiteral(options.end);
  const postgresMetricStreamSource = buildPostgresMetricStreamTableFunction(
    options.postgresConnectionString,
  );

  return `INSERT INTO ${METRIC_STREAM_TABLE} (
  recorded_at,
  user_id,
  provider_id,
  external_id,
  device_id,
  source_type,
  channel,
  activity_id,
  scalar,
  point,
  id,
  ingested_at,
  is_deleted,
  version
)
SELECT
  metric_stream.recorded_at,
  metric_stream.user_id,
  metric_stream.provider_id,
  metric_stream.external_id,
  metric_stream.device_id,
  metric_stream.source_type,
  metric_stream.channel,
  metric_stream.activity_id,
  metric_stream.scalar,
  if(
    isNull(metric_stream.point) OR assumeNotNull(metric_stream.point) = '',
    NULL,
    (
      SELECT concat(
        '{"type":"Point","coordinates":[',
        toString(point_value.1), ',', toString(point_value.2), ']}'
      )
      FROM (
        SELECT readWKBPoint(
          unhex(
            if(
              isNull(metric_stream.point) OR assumeNotNull(metric_stream.point) = '',
              '010100000000000000000000000000000000000000',
              if(
                startsWith(lower(assumeNotNull(metric_stream.point)), '0101000020'),
                concat(
                  substring(assumeNotNull(metric_stream.point), 1, 2),
                  '01000000',
                  substring(assumeNotNull(metric_stream.point), 19)
                ),
                assumeNotNull(metric_stream.point)
              )
            )
          )
        ) AS point_value
      )
    )
  ) AS point,
  metric_stream.id,
  now64(9) AS ingested_at,
  0 AS is_deleted,
  toInt64(toUnixTimestamp64Milli(now64(3))) AS version
FROM (
  SELECT
    metric_stream.recorded_at,
    metric_stream.user_id,
    metric_stream.provider_id,
    metric_stream.external_id,
    metric_stream.device_id,
    metric_stream.source_type,
    metric_stream.channel,
    metric_stream.activity_id,
    metric_stream.scalar,
    metric_stream.point,
    metric_stream.id
  FROM ${postgresMetricStreamSource} AS metric_stream
  WHERE metric_stream.recorded_at >= ${lowerBound}
    AND metric_stream.recorded_at < ${upperBound}
    AND metric_stream.channel != 'imu'
) AS metric_stream
LEFT ANY JOIN (
  SELECT CAST(id, 'Nullable(UUID)') AS id
  FROM ${METRIC_STREAM_TABLE} FINAL
  WHERE recorded_at >= ${lowerBound}
    AND recorded_at < ${upperBound}
) AS existing_metric_stream
  ON existing_metric_stream.id = metric_stream.id
WHERE existing_metric_stream.id IS NULL`;
}

function requireEnvironmentVariable(environmentVariableName: string): string {
  const value = process.env[environmentVariableName];
  if (!value) {
    throw new Error(`${environmentVariableName} is required`);
  }
  return value;
}

async function runMetricStreamCatchUp(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
  options: MetricStreamCatchUpOptions,
): Promise<void> {
  const windows = buildMetricStreamCatchUpWindows(options);
  await waitForClickHouseTable(client, INGEST_DATABASE, "metric_stream");

  for (const window of windows) {
    console.log(
      `[metric-stream-catch-up] inserting ${window.start.toISOString()} through ${window.end.toISOString()}`,
    );
    await client.command({
      query: buildMetricStreamCatchUpStatement({
        end: window.end,
        postgresConnectionString,
        start: window.start,
      }),
      clickhouse_settings: {
        wait_end_of_query: 1,
      },
    });
  }
}

function initializeSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  initializeSentry();

  const options = parseMetricStreamCatchUpOptions(args);
  const windows = buildMetricStreamCatchUpWindows(options);
  console.log(
    `[metric-stream-catch-up] planned ${windows.length} windows from ${options.start.toISOString()} through ${options.end.toISOString()}`,
  );

  if (!options.execute) {
    console.log("[metric-stream-catch-up] dry run only; add --execute to write to ClickHouse");
    await Sentry.close(2_000);
    return;
  }

  const postgresConnectionString = requireEnvironmentVariable("DATABASE_URL");
  const clickHouseClient = createClickHouseClientFromEnv(process.env, {
    requestTimeoutMs: CLICKHOUSE_REQUEST_TIMEOUT_MILLISECONDS,
  });

  try {
    await runMetricStreamCatchUp(clickHouseClient, postgresConnectionString, options);
    console.log("[metric-stream-catch-up] complete");
    await Sentry.close(2_000);
  } catch (error: unknown) {
    captureException(error);
    await Sentry.close(2_000);
    throw error;
  } finally {
    await clickHouseClient.close?.();
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch(async (error: unknown) => {
    captureException(error);
    await Sentry.close(2_000);
    console.error(`[metric-stream-catch-up] ${error}`);
    process.exit(1);
  });
}
