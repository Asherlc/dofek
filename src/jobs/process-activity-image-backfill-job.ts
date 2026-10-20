import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  discoverAndRecordActivityImages,
  imageDiscoveryFailure,
} from "../activity-images/providers.ts";
import type { ImageDiscovery } from "../activity-images/types.ts";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "../db/account-erasure.ts";
import type { ActivityImageDatabase } from "../db/activity-images.ts";
import type { SyncDatabase } from "../db/index.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { SyncRun } from "../providers/sync-run.ts";
import { SyncWindow } from "../providers/sync-window.ts";
import type { ActivityImageQueue } from "./activity-image-outbox.ts";

const rowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  provider_id: z.string(),
  cursor_started_at: z.coerce.date().nullable(),
  cursor_id: z.string().nullable(),
  high_water_at: z.coerce.date(),
  scanned: z.number(),
  state: z.string(),
});
interface BackfillActivity {
  id: string;
  externalId: string;
  startedAt: string;
}
export async function processImageBackfillPage(
  activities: BackfillActivity[],
  discover: (
    activity: BackfillActivity,
  ) => Promise<Pick<ImageDiscovery, "coverage" | "images" | "retryable" | "retryAfterSeconds">>,
) {
  let discovered = 0;
  let failed = 0;
  let scanned = 0;
  let cursor: BackfillActivity | null = null;
  let retryAfterSeconds = 0;
  for (const activity of activities) {
    try {
      const result = await discover(activity);
      discovered += result.images.length;
      if (result.coverage === "failed" || result.coverage === "partial") failed++;
      if (
        result.retryable === true ||
        (result.coverage === "failed" && result.retryable !== false)
      ) {
        retryAfterSeconds = result.retryAfterSeconds ?? 300;
        break;
      }
    } catch (error) {
      failed++;
      const failure = imageDiscoveryFailure(error);
      if (failure.retryable) {
        retryAfterSeconds = failure.retryAfterSeconds ?? 300;
        break;
      }
    }
    scanned++;
    cursor = activity;
  }
  return { scanned, discovered, failed, cursor, retryAfterSeconds };
}
export async function loadActivityImageBackfillProvider(
  db: ActivityImageDatabase,
  id: string,
  userId: string,
): Promise<string | undefined> {
  const rows = await executeWithSchema(
    db,
    z.object({ provider_id: z.string() }),
    sql`SELECT provider_id FROM fitness.activity_image_backfill WHERE id=${id}::uuid AND user_id=${userId}::uuid`,
  );
  return rows[0]?.provider_id;
}
export async function dispatchActivityImageBackfills(
  db: ActivityImageDatabase,
  queue: ActivityImageQueue,
): Promise<void> {
  const rows = await executeWithSchema(
    db,
    rowSchema,
    sql`SELECT * FROM fitness.activity_image_backfill WHERE (state='pending' AND available_at<=now()) OR (state='queued' AND updated_at<now()-interval '15 minutes') ORDER BY updated_at LIMIT 100`,
  );
  for (const row of rows) {
    try {
      await withAccountErasureUserWriteFence(db, row.user_id, async (tx) => {
        const claimed = await executeWithSchema(
          tx,
          z.object({ id: z.string() }),
          sql`UPDATE fitness.activity_image_backfill SET state='queued',updated_at=now() WHERE id=${row.id}::uuid AND scanned=${row.scanned} AND ((state='pending' AND available_at<=now()) OR (state='queued' AND updated_at<now()-interval '15 minutes')) RETURNING id`,
        );
        if (!claimed.length) return;
        await queue.add(
          "backfill",
          { backfillId: row.id, userId: row.user_id },
          {
            jobId: `activity-image-backfill-${row.id}-${row.scanned}`,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
      });
    } catch (error) {
      if (!(error instanceof AccountErasureUserFencedError)) throw error;
    }
  }
}
export async function processActivityImageBackfillJob(
  db: SyncDatabase,
  data: { backfillId: string; userId: string },
): Promise<void> {
  // Wait for the outbox's transaction even if Redis delivers before it commits.
  const rows = await db.transaction((tx) =>
    executeWithSchema(
      tx,
      rowSchema,
      sql`SELECT * FROM fitness.activity_image_backfill WHERE id=${data.backfillId}::uuid AND user_id=${data.userId}::uuid FOR UPDATE`,
    ),
  );
  const row = rows[0];
  if (row?.state !== "queued") return;
  const connected = await executeWithSchema(
    db,
    z.object({ provider_id: z.string() }),
    sql`SELECT provider_id FROM fitness.provider_connection WHERE user_id=${data.userId}::uuid AND provider_id=${row.provider_id}`,
  );
  if (!connected.length) {
    await db.execute(
      sql`UPDATE fitness.activity_image_backfill SET state='disconnected',updated_at=now() WHERE id=${row.id}::uuid`,
    );
    return;
  }
  const activities = await executeWithSchema(
    db,
    z.object({ id: z.string(), external_id: z.string(), started_at: z.string() }),
    sql`SELECT id,external_id,started_at::text FROM fitness.activity WHERE user_id=${data.userId}::uuid AND provider_id=${row.provider_id} AND deleted_at IS NULL AND provider_absent_at IS NULL AND started_at<=${row.high_water_at} AND (${row.cursor_started_at}::timestamptz IS NULL OR (started_at,id)>(${row.cursor_started_at}::timestamptz,${row.cursor_id}::uuid)) ORDER BY started_at,id LIMIT 100`,
  );
  const run = new SyncRun({
    db,
    userId: data.userId,
    window: new SyncWindow({ since: new Date(0), until: row.high_water_at }),
  });
  const progress = await processImageBackfillPage(
    activities.map((activity) => ({
      id: activity.id,
      externalId: activity.external_id,
      startedAt: activity.started_at,
    })),
    (activity) =>
      discoverAndRecordActivityImages(run, activity.id, activity.externalId, row.provider_id),
  );
  await withAccountErasureUserWriteFence(db, data.userId, async (tx) => {
    await tx.execute(
      sql`UPDATE fitness.activity_image_backfill SET scanned=scanned+${progress.scanned},discovered=discovered+${progress.discovered},failed=failed+${progress.failed},cursor_started_at=coalesce(${progress.cursor?.startedAt ?? null}::timestamptz,cursor_started_at),cursor_id=coalesce(${progress.cursor?.id ?? null}::uuid,cursor_id),state=${progress.retryAfterSeconds > 0 || activities.length === 100 ? "pending" : "completed"},available_at=now()+(${progress.retryAfterSeconds} * interval '1 second'),updated_at=now() WHERE id=${row.id}::uuid AND user_id=${data.userId}::uuid AND scanned=${row.scanned}`,
    );
  });
}
export async function startActivityImageBackfill(
  db: ActivityImageDatabase,
  userId: string,
  providerId?: string,
): Promise<string[]> {
  return withAccountErasureUserWriteFence(db, userId, async (tx) => {
    const rows = await executeWithSchema(
      tx,
      z.object({ id: z.string() }),
      sql`INSERT INTO fitness.activity_image_backfill(user_id,provider_id) SELECT DISTINCT user_id,provider_id FROM fitness.activity WHERE user_id=${userId}::uuid AND (${providerId ?? null}::text IS NULL OR provider_id=${providerId ?? null}) AND deleted_at IS NULL AND provider_absent_at IS NULL RETURNING id`,
    );
    return rows.map((row) => row.id);
  });
}
export async function getActivityImageBackfillProgress(
  db: ActivityImageDatabase,
  userId: string,
  runId: string,
) {
  return executeWithSchema(
    db,
    z.object({
      id: z.string(),
      provider_id: z.string(),
      state: z.string(),
      scanned: z.number(),
      discovered: z.number(),
      failed: z.number(),
      stored: z.coerce.number(),
      coverage: z.record(z.string(), z.number()),
    }),
    sql`SELECT b.id,b.provider_id,b.state,b.scanned,b.discovered,b.failed,(SELECT count(*) FROM fitness.activity_image i WHERE i.user_id=b.user_id AND i.provider_id=b.provider_id AND i.object_id IS NOT NULL AND i.retired_at IS NULL) stored, coalesce((SELECT jsonb_object_agg(counts.coverage,counts.count) FROM (SELECT d.coverage,count(*)::int FROM fitness.activity_image_discovery d WHERE d.user_id=b.user_id AND d.provider_id=b.provider_id GROUP BY d.coverage) counts),'{}'::jsonb) coverage FROM fitness.activity_image_backfill b WHERE b.id=${runId}::uuid AND b.user_id=${userId}::uuid`,
  );
}
