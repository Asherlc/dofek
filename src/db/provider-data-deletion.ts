import { sql } from "drizzle-orm";
import { z } from "zod";
import { type Database, executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const providerDataGenerationRowSchema = z.object({
  generation: z.coerce.number().int().nonnegative(),
  provider_id: z.string().min(1),
  user_id: z.guid(),
});
const providerDataDeletionRequestRowSchema = z.object({
  event_id: z.uuid(),
  generation: z.coerce.number().int().positive(),
  provider_id: z.string().min(1),
  user_id: z.uuid(),
});
const providerDataDeletionRequestStatusRowSchema = providerDataDeletionRequestRowSchema.extend({
  status: z.enum(["pending", "dispatched", "completed"]),
});

export interface ProviderDataDeletionRequest {
  eventId: string;
  generation: number;
  providerId: string;
  userId: string;
}

export interface ProviderDataDeletionRequestStatus extends ProviderDataDeletionRequest {
  status: "pending" | "dispatched" | "completed";
}

export interface ProviderDataScope {
  providerId: string;
  userId: string;
}

export interface ProviderDataGeneration extends ProviderDataScope {
  generation: number;
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

export async function getProviderDataGenerations(
  database: Database,
  scopes: readonly ProviderDataScope[],
): Promise<ProviderDataGeneration[]> {
  if (scopes.length === 0) return [];
  const requestedScopes = sql.join(
    scopes.map((scope) => sql`(${scope.userId}::uuid, ${scope.providerId}::text)`),
    sql`, `,
  );
  const rows = await executeWithSchema(
    database,
    providerDataGenerationRowSchema,
    sql`WITH requested_scope (user_id, provider_id) AS (
          VALUES ${requestedScopes}
        )
        SELECT
          requested_scope.user_id,
          requested_scope.provider_id,
          COALESCE(provider_data_generation.current_generation, 0) AS generation
        FROM requested_scope
        LEFT JOIN fitness.provider_data_generation
          ON provider_data_generation.user_id = requested_scope.user_id
          AND provider_data_generation.provider_id = requested_scope.provider_id`,
  );
  return rows.map((row) => ({
    generation: row.generation,
    providerId: row.provider_id,
    userId: row.user_id,
  }));
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

export async function findProviderDataDeletionRequest(
  database: Database,
  userId: string,
  providerId: string,
  eventId: string,
): Promise<ProviderDataDeletionRequestStatus | null> {
  const rows = await executeWithSchema(
    database,
    providerDataDeletionRequestStatusRowSchema,
    sql`SELECT event_id, user_id, provider_id, generation, status
        FROM fitness.provider_data_deletion_outbox
        WHERE event_id = ${eventId}::uuid
          AND user_id = ${userId}::uuid
          AND provider_id = ${providerId}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;
  return { ...mapProviderDataDeletionRequest(row), status: row.status };
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
