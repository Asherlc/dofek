import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./index.ts";
import { executeWithSchema } from "./typed-sql.ts";

export const GHOST_MAP_LABELS_SETTING_KEY = "ghostMapLabels";

export function ghostRouteLabelsCachePrefix(userId: string): string {
  return `${userId}:ghostRouteLabels.`;
}

const consentSchema = z.object({ revision: z.iso.datetime({ precision: 6 }) });

/** Read live consent and preserve the PostgreSQL timestamp's microseconds for the cache key. */
export async function readGhostMapLabelConsent(
  db: Pick<Database, "execute">,
  userId: string,
): Promise<{ revision: string } | null> {
  const [consent] = await executeWithSchema(
    db,
    consentSchema,
    sql`
    SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision
    FROM fitness.user_settings
    WHERE user_id = ${userId}::uuid AND key = ${GHOST_MAP_LABELS_SETTING_KEY}
      AND value = 'true'::jsonb`,
  );
  return consent ?? null;
}
