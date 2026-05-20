import type { AddressInfo } from "node:net";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpRouter } from "./route.ts";
import { validateMcpToken } from "./token-repository.ts";
import { createDofekMcpServer } from "./tools.ts";

vi.mock("./token-repository.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./token-repository.ts")>();
  return {
    ...original,
    validateMcpToken: vi.fn(),
  };
});

vi.mock("./tools.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./tools.ts")>();
  return {
    ...original,
    createDofekMcpServer: vi.fn(original.createDofekMcpServer),
  };
});

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  app: express.Express,
  input: {
    body?: unknown;
    authorization?: string;
    rawBody?: string;
    timezone?: string;
  },
): Promise<{ headers: Headers; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}/api/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(input.authorization ? { Authorization: input.authorization } : {}),
          ...(input.timezone ? { "X-Timezone": input.timezone } : {}),
        },
        body: input.rawBody ?? JSON.stringify(input.body),
      })
        .then(async (response) => {
          const text = await response.text();
          resolve({
            headers: response.headers,
            status: response.status,
            text,
          });
          server.close();
        })
        .catch((error: unknown) => {
          server.close();
          reject(error);
        });
    });
  });
}

function createTestApp() {
  const app = express();
  app.use("/api/mcp", createMcpRouter({ db: { execute: vi.fn(), select: vi.fn() } }));
  return app;
}

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  },
};

describe("createMcpRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateMcpToken).mockResolvedValue(null);
  });

  it("returns 401 with a bearer challenge when Authorization is missing", async () => {
    const response = await request(createTestApp(), { body: initializeRequest });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("returns 401 before parsing JSON when Authorization is missing", async () => {
    const response = await request(createTestApp(), { rawBody: "{" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const response = await request(createTestApp(), {
      authorization: "Bearer bad-token",
      body: initializeRequest,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("initializes MCP for a valid token", async () => {
    vi.mocked(validateMcpToken).mockResolvedValue({
      tokenId: "token-id",
      userId: "user-id",
      scopes: ["health:read", "activity:read", "nutrition:write", "providers:read", "sync:write"],
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: initializeRequest,
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("dofek");
  });

  it("passes the request timezone into the MCP context", async () => {
    vi.mocked(validateMcpToken).mockResolvedValue({
      tokenId: "token-id",
      userId: "user-id",
      scopes: ["health:read", "activity:read", "nutrition:write", "providers:read", "sync:write"],
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: initializeRequest,
      timezone: "America/Los_Angeles",
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(createDofekMcpServer)).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/Los_Angeles" }),
    );
  });

  it("lists Dofek MCP tools for a valid token", async () => {
    vi.mocked(validateMcpToken).mockResolvedValue({
      tokenId: "token-id",
      userId: "user-id",
      scopes: ["health:read", "activity:read", "nutrition:write", "providers:read", "sync:write"],
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("get_daily_health_summary");
    expect(response.text).toContain("start_provider_sync");
  });

  it("returns tool-level insufficient scope errors", async () => {
    vi.mocked(validateMcpToken).mockResolvedValue({
      tokenId: "token-id",
      userId: "user-id",
      scopes: ["health:read"],
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer read-only-token",
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "start_provider_sync",
          arguments: { providerId: "wahoo" },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("requires scope: sync:write");
  });
});
