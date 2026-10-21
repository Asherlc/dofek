import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import { executeWithSchema } from "dofek/db/execute-with-schema";
import { sql } from "drizzle-orm";
import { z } from "zod";

const sourceSchema = z.object({
  activityId: z.string(),
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
  activityId: z.string(),
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
  const images = await executeWithSchema(
    db,
    imageSchema,
    sql`SELECT o.id,o.object_key AS "objectKey",o.width,o.height,o.mime_type AS "mimeType",o.size_bytes AS "sizeBytes",jsonb_agg(jsonb_build_object('activityId',i.activity_id,'providerId',i.provider_id,'sourceId',i.source_id,'kind',i.candidate->>'kind','caption',i.candidate->>'caption','position',(i.candidate->>'position')::int) ORDER BY i.provider_id,(i.candidate->>'position')::int,i.id) AS sources FROM fitness.activity_image i JOIN fitness.activity a ON a.id=i.activity_id AND a.user_id=i.user_id JOIN fitness.activity_image_object o ON o.id=i.object_id AND o.user_id=i.user_id WHERE ${visible} AND i.retired_at IS NULL GROUP BY o.id ORDER BY o.created_at,o.id`,
  );
  const coverage = await executeWithSchema(
    db,
    coverageSchema,
    sql`SELECT a.id AS "activityId",a.provider_id AS "providerId",coalesce(d.coverage,'unavailable') AS coverage,CASE WHEN d.id IS NULL THEN 'media_not_discovered' ELSE d.reason END AS reason,d.expected_count AS "expectedCount" FROM fitness.activity a LEFT JOIN fitness.activity_image_discovery d ON a.id=d.activity_id AND a.user_id=d.user_id AND a.provider_id=d.provider_id WHERE ${visible} ORDER BY a.provider_id,a.id`,
  );
  const acquisition = await executeWithSchema(
    db,
    acquisitionSchema,
    sql`SELECT i.id,w.state,w.error_code AS "errorCode",w.attempts FROM fitness.activity_image i JOIN fitness.activity a ON a.id=i.activity_id AND a.user_id=i.user_id JOIN LATERAL (SELECT state,error_code,attempts FROM fitness.activity_image_work WHERE image_id=i.id AND generation=i.generation ORDER BY created_at DESC,id DESC LIMIT 1) w ON true WHERE ${visible} AND i.retired_at IS NULL`,
  );
  return { images, coverage, acquisition };
}
export async function getOwnedActivityImages(
  id: string,
  deps: {
    members(id: string): Promise<string[] | null>;
    read(ids: string[]): Promise<ImageReadResult>;
    sign(key: string): Promise<string>;
  },
) {
  const members = await deps.members(id);
  if (!members?.length) throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
  const result = await deps.read(members);
  return {
    ...result,
    images: await Promise.all(
      result.images.map(async ({ objectKey, ...image }) => ({
        ...image,
        url: await deps.sign(objectKey),
      })),
    ),
  };
}
