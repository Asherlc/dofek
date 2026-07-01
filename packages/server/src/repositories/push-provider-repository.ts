import { providerLabel } from "@dofek/providers/providers";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";

export async function ensurePushProvider({
  database,
  providerId,
  userId,
}: {
  database: Pick<Database, "execute">;
  providerId: string;
  userId: string;
}): Promise<void> {
  await database.execute(
    sql`INSERT INTO fitness.provider (id, name, user_id)
        VALUES (${providerId}, ${providerLabel(providerId)}, ${userId})
        ON CONFLICT (id) DO NOTHING`,
  );
}
