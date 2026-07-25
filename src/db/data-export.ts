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
      SELECT id, user_id
      FROM fitness.data_export
      WHERE status = 'queued'
      ORDER BY created_at, id
      LIMIT ${parsedLimit}
    `,
  );
  return rows.map((row) => ({ exportId: row.id, userId: row.user_id }));
}
