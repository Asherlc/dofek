import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../src/db/typed-sql.ts";

const legacyClientSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().nullable(),
  client_metadata: z.record(z.string(), z.unknown()),
  client_id_issued_at: z.coerce.number().nullable(),
  client_secret_expires_at: z.coerce.number().nullable(),
});

const PAGE_SIZE = 100;

/**
 * Copies previously registered Dofek OAuth clients into oidc-provider's
 * adapter in bounded pages. It is idempotent and runs after Postgres migrations
 * so deployments never expose the new OAuth routes before existing clients
 * have been imported. Legacy encrypted secrets keep their original encryption
 * context marker until the OIDC adapter reads and decrypts them.
 */
export async function backfillMcpOauthClients(
  database: Pick<Database, "execute">,
): Promise<number> {
  let afterClientId: string | null = null;
  let migrated = 0;

  while (true) {
    const clients = await executeWithSchema(
      database,
      legacyClientSchema,
      sql`SELECT client.client_id, client.client_secret, client.client_metadata,
                 client.client_id_issued_at, client.client_secret_expires_at
          FROM fitness.mcp_oauth_client AS client
          WHERE (${afterClientId}::text IS NULL OR client.client_id > ${afterClientId})
            AND NOT EXISTS (
              SELECT 1 FROM fitness.mcp_oidc_adapter AS adapter
              WHERE adapter.model = 'Client' AND adapter.id = client.client_id
            )
          ORDER BY client.client_id
          LIMIT ${PAGE_SIZE}`,
    );
    if (clients.length === 0) return migrated;

    for (const client of clients) {
      const payload = {
        ...client.client_metadata,
        client_id: client.client_id,
        ...(client.client_secret === null ? {} : { client_secret: client.client_secret }),
        ...(client.client_id_issued_at === null
          ? {}
          : { client_id_issued_at: client.client_id_issued_at }),
        ...(client.client_secret_expires_at === null
          ? {}
          : { client_secret_expires_at: client.client_secret_expires_at }),
        ...(client.client_secret === null ? {} : { dofekLegacyEncryptedClientSecret: true }),
      };

      await database.execute(
        sql`INSERT INTO fitness.mcp_oidc_adapter (model, id, payload)
            VALUES ('Client', ${client.client_id}, ${payload})
            ON CONFLICT (model, id) DO NOTHING`,
      );
      migrated += 1;
      afterClientId = client.client_id;
    }
  }
}
