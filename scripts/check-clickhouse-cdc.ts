import * as Sentry from "@sentry/node";
import { Client } from "pg";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import {
  assertClickHouseCdcHealth,
  checkClickHouseCdcHealth,
} from "../src/db/clickhouse-cdc-health.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import {
  createProcessingReconciliationDatabaseFromEnv,
  reconcilePendingProcessingOperations,
} from "../src/processing/processing-reconciler.ts";

function requireEnvironmentVariable(environmentVariableName: string): string {
  const value = process.env[environmentVariableName];
  if (!value) {
    throw new Error(`${environmentVariableName} is required`);
  }

  return value;
}

function isLocalhost(host: string): boolean {
  const normalizedHost = host.toLowerCase();
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]"
  );
}

function resolvePeerDbPassword(): string {
  const dedicatedPassword =
    process.env.PEERDB_CDC_PASSWORD?.trim() || process.env.PEERDB_PASSWORD?.trim();
  if (dedicatedPassword) {
    return dedicatedPassword;
  }

  return requireEnvironmentVariable("POSTGRES_PASSWORD");
}

function resolvePeerDbHost(databaseUrl: string): string {
  const peerDbHostOverride = process.env.PEERDB_CDC_HOST;
  if (peerDbHostOverride !== undefined) {
    const trimmedOverride = peerDbHostOverride.trim();
    if (!trimmedOverride) {
      throw new Error("PEERDB_CDC_HOST must be a non-empty host");
    }
    return trimmedOverride;
  }

  const sourceHost = new URL(databaseUrl).hostname;
  return isLocalhost(sourceHost) ? "127.0.0.1" : "peerdb";
}

function resolvePeerDbPort(): number {
  const rawPort = process.env.PEERDB_CDC_PORT ?? "9900";
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("PEERDB_CDC_PORT must be a valid TCP port");
  }
  const port = Number.parseInt(rawPort, 10);
  if (port <= 0 || port > 65_535) {
    throw new Error("PEERDB_CDC_PORT must be a valid TCP port");
  }
  return port;
}

function buildPeerDbUrl(databaseUrl: string): string {
  const peerDbUrl = new URL("postgres://peerdb@peerdb/peerdb");
  peerDbUrl.hostname = resolvePeerDbHost(databaseUrl);
  peerDbUrl.port = String(resolvePeerDbPort());
  peerDbUrl.password = resolvePeerDbPassword();
  return peerDbUrl.toString();
}

export async function main(): Promise<void> {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }

  let postgresClient: Client | null = null;
  let peerDbClient: Client | null = null;
  let clickHouseClient: ReturnType<typeof createClickHouseClientFromEnv> | null = null;

  let exitCode = 0;
  try {
    const databaseUrl = requireEnvironmentVariable("DATABASE_URL");
    postgresClient = new Client({
      connectionString: databaseUrl,
    });
    peerDbClient = new Client({
      connectionString: buildPeerDbUrl(databaseUrl),
    });
    clickHouseClient = createClickHouseClientFromEnv();

    await postgresClient.connect();
    await peerDbClient.connect();
    const report = await checkClickHouseCdcHealth({
      postgresClient,
      peerDbClient,
      clickHouseClient,
    });
    Sentry.setContext("clickhouse_cdc_health", {
      evidence: report.evidence,
      issues: report.issues,
      mirrorCount: report.mirrorCount,
      peerDbMirrorCount: report.peerDbMirrorCount,
      slotCount: report.slotCount,
    });

    for (const issue of report.issues) {
      const prefix = issue.severity === "failure" ? "failure" : "warning";
      console.error(`[clickhouse-cdc-health] ${prefix}: ${issue.message}`);
    }

    assertClickHouseCdcHealth(report);
    const reconciliation = await reconcilePendingProcessingOperations({
      database: createProcessingReconciliationDatabaseFromEnv(),
      clickHouseClient,
    });
    const mirrorLabel = report.mirrorCount === 1 ? "mirror" : "mirrors";
    console.log(
      `[clickhouse-cdc-health] ok: checked ${report.slotCount} slots and ${report.mirrorCount} ${mirrorLabel}`,
    );
    console.log(
      `[clickhouse-cdc-health] processing reconciliation: checked ${reconciliation.checked}, completed ${reconciliation.completed}, waiting ${reconciliation.waiting}`,
    );
    await Sentry.close(2_000);
  } catch (error: unknown) {
    exitCode = 1;
    captureException(error);
    console.error(`[clickhouse-cdc-health] ${error}`);
    await Sentry.close(2_000);
  } finally {
    await Promise.all([postgresClient?.end(), peerDbClient?.end(), clickHouseClient?.close?.()]);
  }

  process.exit(exitCode);
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  void main();
}
