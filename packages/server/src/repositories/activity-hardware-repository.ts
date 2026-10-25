import type { Database } from "dofek/db";
import { executeWithSchema } from "dofek/db/execute-with-schema";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { normalizeActivityHardware } from "../models/activity-hardware.ts";

const memberSchema = z.object({
  activityId: z.string(),
  providerId: z.string(),
  sourceName: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()).nullable(),
  observations: z.array(
    z.object({
      sequence: z.number(),
      messageType: z.string(),
      raw: z.record(z.string(), z.unknown()),
    }),
  ),
});

export async function listActivityHardware(
  db: Pick<Database, "execute">,
  input: { userId: string; memberActivityIds: string[] },
) {
  if (!input.memberActivityIds.length) return { items: [], power: [] };
  const ids = sql.join(
    input.memberActivityIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const members = await executeWithSchema(
    db,
    memberSchema,
    sql`
    SELECT a.id AS "activityId", a.provider_id AS "providerId", a.source_name AS "sourceName", a.raw,
      coalesce(jsonb_agg(jsonb_build_object('sequence', o.sequence, 'messageType', o.message_type, 'raw', o.raw) ORDER BY o.sequence)
        FILTER (WHERE o.activity_id IS NOT NULL), '[]'::jsonb) AS observations
    FROM fitness.activity a
    LEFT JOIN fitness.activity_device_observation o ON o.activity_id = a.id
    WHERE a.user_id = ${input.userId}::uuid AND a.id IN (${ids})
      AND a.deleted_at IS NULL AND a.provider_absent_at IS NULL
    GROUP BY a.id ORDER BY a.provider_id, a.id
  `,
  );
  return normalizeActivityHardware(members);
}
