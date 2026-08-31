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
});
