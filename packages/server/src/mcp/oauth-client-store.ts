import {
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
} from "@modelcontextprotocol/core";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/server";
import type { Database } from "dofek/db";
import { decryptCredentialValue } from "dofek/security/credential-encryption";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const oauthClientRowSchema = z.object({
  client_id: z.string(),
  client_id_issued_at: z.coerce.number().nullable(),
  client_metadata: OAuthClientMetadataSchema,
  client_secret: z.string().nullable(),
  client_secret_expires_at: z.coerce.number().nullable(),
});

function clientSecretContext(clientId: string) {
  return {
    columnName: "client_secret",
    scopeId: clientId,
    tableName: "fitness.mcp_oauth_client",
  };
}

/**
 * Read access to `fitness.mcp_oauth_client` for the CIMD well-known document.
 *
 * Client registration (DCR) is now handled by oidc-provider, which persists to
 * its own adapter table; this store serves the CIMD `/.well-known/oauth-client`
 * read endpoint for locally registered clients only.
 */
export class McpOAuthClientsStore {
  readonly #db: Pick<Database, "execute">;

  constructor(db: Pick<Database, "execute">) {
    this.#db = db;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const rows = await executeWithSchema(
      this.#db,
      oauthClientRowSchema,
      sql`SELECT client_id, client_secret, client_metadata, client_id_issued_at,
                 client_secret_expires_at
          FROM fitness.mcp_oauth_client
          WHERE client_id = ${clientId}
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return undefined;

    const clientSecret = row.client_secret
      ? await decryptCredentialValue(row.client_secret, clientSecretContext(clientId))
      : undefined;
    return OAuthClientInformationFullSchema.parse({
      ...row.client_metadata,
      client_id: row.client_id,
      client_id_issued_at: row.client_id_issued_at ?? undefined,
      client_secret: clientSecret,
      client_secret_expires_at: row.client_secret_expires_at ?? undefined,
    });
  }
}
