import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMcpToken,
  generateMcpToken,
  hashMcpToken,
  McpAuthError,
  requireMcpScope,
  validateMcpToken,
} from "./token-repository.ts";

const mockExecute = vi.fn();

function createMockDb() {
  return { execute: mockExecute };
}

describe("MCP token repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([]);
  });

  it("generates recognizable MCP bearer tokens", () => {
    const token = generateMcpToken();

    expect(token).toMatch(/^dofek_mcp_[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(50);
  });

  it("hashes tokens without preserving the raw token", () => {
    const token = "dofek_mcp_example-token";

    const hash = hashMcpToken(token);

    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates a token and stores only the hash", async () => {
    mockExecute.mockResolvedValue([
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

    const created = await createMcpToken(createMockDb(), {
      userId: "user-id",
      name: "Codex",
      scopes: ["health:read"],
      expiresAt: null,
    });

    expect(created.token).toMatch(/^dofek_mcp_/);
    expect(created.metadata).toEqual({
      id: "token-id",
      name: "Codex",
      scopes: ["health:read"],
      createdAt: "2026-05-20T12:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    const queryPayload = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    expect(queryPayload).not.toContain(created.token);
    expect(queryPayload).toContain("mcp_access_token");
  });

  it("validates an active token", async () => {
    const token = "dofek_mcp_valid";
    mockExecute
      .mockResolvedValueOnce([
        {
          id: "token-id",
          user_id: "user-id",
          scopes: ["health:read", "activity:read"],
          expires_at: null,
          oauth_client_id: null,
          oauth_resource: null,
          revoked_at: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await validateMcpToken(createMockDb(), token);

    expect(result).toEqual({
      tokenId: "token-id",
      userId: "user-id",
      scopes: ["health:read", "activity:read"],
      expiresAt: null,
      oauthClientId: null,
      oauthResource: null,
    });
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("rejects revoked tokens", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "token-id",
        user_id: "user-id",
        scopes: ["health:read"],
        expires_at: null,
        oauth_client_id: null,
        oauth_resource: null,
        revoked_at: "2026-05-20T12:00:00.000Z",
      },
    ]);

    await expect(validateMcpToken(createMockDb(), "dofek_mcp_revoked")).resolves.toBeNull();
  });

  it("rejects expired tokens", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "token-id",
        user_id: "user-id",
        scopes: ["health:read"],
        expires_at: new Date(Date.now() - 1_000).toISOString(),
        oauth_client_id: null,
        oauth_resource: null,
        revoked_at: null,
      },
    ]);

    await expect(validateMcpToken(createMockDb(), "dofek_mcp_expired")).resolves.toBeNull();
  });

  it("allows required scopes that are present", () => {
    expect(() => requireMcpScope(["health:read"], "health:read")).not.toThrow();
  });

  it("throws insufficient_scope when a scope is missing", () => {
    expect(() => requireMcpScope(["health:read"], "sync:write")).toThrow(McpAuthError);

    try {
      requireMcpScope(["health:read"], "sync:write");
    } catch (error) {
      expect(error).toBeInstanceOf(McpAuthError);
      if (error instanceof McpAuthError) {
        expect(error.code).toBe("insufficient_scope");
        expect(error.status).toBe(403);
      }
    }
  });
});
