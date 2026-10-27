import { TRPCError } from "@trpc/server";
import { consolidateActivityImageCopies } from "dofek/activity-images/gallery";
import type { Database } from "dofek/db";
import { executeWithSchema } from "dofek/db/execute-with-schema";
import { captureException } from "dofek/lib/error-reporting";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

const sourceSchema = z.object({
  activityId: z.string().nullable(),
  climbingLogEntryId: z.string().optional(),
  providerId: z.string(),
  sourceId: z.string(),
  kind: z.string(),
  caption: z.string().nullable(),
  position: z.number(),
});
const imageSchema = z.object({
  id: z.string(),
  objectKey: z.string(),
  width: z.number(),
  height: z.number(),
  mimeType: z.string(),
  sizeBytes: z.coerce.number(),
  sources: z.array(sourceSchema),
});
const coverageSchema = z.object({
  activityId: z.string().nullable(),
  climbingLogEntryId: z.string().nullish(),
  providerId: z.string(),
  coverage: z.string(),
  reason: z.string().nullable(),
  expectedCount: z.number().nullable(),
});
const acquisitionSchema = z.object({
  id: z.string(),
  state: z.string(),
  errorCode: z.string().nullable(),
  attempts: z.number(),
});
export const activityImagesOutputSchema = z.object({
  images: z.array(imageSchema.omit({ objectKey: true }).extend({ url: z.string().url() })),
  coverage: z.array(coverageSchema),
  acquisition: z.array(acquisitionSchema),
});
type ImageReadResult = {
  images: z.infer<typeof imageSchema>[];
  coverage: z.infer<typeof coverageSchema>[];
  acquisition: z.infer<typeof acquisitionSchema>[];
};
export async function listActivityImages(
  db: Pick<Database, "execute">,
  input: { userId: string; memberActivityIds: string[] },
): Promise<ImageReadResult> {
  if (!input.memberActivityIds.length) return { images: [], coverage: [], acquisition: [] };
  const ids = sql.join(
    input.memberActivityIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const visible = sql`a.user_id=${input.userId}::uuid AND a.id IN (${ids}) AND a.deleted_at IS NULL AND a.provider_absent_at IS NULL`;
  return listOwnedImages(
    db,
    input.userId,
    sql`
    SELECT a.id AS activity_id, NULL::uuid AS climbing_log_entry_id, a.provider_id
    FROM fitness.activity a WHERE ${visible}
    UNION ALL
    SELECT NULL::uuid, log.id, log.provider_id
    FROM fitness.climbing_log_entry log
    JOIN fitness.activity a ON a.id=log.activity_id AND a.user_id=log.user_id
    WHERE ${visible} AND log.provider_absent_at IS NULL`,
  );
}

export async function listClimbingImages(
  db: Pick<Database, "execute">,
  input: { userId: string; climbingLogEntryId: string },
): Promise<ImageReadResult> {
  return listOwnedImages(
    db,
    input.userId,
    sql`
    SELECT NULL::uuid AS activity_id, log.id AS climbing_log_entry_id, log.provider_id
    FROM fitness.climbing_log_entry log
    WHERE log.user_id=${input.userId}::uuid AND log.id=${input.climbingLogEntryId}::uuid
      AND log.provider_absent_at IS NULL`,
  );
}

async function listOwnedImages(
  db: Pick<Database, "execute">,
  userId: string,
  owners: SQL,
): Promise<ImageReadResult> {
  const ownerMatch = sql`i.user_id=${userId}::uuid AND i.provider_id=owner.provider_id
    AND ((i.activity_id=owner.activity_id) OR (i.climbing_log_entry_id=owner.climbing_log_entry_id))`;
  const images = await executeWithSchema(
    db,
    imageSchema,
    sql`
    WITH owners AS (${owners})
    SELECT o.id,o.object_key AS "objectKey",o.width,o.height,o.mime_type AS "mimeType",o.size_bytes AS "sizeBytes",
      jsonb_agg(jsonb_build_object('activityId',i.activity_id,'providerId',i.provider_id,'sourceId',i.source_id,
        'kind',i.candidate->>'kind','caption',i.candidate->>'caption','position',(i.candidate->>'position')::int)
        || CASE WHEN i.climbing_log_entry_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('climbingLogEntryId',i.climbing_log_entry_id) END
        ORDER BY i.provider_id,(i.candidate->>'position')::int,i.id) AS sources
    FROM owners owner JOIN fitness.activity_image i ON ${ownerMatch}
    JOIN fitness.activity_image_object o ON o.id=i.object_id AND o.user_id=i.user_id
    WHERE i.retired_at IS NULL GROUP BY o.id ORDER BY o.created_at,o.id`,
  );
  const coverage = await executeWithSchema(
    db,
    coverageSchema,
    sql`
    WITH owners AS (${owners})
    SELECT owner.activity_id AS "activityId",owner.climbing_log_entry_id AS "climbingLogEntryId",owner.provider_id AS "providerId",
      coalesce(d.coverage,'unavailable') AS coverage,
      CASE WHEN d.id IS NULL THEN 'media_not_discovered' ELSE d.reason END AS reason,d.expected_count AS "expectedCount"
    FROM owners owner LEFT JOIN fitness.activity_image_discovery d
      ON d.user_id=${userId}::uuid AND d.provider_id=owner.provider_id
      AND (d.activity_id=owner.activity_id OR d.climbing_log_entry_id=owner.climbing_log_entry_id)
    ORDER BY owner.provider_id,owner.activity_id,owner.climbing_log_entry_id`,
  );
  const acquisition = await executeWithSchema(
    db,
    acquisitionSchema,
    sql`
    WITH owners AS (${owners})
    SELECT i.id,w.state,w.error_code AS "errorCode",w.attempts FROM owners owner
    JOIN fitness.activity_image i ON ${ownerMatch}
    JOIN LATERAL (SELECT state,error_code,attempts FROM fitness.activity_image_work
      WHERE image_id=i.id AND generation=i.generation ORDER BY created_at DESC,id DESC LIMIT 1) w ON true
    WHERE i.retired_at IS NULL`,
  );
  return { images, coverage, acquisition };
}
export async function getOwnedActivityImages(
  id: string,
  deps: {
    members(id: string): Promise<string[] | null>;
    read(ids: string[]): Promise<ImageReadResult>;
    sign(key: string): Promise<string>;
    readImage(key: string): Promise<Uint8Array>;
  },
) {
  const members = await deps.members(id);
  if (!members?.length) throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
  const result = await deps.read(members);
  return signStoredImages(result, deps);
}

export async function signStoredImages(
  result: ImageReadResult,
  deps: { sign(key: string): Promise<string>; readImage(key: string): Promise<Uint8Array> },
  owner: "activity" | "climbing" = "activity",
) {
  try {
    const images = await consolidateActivityImageCopies(result.images, deps.readImage);
    return {
      ...result,
      images: await Promise.all(
        images.map(async ({ objectKey, ...image }) => ({
          ...image,
          url: await deps.sign(objectKey),
        })),
      ),
    };
  } catch (error) {
    captureException(error, { tags: { context: `${owner}-photos` } });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Stored ${owner === "climbing" ? "ascent" : "activity"} photos could not be loaded. Refresh photos to retry.`,
      cause: error,
    });
  }
}
