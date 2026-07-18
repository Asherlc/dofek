import { sql } from "drizzle-orm";
import { z } from "zod";
import { type Database, executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const generationRowSchema = z.object({ generation: z.coerce.number().int().nonnegative() });
const providerDataDeletionRequestRowSchema = z.object({
  event_id: z.uuid(),
  generation: z.coerce.number().int().positive(),
  provider_id: z.string().min(1),
  user_id: z.uuid(),
});

export interface ProviderDataDeletionRequest {
  eventId: string;
  generation: number;
  providerId: string;
  userId: string;
}

function mapProviderDataDeletionRequest(
  row: z.infer<typeof providerDataDeletionRequestRowSchema>,
): ProviderDataDeletionRequest {
  return {
    eventId: row.event_id,
    generation: row.generation,
    providerId: row.provider_id,
    userId: row.user_id,
  };
}

export async function getProviderDataGeneration(
  database: Database,
  userId: string,
  providerId: string,
): Promise<number> {
  const rows = await executeWithSchema(
    database,
    generationRowSchema,
    sql`SELECT current_generation AS generation
        FROM fitness.provider_data_generation
        WHERE user_id = ${userId} AND provider_id = ${providerId}`,
  );
  return rows[0]?.generation ?? 0;
}

export async function createProviderDataDeletionRequest(
  database: SchemaExecutionDatabase,
  userId: string,
  providerId: string,
  eventId: string,
): Promise<ProviderDataDeletionRequest> {
  const rows = await executeWithSchema(
    database,
    providerDataDeletionRequestRowSchema,
    sql`WITH advanced_generation AS (
          INSERT INTO fitness.provider_data_generation (
            user_id, provider_id, current_generation, updated_at
          )
          VALUES (${userId}, ${providerId}, 1, now())
          ON CONFLICT (user_id, provider_id) DO UPDATE SET
            current_generation = fitness.provider_data_generation.current_generation + 1,
            updated_at = now()
          RETURNING current_generation
        )
        INSERT INTO fitness.provider_data_deletion_outbox (
          event_id, user_id, provider_id, generation
        )
        SELECT ${eventId}::uuid, ${userId}::uuid, ${providerId}, current_generation
        FROM advanced_generation
        RETURNING event_id, user_id, provider_id, generation`,
  );
  const request = rows[0];
  if (!request) {
    throw new Error("Failed to create provider data deletion outbox request");
  }
  return mapProviderDataDeletionRequest(request);
}

export async function listPendingProviderDataDeletionRequests(
  database: Database,
  limit: number,
): Promise<ProviderDataDeletionRequest[]> {
  const parsedLimit = z.number().int().positive().max(1_000).parse(limit);
  const rows = await executeWithSchema(
    database,
    providerDataDeletionRequestRowSchema,
    sql`SELECT event_id, user_id, provider_id, generation
        FROM fitness.provider_data_deletion_outbox
        WHERE status = 'pending'
        ORDER BY created_at, event_id
        LIMIT ${parsedLimit}`,
  );
  return rows.map(mapProviderDataDeletionRequest);
}

export async function markProviderDataDeletionDispatched(
  database: Database,
  eventId: string,
): Promise<void> {
  await database.execute(
    sql`UPDATE fitness.provider_data_deletion_outbox
        SET status = 'dispatched', dispatched_at = now()
        WHERE event_id = ${eventId}::uuid AND status = 'pending'`,
  );
}

export async function markProviderDataDeletionCompleted(
  database: Database,
  eventId: string,
): Promise<void> {
  await database.execute(
    sql`UPDATE fitness.provider_data_deletion_outbox
        SET status = 'completed', completed_at = now()
        WHERE event_id = ${eventId}::uuid AND status <> 'completed'`,
  );
}
