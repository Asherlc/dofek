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
  activity_id: z.string().nullable(),
  climbing_log_entry_id: z.string().nullable(),
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
  return recordImageDiscovery(db, { ...input, owner: { kind: "activity", id: input.activityId } });
}

export async function recordClimbingImageDiscovery(
  db: ActivityImageDatabase,
  input: {
    userId: string;
    climbingLogEntryId: string;
    providerId: string;
    discovery: ImageDiscovery;
  },
): Promise<void> {
  return recordImageDiscovery(db, {
    ...input,
    owner: { kind: "climbing", id: input.climbingLogEntryId },
  });
}

async function recordImageDiscovery(
  db: ActivityImageDatabase,
  input: {
    userId: string;
    providerId: string;
    discovery: ImageDiscovery;
    owner: { kind: "activity" | "climbing"; id: string };
  },
): Promise<void> {
  const { userId, providerId, discovery, owner } = input;
  const climbing = owner.kind === "climbing";
  const ownerColumn = sql.identifier(climbing ? "climbing_log_entry_id" : "activity_id");
  await db.transaction(async (tx) => {
    const owned = await executeWithSchema(
      tx,
      idRow,
      climbing
        ? sql`SELECT id FROM fitness.climbing_log_entry WHERE user_id=${userId}::uuid AND id=${owner.id}::uuid AND provider_id=${providerId} AND provider_absent_at IS NULL FOR UPDATE`
        : sql`SELECT id FROM fitness.activity WHERE user_id=${userId}::uuid AND id=${owner.id}::uuid AND provider_id=${providerId} AND deleted_at IS NULL AND provider_absent_at IS NULL FOR UPDATE`,
    );
    if (!owned.length) return;
    await tx.execute(
      sql`INSERT INTO fitness.activity_image_discovery(user_id, ${ownerColumn}, provider_id, coverage, expected_count, reason) VALUES(${userId}::uuid,${owner.id}::uuid,${providerId},${discovery.coverage},${discovery.expectedCount},${discovery.reason}) ON CONFLICT(user_id,${ownerColumn},provider_id) DO UPDATE SET coverage=excluded.coverage, expected_count=excluded.expected_count,reason=excluded.reason,checked_at=now()`,
    );
    if (climbing && discovery.coverage === "complete") {
      const sourceIds = discovery.images.map((candidate) => candidate.sourceId);
      await tx.execute(
        sql`UPDATE fitness.activity_image SET retired_at=now(),object_id=NULL,generation=generation+1,updated_at=now() WHERE user_id=${userId}::uuid AND climbing_log_entry_id=${owner.id}::uuid AND provider_id=${providerId} AND source_id <> ALL(${sql.param(sourceIds)}::text[]) AND retired_at IS NULL`,
      );
    }
    for (const candidate of discovery.images) {
      if (!candidate.variants.length) continue;
      // URL rotation refreshes pending work without resetting its generation or retry budget.
      const rows = await executeWithSchema(
        tx,
        idRow,
        sql`INSERT INTO fitness.activity_image(user_id,${ownerColumn},provider_id,source_id,candidate) VALUES(${userId}::uuid,${owner.id}::uuid,${providerId},${candidate.sourceId},${JSON.stringify(candidate)}::jsonb) ON CONFLICT(user_id,${ownerColumn},provider_id,source_id) DO UPDATE SET candidate=excluded.candidate, generation=activity_image.generation+CASE WHEN activity_image.candidate->>'revision' IS DISTINCT FROM excluded.candidate->>'revision' OR (${climbing} AND activity_image.retired_at IS NOT NULL) THEN 1 ELSE 0 END,retired_at=CASE WHEN ${climbing} THEN NULL ELSE activity_image.retired_at END,updated_at=now() WHERE activity_image.retired_at IS NULL OR ${climbing} RETURNING id`,
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

// The association's owning record controls visibility; an optional activity
// attachment does not own a climbing log's images.
const visibleImageOwner = sql`(
  EXISTS(SELECT 1 FROM fitness.activity a WHERE a.id=i.activity_id AND a.user_id=i.user_id AND a.deleted_at IS NULL AND a.provider_absent_at IS NULL)
  OR EXISTS(SELECT 1 FROM fitness.climbing_log_entry l WHERE l.id=i.climbing_log_entry_id AND l.user_id=i.user_id AND l.provider_id=i.provider_id AND l.provider_absent_at IS NULL)
)`;

export async function listPendingActivityImageWork(
  db: SchemaExecutionDatabase,
  limit = 100,
): Promise<Array<{ id: string; userId: string }>> {
  const rows = await executeWithSchema(
    db,
    z.object({ id: z.string(), user_id: z.string() }),
    sql`SELECT w.id,w.user_id FROM fitness.activity_image_work w JOIN fitness.activity_image i ON i.id=w.image_id AND i.user_id=w.user_id JOIN fitness.provider_connection c ON c.user_id=i.user_id AND c.provider_id=i.provider_id WHERE w.state IN ('pending','retryable_failure') AND w.available_at<=now() AND w.dispatched_at IS NULL AND i.retired_at IS NULL AND i.generation=w.generation AND ${visibleImageOwner} ORDER BY w.created_at LIMIT ${limit}`,
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
    sql`SELECT w.*,i.provider_id,i.activity_id,i.climbing_log_entry_id,i.candidate,coalesce(a.external_id,l.external_id) AS external_id FROM fitness.activity_image_work w JOIN fitness.activity_image i ON i.id=w.image_id AND i.user_id=w.user_id LEFT JOIN fitness.activity a ON a.id=i.activity_id AND a.user_id=i.user_id LEFT JOIN fitness.climbing_log_entry l ON l.id=i.climbing_log_entry_id AND l.user_id=i.user_id AND l.provider_id=i.provider_id JOIN fitness.provider_connection c ON c.user_id=i.user_id AND c.provider_id=i.provider_id WHERE w.id=${id}::uuid AND w.user_id=${userId}::uuid AND i.retired_at IS NULL AND i.generation=w.generation AND ${visibleImageOwner} AND w.state IN ('pending','retryable_failure','processing')`,
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        userId: row.user_id,
        providerId: row.provider_id,
        ...(row.activity_id !== null
          ? { activityId: row.activity_id }
          : { activityId: null, climbingLogEntryId: z.string().parse(row.climbing_log_entry_id) }),
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
    // Lock the actual owner and connection through attachment, serializing
    // deletion, source absence, retirement and disconnect with completion.
    const current = await executeWithSchema(
      tx,
      idRow,
      work.activityId === null
        ? sql`SELECT l.id FROM fitness.climbing_log_entry l JOIN fitness.activity_image i ON i.climbing_log_entry_id=l.id AND i.user_id=l.user_id AND i.provider_id=l.provider_id JOIN fitness.provider_connection c ON c.user_id=i.user_id AND c.provider_id=i.provider_id WHERE i.id=${work.imageId}::uuid AND i.user_id=${work.userId}::uuid AND i.generation=${work.generation} AND i.retired_at IS NULL AND l.provider_absent_at IS NULL FOR UPDATE OF l,i FOR KEY SHARE OF c`
        : sql`SELECT a.id FROM fitness.activity a JOIN fitness.activity_image i ON i.activity_id=a.id AND i.user_id=a.user_id JOIN fitness.provider_connection c ON c.user_id=i.user_id AND c.provider_id=i.provider_id WHERE i.id=${work.imageId}::uuid AND i.user_id=${work.userId}::uuid AND i.generation=${work.generation} AND i.retired_at IS NULL AND a.deleted_at IS NULL AND a.provider_absent_at IS NULL FOR UPDATE OF a,i FOR KEY SHARE OF c`,
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
