import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpRouter } from "./route.ts";

let transportErrorHandler: ((error: Error) => void) | undefined;
let transportSend: ((message: unknown, options?: unknown) => Promise<void>) | undefined;

const routeMocks = vi.hoisted(() => {
  const mocks = {
    captureException: vi.fn(),
    createDofekMcpServer: vi.fn(),
    handleRequest: vi.fn(),
    loggerError: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    serverClose: vi.fn(),
    serverConnect: vi.fn(),
    transportClose: vi.fn(),
    transportConstructor: vi.fn(),
    validateMcpToken: vi.fn(),
  };
  return mocks;
});

interface MinimalResponse {
  status(code: number): {
    end(body?: string): void;
  };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null;
}

function isMinimalResponse(value: unknown): value is MinimalResponse {
  return isRecord(value) && typeof value.status === "function";
}

function sendResponse(response: unknown, code: number, body?: string): void {
  if (!isMinimalResponse(response)) {
    throw new Error("Expected Express response");
  }
  response.status(code).end(body);
}

function destroyResponse(response: unknown): void {
  if (
    typeof response !== "object" ||
    response === null ||
    !("destroy" in response) ||
    typeof response.destroy !== "function"
  ) {
    throw new Error("Expected a destroyable HTTP response");
  }
  response.destroy();
}

vi.mock("@sentry/node", () => ({
  captureException: routeMocks.captureException,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: routeMocks.loggerError,
    info: routeMocks.loggerInfo,
    warn: routeMocks.loggerWarn,
  },
}));

vi.mock("./token-repository.ts", () => ({
  validateMcpToken: routeMocks.validateMcpToken,
}));

vi.mock("./tools.ts", () => ({
  createDofekMcpServer: routeMocks.createDofekMcpServer,
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class MockStreamableHttpServerTransport {
    constructor(options: unknown) {
      routeMocks.transportConstructor(options);
    }

    close(): Promise<void> {
      return routeMocks.transportClose();
    }

    handleRequest(request: unknown, response: unknown, body: unknown): Promise<void> {
      return routeMocks.handleRequest(request, response, body);
    }

    get send(): (message: unknown, options?: unknown) => Promise<void> {
      return () => Promise.resolve();
    }

    set send(handler: (message: unknown, options?: unknown) => Promise<void>) {
      transportSend = handler;
    }

    set onerror(handler: (error: Error) => void) {
      transportErrorHandler = handler;
    }
  },
}));

function getPort(server: Server): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  body: unknown,
  authorization = "Bearer good-token",
): Promise<{ status: number; text: string }> {
  const app = express();
  app.use(
    "/api/mcp",
    createMcpRouter({
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
    }),
  );
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      fetch(`http://localhost:${getPort(server)}/api/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          ...(authorization ? { Authorization: authorization } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })
        .then(async (response) => {
          resolve({ status: response.status, text: await response.text() });
          server.close();
        })
        .catch((error: unknown) => {
          server.close();
          reject(error);
        });
    });
  });
}

describe("createMcpRouter lifecycle handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transportErrorHandler = undefined;
    transportSend = undefined;
    routeMocks.validateMcpToken.mockResolvedValue({
      expiresAt: null,
      oauthClientId: null,
      oauthResource: null,
      scopes: ["health:read"],
      tokenId: "token-id",
      userId: "user-id",
    });
    routeMocks.serverConnect.mockResolvedValue(undefined);
    routeMocks.serverClose.mockResolvedValue(undefined);
    routeMocks.transportClose.mockResolvedValue(undefined);
    routeMocks.createDofekMcpServer.mockReturnValue({
      close: routeMocks.serverClose,
      connect: routeMocks.serverConnect,
    });
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      sendResponse(response, 204);
      return Promise.resolve();
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("creates stateless transports and closes transport resources after successful requests", async () => {
    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await vi.waitFor(() => {
      expect(routeMocks.transportClose).toHaveBeenCalledTimes(1);
      expect(routeMocks.serverClose).toHaveBeenCalledTimes(1);
    });

    expect(response.status).toBe(204);
    expect(routeMocks.transportConstructor).toHaveBeenCalledWith({ sessionIdGenerator: undefined });
    expect(Object.keys(routeMocks.transportConstructor.mock.calls[0]?.[0] ?? {})).toEqual([
      "sessionIdGenerator",
    ]);
    expect(routeMocks.serverConnect).toHaveBeenCalledTimes(1);
    expect(routeMocks.handleRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(routeMocks.loggerInfo).not.toHaveBeenCalledWith("mcp.mutation", expect.anything());
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.authentication",
      expect.objectContaining({
        auth_outcome: "accepted",
        client_kind: "personal_token",
        mcp_method: "initialize",
        scope_set: "health:read",
      }),
    );
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({
        http_status: 204,
        mcp_method: "initialize",
        outcome: "completed",
        duration_ms: expect.any(Number),
      }),
    );
    expect(routeMocks.loggerInfo).not.toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({ outcome: "aborted" }),
    );
    expect(
      routeMocks.loggerInfo.mock.calls.some(
        ([event, payload]) =>
          event === "mcp.request" && isRecord(payload) && payload.duration_ms > 1_000,
      ),
    ).toBe(false);
  });

  it("records a bounded diagnostic when the bearer header is absent", async () => {
    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" }, "");

    expect(response.status).toBe(401);
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.authentication",
      expect.objectContaining({ auth_outcome: "missing_bearer", http_status: 401 }),
    );
  });

  it("records a bounded diagnostic when token validation rejects the request", async () => {
    routeMocks.validateMcpToken.mockResolvedValueOnce(null);
    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response.status).toBe(401);
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.authentication",
      expect.objectContaining({
        auth_outcome: "invalid_token",
        http_status: 401,
        mcp_method: "initialize",
      }),
    );
  });

  it("records a privacy-safe completion lifecycle for food mutations", async () => {
    const requestId = "33333333-3333-4333-8333-333333333333";
    const response = await request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_food_entry",
        arguments: { request_id: requestId },
      },
    });

    expect(response.status).toBe(204);
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith("mcp.mutation", {
      phase: "started",
      request_id_hash: "f6222a1106eefe4f6b25302a9d963cfaba14bedfefacc2c311967e41c61cffe4",
      tool_name: "create_food_entry",
    });
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith("mcp.mutation", {
      http_status: 204,
      phase: "completed",
      request_id_hash: "f6222a1106eefe4f6b25302a9d963cfaba14bedfefacc2c311967e41c61cffe4",
      tool_name: "create_food_entry",
    });
    expect(JSON.stringify(routeMocks.loggerInfo.mock.calls)).not.toContain(requestId);
  });

  it("classifies a completed HTTP 400 as a transport or protocol rejection", async () => {
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      sendResponse(response, 400, "rejected");
      return Promise.resolve();
    });

    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response).toEqual({ status: 400, text: "rejected" });
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({
        http_status: 400,
        mcp_method: "initialize",
        outcome: "transport_or_protocol_rejected",
      }),
    );
  });

  it("classifies non-400 HTTP failures and preserves sorted OAuth scope telemetry", async () => {
    routeMocks.validateMcpToken.mockResolvedValueOnce({
      expiresAt: null,
      oauthClientId: "oauth-client",
      oauthResource: null,
      scopes: ["nutrition:write", "nutrition:read"],
      tokenId: "token-id",
      userId: "user-id",
    });
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      sendResponse(response, 500, "failed");
      return Promise.resolve();
    });

    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response.status).toBe(500);
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.authentication",
      expect.objectContaining({
        client_kind: "oauth",
        scope_set: "nutrition:read,nutrition:write",
      }),
    );
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({ http_status: 500, outcome: "http_rejected" }),
    );
  });

  it("records an aborted request without a food mutation", async () => {
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      destroyResponse(response);
      return Promise.resolve();
    });

    await expect(request({ jsonrpc: "2.0", id: 1, method: "initialize" })).rejects.toThrow();

    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({ http_status: 200, mcp_method: "initialize", outcome: "aborted" }),
    );
    expect(
      routeMocks.loggerInfo.mock.calls.some(
        ([event, payload]) =>
          event === "mcp.request" && isRecord(payload) && payload.duration_ms > 1_000,
      ),
    ).toBe(false);
  });

  it("records SDK transport errors without retaining their text", async () => {
    const secret = "client supplied transport detail";
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      transportErrorHandler?.(new Error(`Unsupported Media Type: ${secret}`));
      sendResponse(response, 204);
      return Promise.resolve();
    });

    await request({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({
        error_category: "unsupported_media_type",
        outcome: "transport_error",
      }),
    );
    expect(JSON.stringify(routeMocks.loggerInfo.mock.calls)).not.toContain(secret);
  });

  it("records a valid tools/list transport result", async () => {
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      void transportSend?.({
        jsonrpc: "2.0",
        result: {
          tools: [
            { inputSchema: {}, name: "create_food_entry" },
            { inputSchema: {}, name: "search_food_entries" },
          ],
        },
      });
      sendResponse(response, 200);
      return Promise.resolve();
    });

    const response = await request({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(response.status).toBe(200);
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.tools_list",
      expect.objectContaining({
        expected_food_tools_present: true,
        has_next_page: false,
        jsonrpc_outcome: "result",
        tool_schema_valid: true,
        tools_count: 2,
      }),
    );
  });

  it("does not classify initialize responses as tools/list results", async () => {
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      void transportSend?.({
        jsonrpc: "2.0",
        result: { tools: [] },
      });
      sendResponse(response, 200);
      return Promise.resolve();
    });

    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response.status).toBe(200);
    expect(routeMocks.loggerInfo).not.toHaveBeenCalledWith("mcp.tools_list", expect.anything());
  });

  it("records an aborted lifecycle when a food-mutation client disconnects", async () => {
    const requestId = "33333333-3333-4333-8333-333333333333";
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      destroyResponse(response);
      return Promise.resolve();
    });

    await expect(
      request({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_food_entry",
          arguments: { request_id: requestId },
        },
      }),
    ).rejects.toThrow();

    expect(routeMocks.loggerInfo).toHaveBeenCalledWith("mcp.mutation", {
      http_status: 200,
      phase: "aborted",
      request_id_hash: "f6222a1106eefe4f6b25302a9d963cfaba14bedfefacc2c311967e41c61cffe4",
      tool_name: "create_food_entry",
    });
    expect(routeMocks.loggerInfo).not.toHaveBeenCalledWith(
      "mcp.mutation",
      expect.objectContaining({ phase: "completed" }),
    );
    expect(routeMocks.loggerInfo).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({ mcp_method: "tools/call", outcome: "aborted" }),
    );
    await vi.waitFor(() => {
      expect(routeMocks.transportClose).toHaveBeenCalledTimes(1);
      expect(routeMocks.serverClose).toHaveBeenCalledTimes(1);
    });
  });

  it("reports cleanup failures after the response closes", async () => {
    const transportError = new Error("transport close failed");
    const serverError = new Error("server close failed");
    routeMocks.transportClose.mockRejectedValueOnce(transportError);
    routeMocks.serverClose.mockRejectedValueOnce(serverError);

    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await vi.waitFor(() => {
      expect(routeMocks.captureException).toHaveBeenCalledWith(
        new Error("MCP transport cleanup failed"),
      );
      expect(routeMocks.captureException).toHaveBeenCalledWith(
        new Error("MCP server cleanup failed"),
      );
    });

    expect(response.status).toBe(204);
    expect(routeMocks.loggerWarn).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({ cleanup_target: "transport", outcome: "cleanup_failed" }),
    );
    expect(routeMocks.loggerWarn).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({ cleanup_target: "server", outcome: "cleanup_failed" }),
    );
  });

  it("returns a JSON-RPC server error when MCP handling fails before headers are sent", async () => {
    const connectError = new Error("connect failed");
    routeMocks.serverConnect.mockRejectedValueOnce(connectError);

    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response.status).toBe(500);
    expect(JSON.parse(response.text)).toEqual({
      error: { code: -32603, message: "MCP request failed." },
      id: null,
      jsonrpc: "2.0",
    });
    expect(routeMocks.captureException).toHaveBeenCalledWith(
      new Error("MCP request failed: transport_error"),
    );
  });

  it("does not write a JSON-RPC error after headers have already been sent", async () => {
    const secret = "private request content";
    const lateError = new Error(secret);
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      sendResponse(response, 202, "accepted");
      throw lateError;
    });

    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response).toEqual({ status: 202, text: "accepted" });
    expect(routeMocks.captureException).toHaveBeenCalledWith(
      new Error("MCP request failed: transport_error"),
    );
    expect(routeMocks.loggerError).toHaveBeenCalledWith(
      "mcp.request",
      expect.objectContaining({ error_category: "transport_error", outcome: "exception" }),
    );
    expect(JSON.stringify(routeMocks.loggerError.mock.calls)).not.toContain(secret);
  });
});
