import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface McpOAuthClientMetadataSource {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
}

function isHostedClientMetadataUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.pathname !== "/";
  } catch {
    return false;
  }
}

export class McpOAuthClientResolver implements OAuthRegisteredClientsStore {
  readonly #registeredClients: OAuthRegisteredClientsStore;
  readonly #metadata: McpOAuthClientMetadataSource;

  constructor(
    registeredClients: OAuthRegisteredClientsStore,
    metadata: McpOAuthClientMetadataSource,
  ) {
    this.#registeredClients = registeredClients;
    this.#metadata = metadata;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return isHostedClientMetadataUrl(clientId)
      ? this.#metadata.getClient(clientId)
      : await this.#registeredClients.getClient(clientId);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    if (!this.#registeredClients.registerClient) {
      throw new Error("Dynamic client registration is not configured");
    }
    return this.#registeredClients.registerClient(client);
  }
}
