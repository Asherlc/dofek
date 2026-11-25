import { createHash } from "node:crypto";
import { z } from "zod";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { readGhostMapLabelConsent } from "../db/ghost-map-label-consent.ts";
import { ghostTrackStampSchema } from "../db/ghost-track-evidence.ts";
import type { Database } from "../db/index.ts";
import { readGhostRouteInput } from "../jobs/process-ghost-route-labels-job.ts";
import { enqueueGhostRouteClimbs, enqueueGhostRouteLabels } from "../jobs/queues.ts";
import { queryCache } from "../lib/cache.ts";
import { captureException } from "../lib/error-reporting.ts";
import { readGhostRouteClimbsCache } from "../lib/ghost-route-climbs-cache.ts";
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
const automaticSectionWindowMs = 24 * 60 * 60 * 1_000;
const exactUtcTimestamp = z.iso.datetime({ precision: 6 });

function isRecentRecording(startedAt: string): boolean {
  const now = Date.now();
  // Keep the database timestamp's six fractional digits in the comparison.
  const from = new Date(now - automaticSectionWindowMs).toISOString().replace("Z", "000Z");
  const through = new Date(now).toISOString().replace("Z", "000Z");
  return startedAt >= from && startedAt <= through;
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
    const labelsRegion = readGhostMapLabelsRegion(process.env.GHOST_MAP_LABELS_REGION);
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
          const input = await readGhostRouteInput(transaction, client, key);
          if (!input) return;
          const startedAt = exactUtcTimestamp.parse(input.source.startedAt);
          if (!isRecentRecording(startedAt)) return;
          const anchorGeneration = createHash("sha256")
            .update(JSON.stringify(ghostTrackStampSchema.parse(input.source)))
            .digest("hex");
          if (anchorGeneration !== progress.anchorGeneration) return;
          const revision = { ...key, sourceVersion: input.sourceVersion };
          try {
            if ((await readGhostRouteClimbsCache(queryCache, revision)) === undefined)
              await enqueueGhostRouteClimbs(revision);
          } catch (error: unknown) {
            captureException(error, { tags: { source: "ghost-route-climbs-publication" } });
          }

          if (!labelsRegion) return;
          try {
            const consent = await readGhostMapLabelConsent(transaction, key.userId);
            if (!consent || startedAt < exactUtcTimestamp.parse(consent.revision)) return;
            const labelRevision = { ...revision, consentRevision: consent.revision };
            const cached = await readGhostRouteLabelsCache(queryCache, labelRevision);
            if (!cached) {
              await enqueueGhostRouteLabels(labelRevision);
            } else if (
              cached.status === "ready" &&
              cached.sections.length > 0 &&
              !cached.prepared &&
              cached.expiresAt !== undefined &&
              cached.expiresAt > Date.now()
            ) {
              await enqueueGhostRouteLabels({ ...labelRevision, prepareOnly: true });
            }
          } catch (error: unknown) {
            captureException(error, { tags: { source: "ghost-route-labels-publication" } });
          }
        });
      } catch (error: unknown) {
        captureException(error, { tags: { source: "ghost-route-section-publication" } });
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
