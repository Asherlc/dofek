import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TokenSet } from "../../auth/oauth.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { findTokenUsersByProviderAccountId } from "../../db/tokens.ts";
import { executeWithSchema } from "../../db/typed-sql.ts";
import { deriveCredentialIdentifier } from "../../security/credential-encryption.ts";
import { ProviderAuthorizationAlreadyOwnedError } from "../auth-errors.ts";

const deliveryStateSchema = z.object({
  generation: z.coerce.number().int().nonnegative(),
  pendingDeletion: z.boolean(),
});

export async function assertGarminAuthorizationOwner(
  db: SyncDatabase,
  userId: string,
  tokens: TokenSet,
): Promise<void> {
  const providerAccountId = tokens.providerAccountId?.trim();
  if (!providerAccountId) throw new Error("Garmin connection requires its official account ID");
  const lockId = deriveCredentialIdentifier(providerAccountId, {
    tableName: "fitness.oauth_token",
    columnName: "authorization_owner_lock",
    scopeId: "garmin",
  });
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockId}, 0))`);
  const owners = await findTokenUsersByProviderAccountId(db, "garmin", providerAccountId);
  if (owners.some((owner) => owner !== userId)) {
    throw new ProviderAuthorizationAlreadyOwnedError("Garmin");
  }
}

export async function readGarminDeliveryState(
  db: Pick<SyncDatabase, "execute">,
  userId: string,
): Promise<{ generation: number; pendingDeletion: boolean }> {
  const [state] = await executeWithSchema(
    db,
    deliveryStateSchema,
    sql`
    SELECT COALESCE((
      SELECT current_generation FROM fitness.provider_data_generation
      WHERE user_id = ${userId}::uuid AND provider_id = 'garmin'
    ), 0) AS generation,
    EXISTS (
      SELECT 1 FROM fitness.provider_data_deletion_outbox
      WHERE user_id = ${userId}::uuid AND provider_id = 'garmin' AND status <> 'completed'
    ) AS "pendingDeletion"
  `,
  );
  if (!state) throw new Error("Garmin delivery state could not be loaded");
  return state;
}
