import { sql } from "drizzle-orm";
import {
  claimActivityImageWork,
  completeActivityImageWork,
  failActivityImageWork,
  loadActivityImageWork,
} from "../db/activity-images.ts";
import type { Database } from "../db/index.ts";
import type { ActivityImageJobDependencies } from "../jobs/process-activity-image-job.ts";
import { SyncRun } from "../providers/sync-run.ts";
import { SyncWindow } from "../providers/sync-window.ts";
import { downloadActivityImage } from "./download.ts";
import { activityImageBytes } from "./metrics.ts";
import { refreshActivityImage } from "./providers.ts";
import { activityImageObjectKey, storeActivityImage } from "./storage.ts";
import { selectImageVariant } from "./types.ts";
export function createActivityImageJobDependencies(db: Database): ActivityImageJobDependencies {
  return {
    load: (id, userId) => loadActivityImageWork(db, id, userId),
    claim: (work) => claimActivityImageWork(db, work),
    fail: (work, retryable, code, delay) => failActivityImageWork(db, work, retryable, code, delay),
    refresh: (work) =>
      refreshActivityImage(
        new SyncRun({
          db,
          window: new SyncWindow({ since: new Date(0), until: new Date() }),
          userId: work.userId,
        }),
        work,
      ),
    async acquire(work) {
      const variant = selectImageVariant(work.candidate.variants);
      const image = await downloadActivityImage({
        url: variant.url,
        allowedOrigins: [
          ...new Set(work.candidate.variants.map((item) => new URL(item.url).origin)),
        ],
      });
      try {
        return await db.transaction(async (tx) => {
          const key = activityImageObjectKey(work.userId, image.sha256);
          // Cleanup uses this same lock: reference creation cannot race object deletion.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`activity-image-object:${key}`},0))`,
          );
          const current = await loadActivityImageWork(tx, work.id, work.userId);
          if (!current) return { stored: false };
          const stored = await storeActivityImage({ userId: work.userId, image });
          activityImageBytes.add(image.sizeBytes, { provider: work.providerId });
          return { stored: await completeActivityImageWork(tx, work, { ...image, ...stored }) };
        });
      } finally {
        await image.cleanup();
      }
    },
  };
}
