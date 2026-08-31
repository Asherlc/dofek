import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { describe, expect, it } from "vitest";
import { McpOAuthClientResolver } from "./oauth-client-resolver.ts";

const claudeClientId = "https://claude.ai/oauth/client-metadata.json";
const hostedClient: OAuthClientInformationFull = {
  client_id: claudeClientId,
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none",
};
const registeredClient: OAuthClientInformationFull = {
  client_id: "registered-client",
  client_secret: "registered-secret",
  redirect_uris: ["https://client.example/callback"],
};

describe("McpOAuthClientResolver", () => {
  it("uses hosted metadata for a URL client ID", async () => {
    const resolver = new McpOAuthClientResolver(
      {
        getClient: async () => registeredClient,
        registerClient: async () => registeredClient,
      },
      { getClient: async () => hostedClient },
    );

    await expect(resolver.getClient(claudeClientId)).resolves.toEqual(hostedClient);
  });

  it.each([
    "registered-client",
    "https://claude.ai/",
    "http://claude.ai/metadata.json",
    "not a URL",
  ])("uses dynamic registration for a non-hosted metadata client ID: %s", async (clientId) => {
    const registeredClients = {
      getClient: async () => registeredClient,
      registerClient: async () => registeredClient,
    };
    const metadata = { getClient: async () => hostedClient };
    const resolver = new McpOAuthClientResolver(registeredClients, metadata);

    await expect(resolver.getClient(clientId)).resolves.toEqual(registeredClient);
  });

  it("delegates dynamic client registration", async () => {
    const registerClient = async () => registeredClient;
    const resolver = new McpOAuthClientResolver(
      { getClient: async () => registeredClient, registerClient },
      { getClient: async () => hostedClient },
    );

    await expect(
      resolver.registerClient({ redirect_uris: ["https://client.example/callback"] }),
    ).resolves.toEqual(registeredClient);
  });

  it("fails when dynamic client registration is unavailable", async () => {
    const resolver = new McpOAuthClientResolver(
      { getClient: async () => registeredClient },
      { getClient: async () => hostedClient },
    );

    await expect(
      resolver.registerClient({ redirect_uris: ["https://client.example/callback"] }),
    ).rejects.toThrow("not configured");
  });
});
