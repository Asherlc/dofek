import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TransactionDatabase } from "../db/index.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { type familySchema, identifierSchema } from "./retained-state.ts";

export const ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE = 500;

/** Distinct request-owned roots, ordered and bounded before encryption. */
export async function* listAccountErasurePostgresIdentifierPages(
  transaction: Pick<TransactionDatabase, "execute">,
  userId: string,
): AsyncGenerator<{ family: z.infer<typeof familySchema>; identifiers: string[] }> {
  const sources = [
    { family: "activity", table: sql`fitness.activity`, column: sql`id` },
    { family: "activity", table: sql`fitness.activity`, column: sql`group_id` },
    { family: "activity", table: sql`fitness.activity_group`, column: sql`id` },
    { family: "activity", table: sql`fitness.activity_group`, column: sql`anchor_activity_id` },
    { family: "activity", table: sql`fitness.activity_group_alias`, column: sql`alias_id` },
    { family: "activity", table: sql`fitness.activity_group_alias`, column: sql`group_id` },
    { family: "sleep", table: sql`fitness.sleep_session`, column: sql`id` },
    { family: "operation", table: sql`fitness.processing_operation`, column: sql`id` },
  ] as const;
  for (const family of ["activity", "sleep", "operation"] as const) {
    const identifiers = sql.join(
      sources
        .filter((source) => source.family === family)
        .map(
          (source) => sql`
      SELECT ${source.column} AS id FROM ${source.table}
      WHERE user_id=${userId}::uuid AND ${source.column} IS NOT NULL`,
        ),
      sql` UNION `,
    );
    let after: string | undefined;
    while (true) {
      const rows = await executeWithSchema(
        transaction,
        z.object({ id: identifierSchema }),
        sql`WITH identifiers AS (${identifiers})
          SELECT id FROM identifiers
          ${after === undefined ? sql`` : sql`WHERE id>${after}::uuid`}
          ORDER BY id LIMIT ${ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE}`,
      );
      if (rows.length === 0) break;
      yield { family, identifiers: rows.map((row) => row.id) };
      if (rows.length < ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE) break;
      after = rows.at(-1)?.id;
    }
  }
}
