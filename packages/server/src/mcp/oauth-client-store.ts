import {
  OAuthClientInformationFullSchema,
  OAuthClientMetadataSchema,
} from "@modelcontextprotocol/core";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/server";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import type { Database } from "dofek/db";
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "dofek/security/credential-encryption";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

/** Loopback hosts allowed to use http:// redirect URIs (OAuth 2.1 / RFC 8252). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Dofek-local replacement for the removed v1 SDK `InvalidClientMetadataError`.
 * The v2 SDK exposes no equivalent class; registration metadata is instead
 * rejected by oidc-provider and this error is raised by the local client store.
 */
export class InvalidClientMetadataError extends OAuthError {
  constructor(message: string) {
    super(OAuthErrorCode.InvalidClientMetadata, message);
  }
}

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
 * Accept any absolute https redirect URI, plus http on loopback hosts for local
 * MCP clients. Reject dangerous schemes, fragments, and credentials in the URI.
 */
export function isAllowedMcpOAuthRedirectUri(redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (!url.hostname) return false;

  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return false;
}

function validateRedirectUris(redirectUris: readonly string[]): void {
  if (redirectUris.length === 0) {
    throw new InvalidClientMetadataError("At least one redirect_uri is required");
  }
  for (const redirectUri of redirectUris) {
    if (!isAllowedMcpOAuthRedirectUri(redirectUri)) {
      throw new InvalidClientMetadataError("Invalid redirect_uri");
    }
  }
}

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

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    validateRedirectUris(client.redirect_uris);
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
