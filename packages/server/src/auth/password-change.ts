import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../lib/typed-sql.ts";

export async function revokePasswordChangeAuthenticationMaterial(
  db: SqlExecutor,
  userId: string,
): Promise<void> {
  await db.execute(sql`DELETE FROM fitness.session WHERE user_id = ${userId}`);
  await db.execute(
    sql`UPDATE fitness.password_reset_token
        SET consumed_at = NOW()
        WHERE user_id = ${userId} AND consumed_at IS NULL`,
  );
}
