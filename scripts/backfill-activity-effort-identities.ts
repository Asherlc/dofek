import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as Sentry from "@sentry/node";
import {
  type ActivityEffortIdentityAuditOptions,
  auditActivityEffortIdentities,
} from "../src/db/activity-effort-identity-backfill.ts";
import { parsePostgresTimestamp } from "../src/db/clickhouse-migrations/sql.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { captureException } from "../src/lib/error-reporting.ts";

const MAXIMUM_WINDOW_MILLISECONDS = 31 * 24 * 60 * 60 * 1_000;

function parseUtcTimestamp(value: string, optionName: string): Date {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error(`${optionName} must include an explicit UTC time zone`);
  }
  if (!/(?:Z|\+00:?00)$/.test(value)) {
    throw new Error(`${optionName} must use UTC`);
  }
  return parsePostgresTimestamp(value, optionName);
}

export function parseActivityEffortIdentityAuditOptions(
  args: readonly string[],
): ActivityEffortIdentityAuditOptions {
  const { values } = parseArgs({
    args,
    options: {
      end: { type: "string" },
      start: { type: "string" },
      "user-id": { type: "string" },
    },
    strict: true,
  });
  if (!values["user-id"]) throw new Error("--user-id is required");
  if (!values.start) throw new Error("--start is required");
  if (!values.end) throw new Error("--end is required");

  const start = parseUtcTimestamp(values.start, "--start");
  const end = parseUtcTimestamp(values.end, "--end");
  if (start.getTime() >= end.getTime()) throw new Error("--start must be before --end");
  if (end.getTime() - start.getTime() > MAXIMUM_WINDOW_MILLISECONDS) {
    throw new Error("Backfill window must not exceed 31 days");
  }
  return { end, start, userId: values["user-id"] };
}

function initializeSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseActivityEffortIdentityAuditOptions(args);
  initializeSentry();
  let db: ReturnType<typeof createDatabaseFromEnv> | undefined;
  try {
    db = createDatabaseFromEnv();
    const result = await auditActivityEffortIdentities(db, options);
    console.log(
      `[activity-effort-identity-audit] scanned=${result.scanned} skipped=${result.skipped} conflicts=${result.conflicts} refresh_ready=${result.refreshReady} details_truncated=${result.detailsTruncated}`,
    );
    for (const detail of result.details) {
      console.log(
        `[activity-effort-identity-audit] detail=${JSON.stringify({
          kind: detail.kind,
          providerId: detail.providerId,
          sourceField: detail.sourceField,
          distinctValueCount: detail.distinctValueCount,
          valueTypes: detail.valueTypes,
        })}`,
      );
    }
    if (!result.refreshReady) {
      throw new Error(
        "Active activity is missing persisted group_id; reconcile PostgreSQL membership before CDC",
      );
    }
    console.log(
      "[activity-effort-identity-audit] audit complete; review results, then run the documented bounded dbt refresh",
    );
  } catch (error: unknown) {
    captureException(error);
    throw error;
  } finally {
    await db?.$client.end();
    await Sentry.close(2_000);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[activity-effort-identity-audit] ${error}`);
    process.exit(1);
  });
}
