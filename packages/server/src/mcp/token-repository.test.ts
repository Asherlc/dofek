import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMcpToken,
  generateMcpToken,
  hashMcpToken,
  listMcpConnectedApps,
  listMcpPersonalTokens,
  listMcpTokens,
  McpAuthError,
  mcpScopeSchema,
  requireMcpScope,
  revokeMcpConnectedApp,
  updateMcpConnectedAppScopes,
  updateMcpTokenScopes,
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

  it("accepts the nutrition write scope", () => {
    expect(mcpScopeSchema.parse("nutrition:write")).toBe("nutrition:write");
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
      oauthClientId: null,
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

  it("returns the OAuth client identifier when listing tokens", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "oauth-token-id",
        name: "Claude OAuth",
        scopes: ["health:read"],
        created_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        expires_at: "2026-05-20T13:00:00.000Z",
        revoked_at: null,
        oauth_client_id: "https://claude.ai/oauth/client-metadata.json",
      },
    ]);

    const tokens = await listMcpTokens(createMockDb(), "user-id");

    expect(tokens).toEqual([
      expect.objectContaining({
        id: "oauth-token-id",
        name: "Claude OAuth",
        oauthClientId: "https://claude.ai/oauth/client-metadata.json",
      }),
    ]);
  });

  it("lists personal tokens without OAuth connections", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "personal-token-id",
        name: "Codex",
        scopes: ["health:read"],
        created_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
        oauth_client_id: null,
      },
    ]);

    await listMcpPersonalTokens(createMockDb(), "user-id");

    expect(JSON.stringify(mockExecute.mock.calls[0]?.[0])).toContain("oauth_client_id IS NULL");
  });

  it("returns a cursor for the next connected-app page", async () => {
    mockExecute.mockResolvedValueOnce(
      Array.from({ length: 21 }, (_, index) => ({
        oauth_client_id: `oauth-client-${index}`,
        oauth_resource: "https://dofek.example/api/mcp",
        name: `OAuth app ${index}`,
        scopes: ["health:read"],
        connected_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        is_active: true,
      })),
    );

    const page = await listMcpConnectedApps(createMockDb(), "user-id", undefined);

    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe(
      Buffer.from(
        JSON.stringify({
          oauthClientId: "oauth-client-19",
          oauthResource: "https://dofek.example/api/mcp",
        }),
      ).toString("base64url"),
    );
    const queryPayload = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    expect(queryPayload).toContain("oauth_client_id IS NOT NULL");
    expect(queryPayload).toContain('},21,{"value":[""]');
  });

  it("uses both client and resource in the connected-app pagination cursor", async () => {
    mockExecute.mockResolvedValueOnce(
      Array.from({ length: 21 }, (_, index) => ({
        oauth_client_id: "shared-client",
        oauth_resource: `https://dofek.example/api/mcp/${index}`,
        name: `OAuth app ${index}`,
        scopes: ["health:read"],
        connected_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        is_active: true,
      })),
    );

    const firstPage = await listMcpConnectedApps(createMockDb(), "user-id");
    const nextCursor = firstPage.nextCursor;
    expect(nextCursor).toEqual(expect.any(String));

    mockExecute.mockResolvedValueOnce([]);
    await listMcpConnectedApps(createMockDb(), "user-id", nextCursor ?? undefined);

    const queryPayload = JSON.stringify(mockExecute.mock.calls[1]?.[0]);
    expect(queryPayload).toContain("shared-client");
    expect(queryPayload).toContain("https://dofek.example/api/mcp/19");
  });

  it("does not return a cursor when the connected-app page is full", async () => {
    mockExecute.mockResolvedValueOnce(
      Array.from({ length: 20 }, (_, index) => ({
        oauth_client_id: `oauth-client-${index}`,
        oauth_resource: "https://dofek.example/api/mcp",
        name: `OAuth app ${index}`,
        scopes: ["health:read"],
        connected_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        is_active: true,
      })),
    );

    const page = await listMcpConnectedApps(createMockDb(), "user-id");

    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBeNull();
  });

  it("returns aggregate connected-app metadata", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        oauth_client_id: "claude-client",
        oauth_resource: "https://dofek.example/api/mcp",
        name: "Claude",
        scopes: ["health:read", "activity:read"],
        connected_at: "2026-05-20T12:00:00.000Z",
        last_used_at: "2026-05-20T12:30:00.000Z",
        is_active: true,
      },
    ]);

    const page = await listMcpConnectedApps(createMockDb(), "user-id");

    expect(page).toEqual({
      items: [
        {
          oauthClientId: "claude-client",
          oauthResource: "https://dofek.example/api/mcp",
          name: "Claude",
          scopes: ["health:read", "activity:read"],
          connectedAt: "2026-05-20T12:00:00.000Z",
          lastUsedAt: "2026-05-20T12:30:00.000Z",
          isActive: true,
        },
      ],
      nextCursor: null,
    });
  });

  it("revokes every token belonging to a connected app", async () => {
    mockExecute.mockResolvedValueOnce([{ found: true }]);

    await expect(
      revokeMcpConnectedApp(
        createMockDb(),
        "user-id",
        "claude-client",
        "https://dofek.example/api/mcp",
      ),
    ).resolves.toBe(true);

    const queryPayload = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    expect(queryPayload).toContain("mcp_access_token");
    expect(queryPayload).toContain("mcp_oauth_refresh_token");
    expect(queryPayload).toContain("claude-client");
    expect(queryPayload).toContain("https://dofek.example/api/mcp");
  });

  it("does not add nutrition write to an existing read-only token", async () => {
    const token = "dofek_mcp_read_only";
    mockExecute
      .mockResolvedValueOnce([
        {
          id: "token-id",
          user_id: "user-id",
          scopes: ["nutrition:read"],
          expires_at: null,
          oauth_client_id: null,
          oauth_resource: null,
          revoked_at: null,
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await validateMcpToken(createMockDb(), token);

    expect(result?.scopes).toEqual(["nutrition:read"]);
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

  it("updates scopes for a user-owned token", async () => {
    mockExecute.mockResolvedValueOnce([
      {
        id: "token-id",
        name: "Codex",
        scopes: ["health:read", "activity:read"],
        created_at: "2026-05-20T12:00:00.000Z",
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      },
    ]);

    const updated = await updateMcpTokenScopes(createMockDb(), "user-id", "token-id", [
      "health:read",
      "activity:read",
    ]);

    expect(updated).toEqual({
      id: "token-id",
      name: "Codex",
      scopes: ["health:read", "activity:read"],
      createdAt: "2026-05-20T12:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      oauthClientId: null,
    });
    expect(JSON.stringify(mockExecute.mock.calls[0]?.[0])).toContain("UPDATE");
    expect(JSON.stringify(mockExecute.mock.calls[0]?.[0])).toContain("activity:read");
    expect(JSON.stringify(mockExecute.mock.calls[0]?.[0])).toContain(
      "expires_at IS NULL OR expires_at > NOW()",
    );
  });

  it("updates scopes for every active credential belonging to a connected app", async () => {
    mockExecute.mockResolvedValueOnce([{ found: true }]);

    await expect(
      updateMcpConnectedAppScopes(
        createMockDb(),
        "user-id",
        "claude-client",
        "https://dofek.example/api/mcp",
        ["health:read", "activity:read"],
      ),
    ).resolves.toBe(true);

    const queryPayload = JSON.stringify(mockExecute.mock.calls[0]?.[0]);
    expect(queryPayload).toContain("UPDATE fitness.mcp_access_token");
    expect(queryPayload).toContain("UPDATE fitness.mcp_oauth_refresh_token");
    expect(queryPayload).toContain("claude-client");
    expect(queryPayload).toContain("https://dofek.example/api/mcp");
    expect(queryPayload).toContain("activity:read");
  });

  it("returns false when no active credential belongs to a connected app", async () => {
    mockExecute.mockResolvedValueOnce([]);

    await expect(
      updateMcpConnectedAppScopes(
        createMockDb(),
        "user-id",
        "missing-client",
        "https://dofek.example/api/mcp",
        ["health:read"],
      ),
    ).resolves.toBe(false);
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
