import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import {
  type OAuthClientInformationFull,
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Database } from "dofek/db";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "dofek/security/credential-encryption";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const CLAUDE_REDIRECT_URIS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

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

function validateClaudeRedirectUris(redirectUris: readonly string[]): void {
  if (
    redirectUris.length === 0 ||
    redirectUris.some((redirectUri) => !CLAUDE_REDIRECT_URIS.has(redirectUri))
  ) {
    throw new InvalidClientMetadataError("Only Claude OAuth callback URLs are supported");
  }
}

export class McpOAuthClientsStore implements OAuthRegisteredClientsStore {
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

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    validateClaudeRedirectUris(client.redirect_uris);
    const clientMetadata = OAuthClientMetadataSchema.parse(client);
    const encryptedClientSecret = client.client_secret
      ? await encryptCredentialValue(client.client_secret, clientSecretContext(client.client_id))
      : null;

    await this.#db.execute(
      sql`INSERT INTO fitness.mcp_oauth_client (
            client_id, client_secret, client_metadata, client_id_issued_at,
            client_secret_expires_at
          ) VALUES (
            ${client.client_id}, ${encryptedClientSecret}, ${clientMetadata},
            ${client.client_id_issued_at ?? null}, ${client.client_secret_expires_at ?? null}
          )`,
    );
    return client;
  }
}
