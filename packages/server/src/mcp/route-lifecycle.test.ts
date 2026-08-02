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

vi.mock("@sentry/node", () => ({
  captureException: routeMocks.captureException,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: routeMocks.loggerError,
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

async function request(body: unknown): Promise<{ status: number; text: string }> {
  const app = express();
  app.use(
    "/api/mcp",
    createMcpRouter({ db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() } }),
  );

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      fetch(`http://localhost:${getPort(server)}/api/mcp`, {
        method: "POST",
        headers: {
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer good-token",
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
  });

  it("reports cleanup failures after the response closes", async () => {
    const transportError = new Error("transport close failed");
    const serverError = new Error("server close failed");
    routeMocks.transportClose.mockRejectedValueOnce(transportError);
    routeMocks.serverClose.mockRejectedValueOnce(serverError);

    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await vi.waitFor(() => {
      expect(routeMocks.captureException).toHaveBeenCalledWith(transportError);
      expect(routeMocks.captureException).toHaveBeenCalledWith(serverError);
    });

    expect(response.status).toBe(204);
    expect(routeMocks.loggerWarn).toHaveBeenCalledWith(
      `[mcp] Failed to close transport: ${transportError}`,
    );
    expect(routeMocks.loggerWarn).toHaveBeenCalledWith(
      `[mcp] Failed to close server: ${serverError}`,
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
    expect(routeMocks.captureException).toHaveBeenCalledWith(connectError);
  });

  it("does not write a JSON-RPC error after headers have already been sent", async () => {
    const lateError = new Error("late failure");
    routeMocks.handleRequest.mockImplementation((_request: unknown, response: unknown) => {
      sendResponse(response, 202, "accepted");
      throw lateError;
    });

    const response = await request({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(response).toEqual({ status: 202, text: "accepted" });
    expect(routeMocks.captureException).toHaveBeenCalledWith(lateError);
    expect(routeMocks.loggerError).toHaveBeenCalledWith(
      "[mcp] Request failed: Error: late failure",
    );
  });
});
