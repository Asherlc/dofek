import { describe, expect, it } from "vitest";
import { parseCimdClientMetadata } from "./oauth-client-metadata.ts";

const clientId = "https://claude.ai/oauth/client-metadata.json";

describe("parseCimdClientMetadata", () => {
  it("accepts a public client whose metadata client ID and callback match", () => {
    expect(
      parseCimdClientMetadata(clientId, {
        client_id: clientId,
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: "none",
      }),
    ).toMatchObject({ client_id: clientId, client_name: "Claude" });
  });

  it("rejects a document that claims a different client ID", () => {
    expect(() =>
      parseCimdClientMetadata(clientId, {
        client_id: "https://attacker.example/client.json",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    ).toThrow("client_id");
  });

  it.each([null, [], "metadata"])("rejects a non-object metadata document: %j", (metadata) => {
    expect(() => parseCimdClientMetadata(clientId, metadata)).toThrow("JSON object");
  });

  it("rejects a confidential client", () => {
    expect(() =>
      parseCimdClientMetadata(clientId, {
        client_id: clientId,
        client_secret: "secret",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    ).toThrow("client_secret");
  });

  it.each([
    ["client credentials", "client_secret_basic"],
    ["missing callbacks", "none", []],
    ["unapproved callback", "none", ["http://attacker.example/callback"]],
  ])("rejects metadata with %s", (_description, tokenEndpointAuthMethod, redirectUris) => {
    expect(() =>
      parseCimdClientMetadata(clientId, {
        client_id: clientId,
        redirect_uris: redirectUris ?? ["https://claude.ai/api/mcp/auth_callback"],
        token_endpoint_auth_method: tokenEndpointAuthMethod,
      }),
    ).toThrow();
  });

  it("accepts a public client that omits the optional token authentication method", () => {
    expect(
      parseCimdClientMetadata(clientId, {
        client_id: clientId,
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    ).toMatchObject({ client_id: clientId });
  });
});
