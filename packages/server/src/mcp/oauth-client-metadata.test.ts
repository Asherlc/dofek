import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loggerWarn: vi.fn(), lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("../logger.ts", () => ({ logger: { warn: mocks.loggerWarn } }));

import {
  McpOAuthClientMetadataResolver,
  parseCimdClientMetadata,
} from "./oauth-client-metadata.ts";

const clientId = "https://claude.ai/oauth/client-metadata.json";
const chatGptClientId = "https://chatgpt.com/oauth/client.json";

function mockValidMetadataResponse(cacheControl = "max-age=60") {
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.request.mockImplementation(
    (options: { path: string; servername: string }, callback: (response: EventEmitter) => void) => {
      const request = Object.assign(new EventEmitter(), { end: () => {} });
      request.end = () => {
        const response = Object.assign(new EventEmitter(), {
          headers: { "cache-control": cacheControl, "content-type": "application/json" },
          resume: vi.fn(),
          statusCode: 200,
        });
        callback(response);
        response.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              client_id: `https://${options.servername}${options.path}`,
              redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
            }),
          ),
        );
        response.emit("end");
      };
      return request;
    },
  );
}

describe("parseCimdClientMetadata", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  it("loads in Node's strip-only TypeScript runtime", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        "await import('./oauth-client-metadata.ts')",
      ],
      { cwd: new URL(".", import.meta.url), encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
  });

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

  it("accepts ChatGPT CIMD metadata by selecting its supported public-client method", () => {
    expect(
      parseCimdClientMetadata(chatGptClientId, {
        client_id: chatGptClientId,
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        jwks_uri: "https://chatgpt.com/oauth/jwks.json",
        token_endpoint_auth_method: "private_key_jwt",
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      }),
    ).toMatchObject({
      client_id: chatGptClientId,
      token_endpoint_auth_method: "none",
    });
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

  it("rejects metadata that advertises no Dofek-supported token authentication method", () => {
    expect(() =>
      parseCimdClientMetadata(chatGptClientId, {
        client_id: chatGptClientId,
        redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
        token_endpoint_auth_method: "none",
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
      }),
    ).toThrow("no supported token endpoint authentication method");
  });

  it("resolves and caches a public HTTPS metadata document", async () => {
    mockValidMetadataResponse();

    const resolver = new McpOAuthClientMetadataResolver();
    await expect(resolver.getClient(clientId)).resolves.toMatchObject({ client_id: clientId });
    await expect(resolver.getClient(clientId)).resolves.toMatchObject({ client_id: clientId });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it("prunes expired entries before caching another metadata document", async () => {
    vi.useFakeTimers();
    mockValidMetadataResponse("max-age=1");
    const deleteSpy = vi.spyOn(Map.prototype, "delete");
    const resolver = new McpOAuthClientMetadataResolver();
    await resolver.getClient(clientId);
    await vi.advanceTimersByTimeAsync(1_000);
    await resolver.getClient("https://claude.ai/oauth/another-client.json");
    expect(deleteSpy).toHaveBeenCalledWith(clientId);
  });

  it("evicts the oldest cached client after reaching the entry limit", async () => {
    mockValidMetadataResponse();
    const resolver = new McpOAuthClientMetadataResolver();
    const oldestClientId = "https://claude.ai/oauth/client-0.json";
    const clientIds = [
      oldestClientId,
      ...Array.from(
        { length: 100 },
        (_, index) => `https://claude.ai/oauth/client-${index + 1}.json`,
      ),
    ];
    for (const id of clientIds) await resolver.getClient(id);
    await resolver.getClient(oldestClientId);
    expect(mocks.lookup).toHaveBeenCalledTimes(102);
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

  it("rejects DNS resolution failures without opening a request", async () => {
    mocks.lookup.mockRejectedValue(new Error("ENOTFOUND"));
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

  it("rejects malformed JSON metadata", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(
      (_options: unknown, callback: (response: EventEmitter) => void) => {
        const request = Object.assign(new EventEmitter(), { end: () => {} });
        request.end = () => {
          const response = Object.assign(new EventEmitter(), {
            headers: { "content-type": "application/json" },
            resume: vi.fn(),
            statusCode: 200,
          });
          callback(response);
          response.emit("data", Buffer.from("{"));
          response.emit("end");
        };
        return request;
      },
    );
    await expect(new McpOAuthClientMetadataResolver().getClient(clientId)).resolves.toBeUndefined();
  });

  it("logs only a sanitized client identifier and stable reason for expected metadata rejection", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(
      (_options: unknown, callback: (response: EventEmitter) => void) => {
        const request = Object.assign(new EventEmitter(), { end: () => {} });
        request.end = () => {
          const response = Object.assign(new EventEmitter(), {
            headers: { "content-type": "application/json" },
            resume: vi.fn(),
            statusCode: 200,
          });
          callback(response);
          response.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                client_id: chatGptClientId,
                client_secret: "must-not-appear-in-logs",
                redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
              }),
            ),
          );
          response.emit("end");
        };
        return request;
      },
    );

    await expect(
      new McpOAuthClientMetadataResolver().getClient(chatGptClientId),
    ).resolves.toBeUndefined();

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "[mcp] CIMD metadata rejected clientHost=chatgpt.com reason=client_secret_not_allowed",
    );
  });

  it("rejects a successful response without JSON content type", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(
      (_options: unknown, callback: (response: EventEmitter) => void) => {
        const request = Object.assign(new EventEmitter(), { end: () => {} });
        request.end = () =>
          callback(
            Object.assign(new EventEmitter(), { headers: {}, resume: vi.fn(), statusCode: 200 }),
          );
        return request;
      },
    );
    await expect(new McpOAuthClientMetadataResolver().getClient(clientId)).resolves.toBeUndefined();
  });

  it("rejects an oversized metadata response", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(
      (_options: unknown, callback: (response: EventEmitter) => void) => {
        const request = Object.assign(new EventEmitter(), { end: () => {} });
        request.end = () => {
          const response = Object.assign(new EventEmitter(), {
            headers: { "content-type": "application/json" },
            resume: vi.fn(),
            statusCode: 200,
          });
          response.destroy = (error: Error) => response.emit("error", error);
          callback(response);
          response.emit("data", Buffer.alloc(65_537));
        };
        return request;
      },
    );
    await expect(new McpOAuthClientMetadataResolver().getClient(clientId)).resolves.toBeUndefined();
  });

  it("rejects a response with multiple DNS addresses when one is private", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(new McpOAuthClientMetadataResolver().getClient(clientId)).resolves.toBeUndefined();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("does not cache a response with max-age zero", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(
      (_options: unknown, callback: (response: EventEmitter) => void) => {
        const request = Object.assign(new EventEmitter(), { end: () => {} });
        request.end = () => {
          const response = Object.assign(new EventEmitter(), {
            headers: { "cache-control": "max-age=0", "content-type": "application/json" },
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
    await resolver.getClient(clientId);
    await resolver.getClient(clientId);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
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

  it("rethrows an unexpected synchronous HTTPS request error without logging a rejection", async () => {
    const error = new Error("unexpected request failure");
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    mocks.request.mockImplementation(() => {
      throw error;
    });

    await expect(new McpOAuthClientMetadataResolver().getClient(clientId)).rejects.toBe(error);
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it("cancels an HTTPS request when metadata resolution times out", async () => {
    vi.useFakeTimers();
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    const destroy = vi.fn();
    mocks.request.mockImplementation(() => {
      const request = Object.assign(new EventEmitter(), { destroy, end: () => {} });
      return request;
    });
    const resolution = new McpOAuthClientMetadataResolver().getClient(clientId);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(resolution).resolves.toBeUndefined();
    const [timeoutError] = destroy.mock.calls[0] ?? [];
    expect(timeoutError).toBeInstanceOf(Error);
    expect(timeoutError).toHaveProperty("message", "CIMD metadata request timed out");
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
