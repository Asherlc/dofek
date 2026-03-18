import { sql } from "drizzle-orm";
import { type PersonalizedParams, personalizedParamsSchema } from "./params.ts";

const SETTINGS_KEY = "personalized_params";

interface Database {
  execute: (query: ReturnType<typeof sql>) => Promise<Record<string, unknown>[]>;
}

export async function loadPersonalizedParams(
  db: Database,
  userId: string,
): Promise<PersonalizedParams | null> {
  const rows = await db.execute(
    sql`SELECT value FROM fitness.user_settings
        WHERE user_id = ${userId} AND key = ${SETTINGS_KEY}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;

  const parsed = personalizedParamsSchema.safeParse(row.value);
  if (!parsed.success) return null;
  return parsed.data;
}

export async function savePersonalizedParams(
  db: Database,
  userId: string,
  params: PersonalizedParams,
): Promise<void> {
  // Validate before saving to catch programming errors early
  personalizedParamsSchema.parse(params);

  await db.execute(
    sql`INSERT INTO fitness.user_settings (user_id, key, value, updated_at)
        VALUES (${userId}, ${SETTINGS_KEY}, ${JSON.stringify(params)}::jsonb, NOW())
        ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  );
}
