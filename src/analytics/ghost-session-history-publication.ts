import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  type AnalyticsQueryOwner,
  withAnalyticsQueryOwner,
} from "./analytics-query-owner.ts";

const ghostPublication = { resourceId: "ghost-session-history", intentId: "ghost-session-history" };
type OwnerDatabase = Pick<Database, "$client">;

/** The Ghost intent cannot retain or block the completed ordinary analytics resource. */
export async function runAnalyticsWithGhostHistory(
  database: OwnerDatabase,
  client: ClickHouseClient,
  intentId: string,
  ordinary: (owner: AnalyticsQueryOwner) => Promise<void>,
) {
  await withAnalyticsQueryOwner(
    database,
    client,
    { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId },
    ordinary,
  );
  try {
    await withAnalyticsQueryOwner(database, client, ghostPublication, async (owner) => {
      const { runGhostSessionHistory } = await import("./ghost-session-history-runner.ts");
      await runGhostSessionHistory(owner);
    });
  } catch (error: unknown) {
    captureException(error, { tags: { source: "ghost-session-history" } });
  }
}

/** Call after the ClickHouse erasure fence and before starting physical deletion. */
export async function drainGhostSessionHistory(database: OwnerDatabase, client: ClickHouseClient) {
  await withAnalyticsQueryOwner(database, client, ghostPublication, async () => {});
}
