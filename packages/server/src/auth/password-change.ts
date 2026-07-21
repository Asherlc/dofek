import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";

export async function revokePasswordChangeAuthenticationMaterial(
  db: Pick<Database, "execute">,
  userId: string,
): Promise<void> {
  await db.execute(sql`DELETE FROM fitness.session WHERE user_id = ${userId}`);
  await db.execute(
    sql`UPDATE fitness.password_reset_token
        SET consumed_at = NOW()
        WHERE user_id = ${userId} AND consumed_at IS NULL`,
  );
}
