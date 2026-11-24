import { createHash } from "node:crypto";
import { z } from "zod";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { ghostTrackStampSchema } from "../db/ghost-track-evidence.ts";
import type { Database } from "../db/index.ts";
import { readGhostRouteLabelsInput } from "../jobs/process-ghost-route-labels-job.ts";
import { enqueueGhostRouteLabels } from "../jobs/queues.ts";
import { queryCache } from "../lib/cache.ts";
import { captureException } from "../lib/error-reporting.ts";
import { readGhostRouteLabelsCache } from "../lib/ghost-route-labels-cache.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  type AnalyticsQueryOwner,
  withAnalyticsQueryOwner,
} from "./analytics-query-owner.ts";
import { readGhostMapLabelsRegion } from "./ghost-route-label-config.ts";

const ghostPublication = { resourceId: "ghost-session-history", intentId: "ghost-session-history" };
type OwnerDatabase = Pick<Database, "$client">;
type PublicationDatabase = Pick<Database, "$client" | "transaction">;
const automaticLabelWindowMs = 24 * 60 * 60 * 1_000;
const exactUtcTimestamp = z.iso.datetime({ precision: 6 });

function isNewLabelRecording(recordedAt: string, optedInAt: string): boolean {
  const startedAt = exactUtcTimestamp.parse(recordedAt);
  const consentRevision = exactUtcTimestamp.parse(optedInAt);
  const now = Date.now();
  // Both database timestamps carry six fractional digits. Keep those digits in the comparison.
  const from = new Date(now - automaticLabelWindowMs).toISOString().replace("Z", "000Z");
  const through = new Date(now).toISOString().replace("Z", "000Z");
  return startedAt >= consentRevision && startedAt >= from && startedAt <= through;
}

/** The Ghost intent cannot retain or block the completed ordinary analytics resource. */
export async function runAnalyticsWithGhostHistory(
  database: PublicationDatabase,
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
    const { getGhostSessionHistoryProgress, runGhostSessionHistory } = await import(
      "./ghost-session-history-runner.ts"
    );
    const { checkedAnchorKeys } = await withAnalyticsQueryOwner(
      database,
      client,
      ghostPublication,
      runGhostSessionHistory,
    );
    if (!readGhostMapLabelsRegion(process.env.GHOST_MAP_LABELS_REGION)) return;
    for (const key of checkedAnchorKeys) {
      try {
        const progress = await getGhostSessionHistoryProgress(client, key);
        if (
          progress?.anchorStatus !== "ready" ||
          !progress.anchorGeneration ||
          !progress.historyGeneration
        )
          continue;
        await withAccountErasureUserWriteFence(database, key.userId, async (transaction) => {
          const input = await readGhostRouteLabelsInput(transaction, client, key);
          if (!input || !isNewLabelRecording(input.source.startedAt, input.consentRevision)) return;
          const anchorGeneration = createHash("sha256")
            .update(JSON.stringify(ghostTrackStampSchema.parse(input.source)))
            .digest("hex");
          if (anchorGeneration !== progress.anchorGeneration) return;
          const revision = {
            ...key,
            sourceVersion: input.sourceVersion,
            consentRevision: input.consentRevision,
          };
          if ((await readGhostRouteLabelsCache(queryCache, revision)) === undefined)
            await enqueueGhostRouteLabels(revision);
        });
      } catch (error: unknown) {
        captureException(error, { tags: { source: "ghost-route-labels-publication" } });
      }
    }
  } catch (error: unknown) {
    captureException(error, { tags: { source: "ghost-session-history" } });
  }
}

/** Call after the ClickHouse erasure fence and before starting physical deletion. */
export async function drainGhostSessionHistory(database: OwnerDatabase, client: ClickHouseClient) {
  await withAnalyticsQueryOwner(database, client, ghostPublication, async () => {});
}
