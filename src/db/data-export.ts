import { sql } from "drizzle-orm";
import { z } from "zod";
import { type Database, executeWithSchema } from "./typed-sql.ts";

const dataExportRequestRowSchema = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
});

export interface DataExportRequest {
  exportId: string;
  userId: string;
}

export async function listQueuedDataExportRequests(
  database: Database,
  limit: number,
): Promise<DataExportRequest[]> {
  const parsedLimit = z.number().int().positive().max(1_000).parse(limit);
  const rows = await executeWithSchema(
    database,
    dataExportRequestRowSchema,
    sql`
      SELECT export.id, export.user_id
      FROM fitness.data_export AS export
      WHERE export.status = 'queued'
        AND NOT EXISTS (
          SELECT 1
          FROM fitness.account_erasure_request AS erasure
          WHERE erasure.user_id = export.user_id
            AND erasure.status <> 'completed'
        )
      ORDER BY export.created_at, export.id
      LIMIT ${parsedLimit}
    `,
  );
  return rows.map((row) => ({ exportId: row.id, userId: row.user_id }));
}
