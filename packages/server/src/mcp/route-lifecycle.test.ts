import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpRouter } from "./route.ts";

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
      expect.objectContaining({ http_status: 204, mcp_method: "initialize", outcome: "completed" }),
    );
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
