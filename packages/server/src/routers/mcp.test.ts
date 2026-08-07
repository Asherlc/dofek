import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashMcpToken } from "../mcp/token-repository.ts";
import { mcpRouter } from "./mcp.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(mcpRouter);
const mockExecute = vi.fn();

function createContext(userId: string | null) {
  return {
    db: { execute: mockExecute },
    userId,
    timezone: "UTC",
  };
}

describe("mcpRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([]);
  });

  it("rejects unauthenticated token creation", async () => {
    const caller = createCaller(createContext(null));

    await expect(
      caller.createToken({
        name: "Codex",
        scopes: ["health:read"],
        expiresAt: null,
      }),
    ).rejects.toThrow(TRPCError);
  });

  it("creates a token and returns the raw token once", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "token-id",
        name: "Codex",
        scopes: ["health:read"],
        created_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      },
    ]);
    const caller = createCaller(createContext("user-id"));

    const result = await caller.createToken({
      name: "Codex",
      scopes: ["health:read"],
      expiresAt: null,
    });

    expect(result.token).toMatch(/^dofek_mcp_/);
    expect(result.metadata).toEqual({
      id: "token-id",
      name: "Codex",
      scopes: ["health:read"],
      createdAt: "2026-05-20T12:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    const queryPayload = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    expect(queryPayload).toContain("user-id");
    expect(queryPayload).toContain("Codex");
    expect(queryPayload).toContain("health:read");
  });

  it("creates expiring tokens with the requested expiration timestamp", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "token-id",
        name: "Codex",
        scopes: ["health:read"],
        created_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        expires_at: "2026-06-01T00:00:00.000Z",
        revoked_at: null,
      },
    ]);
    const caller = createCaller(createContext("user-id"));

    const result = await caller.createToken({
      name: "Codex",
      scopes: ["health:read"],
      expiresAt: "2026-06-01T00:00:00.000Z",
    });

    const queryPayload = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    expect(queryPayload).toContain("2026-06-01T00:00:00.000Z");
    expect(result.metadata.expiresAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("lists token metadata without raw tokens or hashes", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "token-id",
        name: "Codex",
        scopes: ["health:read", "activity:read"],
        created_at: "2026-05-20T12:00:00.000Z",
        last_used_at: "2026-05-20T12:30:00.000Z",
        expires_at: null,
        revoked_at: null,
      },
    ]);
    const caller = createCaller(createContext("user-id"));

    const result = await caller.listTokens();

    expect(result).toEqual([
      {
        id: "token-id",
        name: "Codex",
        scopes: ["health:read", "activity:read"],
        createdAt: "2026-05-20T12:00:00.000Z",
        lastUsedAt: "2026-05-20T12:30:00.000Z",
        expiresAt: null,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("dofek_mcp_");
    expect(JSON.stringify(result)).not.toContain(hashMcpToken("dofek_mcp_example"));
  });

  it("revokes a user-owned token", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "token-id",
        name: "Codex",
        scopes: ["health:read"],
        created_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        expires_at: null,
        revoked_at: "2026-05-20T13:00:00.000Z",
      },
    ]);
    const caller = createCaller(createContext("user-id"));

    const result = await caller.revokeToken({ tokenId: "00000000-0000-0000-0000-000000000001" });

    expect(result?.revokedAt).toBe("2026-05-20T13:00:00.000Z");
  });

  it("rejects revoking a token that does not belong to the user", async () => {
    const caller = createCaller(createContext("user-id"));

    await expect(
      caller.revokeToken({ tokenId: "00000000-0000-0000-0000-000000000001" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "MCP token not found.",
    });
  });
});
