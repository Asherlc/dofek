import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ActivityImageWork, ImageDiscovery } from "../activity-images/types.ts";
import type { Database } from "./index.ts";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

export type ActivityImageDatabase = Pick<Database, "execute" | "transaction">;
const idRow = z.object({ id: z.string() });
const candidateSchema = z.object({
  sourceId: z.string(),
  kind: z.enum(["photo", "screenshot", "class_artwork"]),
  caption: z.string().nullable(),
  position: z.number(),
  variants: z.array(
    z.object({ url: z.string(), width: z.number().nullable(), height: z.number().nullable() }),
  ),
  revision: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()),
});
const workRow = z.object({
  id: z.string(),
  user_id: z.string(),
  provider_id: z.string(),
  activity_id: z.string(),
  external_id: z.string(),
  image_id: z.string(),
  generation: z.number(),
  candidate: candidateSchema,
  attempts: z.number(),
});

export async function recordActivityImageDiscovery(
  db: ActivityImageDatabase,
  input: { userId: string; activityId: string; providerId: string; discovery: ImageDiscovery },
): Promise<void> {
  const { userId, activityId, providerId, discovery } = input;
  await db.transaction(async (tx) => {
    const owned = await executeWithSchema(
      tx,
      idRow,
      sql`SELECT id FROM fitness.activity WHERE user_id=${userId}::uuid AND id=${activityId}::uuid AND provider_id=${providerId} AND deleted_at IS NULL AND provider_absent_at IS NULL FOR UPDATE`,
    );
    if (!owned.length) return;
    await tx.execute(
      sql`INSERT INTO fitness.activity_image_discovery(user_id, activity_id, provider_id, coverage, expected_count, reason) VALUES(${userId}::uuid,${activityId}::uuid,${providerId},${discovery.coverage},${discovery.expectedCount},${discovery.reason}) ON CONFLICT(user_id,activity_id,provider_id) DO UPDATE SET coverage=excluded.coverage, expected_count=excluded.expected_count,reason=excluded.reason,checked_at=now()`,
    );
    for (const candidate of discovery.images) {
      if (!candidate.variants.length) continue;
      // URL rotation refreshes pending work without resetting its generation or retry budget.
      const rows = await executeWithSchema(
        tx,
        idRow,
        sql`INSERT INTO fitness.activity_image(user_id,activity_id,provider_id,source_id,candidate) VALUES(${userId}::uuid,${activityId}::uuid,${providerId},${candidate.sourceId},${JSON.stringify(candidate)}::jsonb) ON CONFLICT(user_id,activity_id,provider_id,source_id) DO UPDATE SET candidate=excluded.candidate, generation=activity_image.generation+CASE WHEN activity_image.candidate->>'revision' IS DISTINCT FROM excluded.candidate->>'revision' THEN 1 ELSE 0 END,updated_at=now() WHERE activity_image.retired_at IS NULL RETURNING id`,
      );
      const row = rows[0];
      if (row) {
        await tx.execute(
          sql`UPDATE fitness.activity_image_work SET state='terminal_failure',error_code='superseded' WHERE user_id=${userId}::uuid AND image_id=${row.id}::uuid AND generation<>(SELECT generation FROM fitness.activity_image WHERE id=${row.id}::uuid) AND state IN ('pending','retryable_failure','processing')`,
        );
        await tx.execute(
          sql`INSERT INTO fitness.activity_image_work(user_id,image_id,generation) SELECT user_id,id,generation FROM fitness.activity_image i WHERE id=${row.id}::uuid AND NOT EXISTS(SELECT 1 FROM fitness.activity_image_work w WHERE w.user_id=i.user_id AND w.image_id=i.id AND w.generation=i.generation)`,
        );
      }
    }
  });
}

export async function listPendingActivityImageWork(
  db: SchemaExecutionDatabase,
  limit = 100,
): Promise<Array<{ id: string; userId: string }>> {
  const rows = await executeWithSchema(
    db,
    z.object({ id: z.string(), user_id: z.string() }),
    sql`SELECT w.id,w.user_id FROM fitness.activity_image_work w JOIN fitness.activity_image i ON i.id=w.image_id JOIN fitness.activity a ON a.id=i.activity_id JOIN fitness.provider_connection c ON c.user_id=i.user_id AND c.provider_id=i.provider_id WHERE w.state IN ('pending','retryable_failure') AND w.available_at<=now() AND w.dispatched_at IS NULL AND i.retired_at IS NULL AND i.generation=w.generation AND a.deleted_at IS NULL AND a.provider_absent_at IS NULL ORDER BY w.created_at LIMIT ${limit}`,
  );
  return rows.map((row) => ({ id: row.id, userId: row.user_id }));
}
export async function markActivityImageDispatched(
  db: SchemaExecutionDatabase,
  id: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE fitness.activity_image_work SET dispatched_at=now() WHERE id=${id}::uuid AND state IN ('pending','retryable_failure') AND available_at<=now()`,
  );
}
export async function loadActivityImageWork(
  db: SchemaExecutionDatabase,
  id: string,
  userId: string,
): Promise<ActivityImageWork | null> {
  const rows = await executeWithSchema(
    db,
    workRow,
    sql`SELECT w.*,i.provider_id,i.activity_id,i.candidate,a.external_id FROM fitness.activity_image_work w JOIN fitness.activity_image i ON i.id=w.image_id AND i.user_id=w.user_id JOIN fitness.activity a ON a.id=i.activity_id JOIN fitness.provider_connection c ON c.user_id=i.user_id AND c.provider_id=i.provider_id WHERE w.id=${id}::uuid AND w.user_id=${userId}::uuid AND i.retired_at IS NULL AND i.generation=w.generation AND a.deleted_at IS NULL AND a.provider_absent_at IS NULL AND w.state IN ('pending','retryable_failure','processing')`,
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        providerId: row.provider_id,
        activityId: row.activity_id,
        activityExternalId: row.external_id,
        imageId: row.image_id,
        generation: row.generation,
        candidate: row.candidate,
        attempts: row.attempts,
      }
    : null;
}
export async function claimActivityImageWork(
  db: SchemaExecutionDatabase,
  work: ActivityImageWork,
): Promise<boolean> {
  const rows = await executeWithSchema(
    db,
    idRow,
    sql`UPDATE fitness.activity_image_work SET state='processing',attempts=attempts+1,processing_at=now() WHERE id=${work.id}::uuid AND state IN ('pending','retryable_failure') AND available_at<=now() RETURNING id`,
  );
  return rows.length > 0;
}
export async function failActivityImageWork(
  db: SchemaExecutionDatabase,
  work: ActivityImageWork,
  retryable: boolean,
  code: string,
  delaySeconds = 30,
): Promise<void> {
  const retry = retryable && work.attempts < 4;
  await db.execute(
    sql`UPDATE fitness.activity_image_work SET state=${retry ? "retryable_failure" : "terminal_failure"},error_code=${code},available_at=now()+${delaySeconds}*interval '1 second',dispatched_at=NULL,processing_at=NULL WHERE id=${work.id}::uuid AND state='processing'`,
  );
}
export interface StoredImageMetadata {
  sha256: string;
  objectKey: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
}
export async function completeActivityImageWork(
  db: ActivityImageDatabase,
  work: ActivityImageWork,
  image: StoredImageMetadata,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Serializes image retirement and attachment with activity deletion.
    const current = await executeWithSchema(
      tx,
      idRow,
      sql`SELECT a.id FROM fitness.activity a JOIN fitness.activity_image i ON i.activity_id=a.id WHERE i.id=${work.imageId}::uuid AND i.user_id=${work.userId}::uuid AND i.generation=${work.generation} AND i.retired_at IS NULL AND a.deleted_at IS NULL AND a.provider_absent_at IS NULL FOR UPDATE OF a,i`,
    );
    if (!current.length) return false;
    const objects = await executeWithSchema(
      tx,
      idRow,
      sql`INSERT INTO fitness.activity_image_object(user_id,sha256,object_key,mime_type,size_bytes,width,height) VALUES(${work.userId}::uuid,${image.sha256},${image.objectKey},${image.mimeType},${image.sizeBytes},${image.width},${image.height}) ON CONFLICT(user_id,sha256) DO UPDATE SET sha256=excluded.sha256 RETURNING id`,
    );
    const object = objects[0];
    if (!object) throw Error("Image object insert returned no row");
    await tx.execute(
      sql`UPDATE fitness.activity_image SET object_id=${object.id}::uuid,updated_at=now() WHERE id=${work.imageId}::uuid`,
    );
    await tx.execute(
      sql`UPDATE fitness.activity_image_work SET state='stored',processing_at=NULL,error_code=NULL WHERE id=${work.id}::uuid`,
    );
    return true;
  });
}
export async function reconcileActivityImageWork(db: SchemaExecutionDatabase): Promise<void> {
  await db.execute(
    sql`UPDATE fitness.activity_image_work SET state=CASE WHEN attempts>=5 THEN 'terminal_failure' ELSE 'retryable_failure' END,dispatched_at=NULL,processing_at=NULL,error_code='lease_expired' WHERE state='processing' AND processing_at<now()-interval '15 minutes'`,
  );
  await db.execute(
    sql`UPDATE fitness.activity_image_work SET dispatched_at=NULL WHERE state IN ('pending','retryable_failure') AND dispatched_at<now()-interval '15 minutes'`,
  );
}
export async function retireActivityImages(
  db: SchemaExecutionDatabase,
  input: { userId: string; activityIds: string[] },
): Promise<void> {
  if (!input.activityIds.length) return;
  await db.execute(
    sql`UPDATE fitness.activity_image SET retired_at=now(),object_id=NULL,generation=generation+1 WHERE user_id=${input.userId}::uuid AND activity_id IN (${sql.join(
      input.activityIds.map((id) => sql`${id}::uuid`),
      sql`,`,
    )}) AND retired_at IS NULL`,
  );
}
