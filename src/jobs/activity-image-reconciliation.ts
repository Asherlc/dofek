import { DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { createR2Client, requiredR2EnvironmentVariable } from "../r2-storage.ts";
import type { AccountErasureWorkLockPool } from "./account-erasure-work-guard.ts";
import { runQueuedUserWorkUnlessAccountErasing } from "./account-erasure-work-guard.ts";
/** One bounded bucket page per maintenance pass, including upload-before-ack orphans. */
export function createActivityImageReconciler(
  db: SyncDatabase,
  pool: AccountErasureWorkLockPool,
): () => Promise<void> {
  let cursor: string | undefined;
  return async () => {
    const client = createR2Client();
    const bucket = requiredR2EnvironmentVariable("ACTIVITY_MEDIA_R2_BUCKET");
    try {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: "images/",
          MaxKeys: 100,
          ContinuationToken: cursor,
        }),
        { abortSignal: AbortSignal.timeout(120_000) },
      );
      for (const item of page.Contents ?? []) {
        if (
          !item.Key ||
          !item.LastModified ||
          item.LastModified.getTime() > Date.now() - 86_400_000
        )
          continue;
        const match = /^images\/([a-f0-9-]+)\/([a-f0-9]{64})$/.exec(item.Key);
        const owner = z.uuid().safeParse(match?.[1]);
        if (!owner.success) continue;
        const key = item.Key;
        await runQueuedUserWorkUnlessAccountErasing(
          pool,
          db,
          owner.data,
          "activity image cleanup",
          () =>
            db.transaction(async (tx) => {
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended(${`activity-image-object:${key}`},0))`,
              );
              const referenced = await executeWithSchema(
                tx,
                z.object({ id: z.string() }),
                sql`SELECT i.id FROM fitness.activity_image i JOIN fitness.activity_image_object o ON o.id=i.object_id WHERE o.object_key=${key} AND i.retired_at IS NULL LIMIT 1`,
              );
              if (referenced.length) return;
              // Do not delete a file uploaded by a job whose database acknowledgement failed.
              const acquiring = await executeWithSchema(
                tx,
                z.object({ id: z.string() }),
                sql`SELECT id FROM fitness.activity_image_work WHERE user_id=${owner.data}::uuid AND state='processing' AND processing_at>now()-interval '15 minutes' LIMIT 1`,
              );
              if (acquiring.length) return;
              await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), {
                abortSignal: AbortSignal.timeout(120_000),
              });
              await tx.execute(
                sql`DELETE FROM fitness.activity_image_object WHERE object_key=${key} AND user_id=${owner.data}::uuid AND NOT EXISTS(SELECT 1 FROM fitness.activity_image WHERE object_id=activity_image_object.id)`,
              );
            }),
        );
      }
      if (page.IsTruncated && !page.NextContinuationToken)
        throw Error("Incomplete image reconciliation listing");
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } finally {
      client.destroy();
    }
  };
}
