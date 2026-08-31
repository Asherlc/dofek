import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

import {
  McpOAuthClientMetadataResolver,
  parseCimdClientMetadata,
} from "./oauth-client-metadata.ts";

const clientId = "https://claude.ai/oauth/client-metadata.json";

describe("parseCimdClientMetadata", () => {
  afterEach(() => vi.resetAllMocks());
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

  it("resolves and caches a public HTTPS metadata document", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(
      (_options: unknown, callback: (response: EventEmitter) => void) => {
        const request = Object.assign(new EventEmitter(), { end: () => {} });
        request.end = () => {
          const response = Object.assign(new EventEmitter(), {
            headers: { "cache-control": "max-age=60", "content-type": "application/json" },
            resume: vi.fn(),
            statusCode: 200,
          });
          callback(response);
          response.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                client_id: clientId,
                redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
              }),
            ),
          );
          response.emit("end");
        };
        return request;
      },
    );

    const resolver = new McpOAuthClientMetadataResolver();
    await expect(resolver.getClient(clientId)).resolves.toMatchObject({ client_id: clientId });
    await expect(resolver.getClient(clientId)).resolves.toMatchObject({ client_id: clientId });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("rejects private DNS destinations without opening a request", async () => {
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const resolver = new McpOAuthClientMetadataResolver();
    await expect(resolver.getClient(clientId)).resolves.toBeUndefined();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects an empty DNS result without opening a request", async () => {
    mocks.lookup.mockResolvedValue([]);
    await expect(new McpOAuthClientMetadataResolver().getClient(clientId)).resolves.toBeUndefined();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects an invalid HTTPS response", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(
      (_options: unknown, callback: (response: EventEmitter) => void) => {
        const request = Object.assign(new EventEmitter(), { end: () => {} });
        request.end = () =>
          callback(
            Object.assign(new EventEmitter(), { headers: {}, resume: vi.fn(), statusCode: 500 }),
          );
        return request;
      },
    );
    await expect(new McpOAuthClientMetadataResolver().getClient(clientId)).resolves.toBeUndefined();
  });

  it("rejects HTTPS transport errors", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(() => {
      const request = Object.assign(new EventEmitter(), { end: () => {} });
      request.end = () => request.emit("error", new Error("network"));
      return request;
    });
    await expect(new McpOAuthClientMetadataResolver().getClient(clientId)).resolves.toBeUndefined();
  });

  it.each(["not a URL", "http://claude.ai/metadata.json", "https://claude.ai/"])(
    "does not resolve an invalid CIMD client ID: %s",
    async (invalidClientId) => {
      await expect(
        new McpOAuthClientMetadataResolver().getClient(invalidClientId),
      ).resolves.toBeUndefined();
      expect(mocks.lookup).not.toHaveBeenCalled();
    },
  );
});
