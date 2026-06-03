import * as Sentry from "@sentry/node";
import { Client } from "pg";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import {
  assertClickHouseCdcHealth,
  checkClickHouseCdcHealth,
} from "../src/db/clickhouse-cdc-health.ts";

function requireEnvironmentVariable(environmentVariableName: string): string {
  const value = process.env[environmentVariableName];
  if (!value) {
    throw new Error(`${environmentVariableName} is required`);
  }

  return value;
}

export async function main(): Promise<void> {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }

  let postgresClient: Client | null = null;
  let clickHouseClient: ReturnType<typeof createClickHouseClientFromEnv> | null = null;

  let exitCode = 0;
  try {
    postgresClient = new Client({
      connectionString: requireEnvironmentVariable("DATABASE_URL"),
    });
    clickHouseClient = createClickHouseClientFromEnv();

    await postgresClient.connect();
    const report = await checkClickHouseCdcHealth({
      postgresClient,
      clickHouseClient,
    });

    for (const issue of report.issues) {
      const prefix = issue.severity === "failure" ? "failure" : "warning";
      console.error(`[clickhouse-cdc-health] ${prefix}: ${issue.message}`);
    }

    assertClickHouseCdcHealth(report);
    console.log(
      `[clickhouse-cdc-health] ok: checked ${report.slotCount} slots and ${report.mirrorCount} mirrors`,
    );
    await Sentry.close(2_000);
  } catch (error: unknown) {
    exitCode = 1;
    Sentry.captureException(error);
    console.error(`[clickhouse-cdc-health] ${error}`);
    await Sentry.close(2_000);
  } finally {
    await Promise.all([postgresClient?.end(), clickHouseClient?.close?.()]);
  }

  process.exit(exitCode);
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  void main();
}
