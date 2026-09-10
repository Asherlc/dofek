import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { rotateRefreshToken } from "./oauth-repository.ts";
import {
  createMcpToken,
  hashMcpToken,
  listMcpConnectedApps,
  listMcpPersonalTokens,
  listMcpTokens,
  revokeMcpToken,
  updateMcpTokenScopes,
  validateMcpToken,
} from "./token-repository.ts";

const insertedUserRowSchema = z.object({ id: z.string() });
const tokenScopesRowSchema = z.object({ scopes: z.array(z.string()) });
const refreshTokenIdRowSchema = z.object({ id: z.string() });
const refreshTokenStateRowSchema = z.object({
  access_token_id: z.string(),
  revoked_at: z.string().nullable(),
});

describe("MCP token repository (integration)", () => {
  let ctx: TestContext;
  let testUserId: string;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM fitness.mcp_access_token`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE email = 'mcp-test@test.com'`);
    const rows = await executeWithSchema(
      ctx.db,
      insertedUserRowSchema,
      sql`INSERT INTO fitness.user_profile (name, email)
          VALUES ('MCP Test User', 'mcp-test@test.com') RETURNING id`,
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("Failed to create test user");
    testUserId = id;
  });

  it("persists all scopes as a text[] array (not a tuple)", async () => {
    const created = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Codex",
      scopes: [
        "health:read",
        "activity:read",
        "nutrition:read",
        "nutrition:write",
        "providers:read",
        "sync:write",
      ],
      expiresAt: null,
    });

    expect(created.metadata.scopes).toEqual([
      "health:read",
      "activity:read",
      "nutrition:read",
      "nutrition:write",
      "providers:read",
      "sync:write",
    ]);

    const raw = await executeWithSchema(
      ctx.db,
      tokenScopesRowSchema,
      sql`SELECT scopes FROM fitness.mcp_access_token WHERE id = ${created.metadata.id}::uuid`,
    );
    expect(raw[0]?.scopes).toEqual([
      "health:read",
      "activity:read",
      "nutrition:read",
      "nutrition:write",
      "providers:read",
      "sync:write",
    ]);
  });

  it("persists a single-scope token", async () => {
    const created = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Single Scope",
      scopes: ["health:read"],
      expiresAt: null,
    });

    expect(created.metadata.scopes).toEqual(["health:read"]);
  });

  it("round-trips through validateMcpToken with all scopes intact", async () => {
    const { token } = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Round Trip",
      scopes: ["health:read", "sync:write"],
      expiresAt: null,
    });

    const validated = await validateMcpToken(ctx.db, token);

    expect(validated).not.toBeNull();
    expect(validated?.userId).toBe(testUserId);
    expect(validated?.scopes).toEqual(["health:read", "sync:write"]);
  });

  it("round-trips an explicitly granted nutrition write scope", async () => {
    const { token } = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Food writer",
      scopes: ["nutrition:read", "nutrition:write"],
      expiresAt: null,
    });

    expect((await validateMcpToken(ctx.db, token))?.scopes).toEqual([
      "nutrition:read",
      "nutrition:write",
    ]);
  });

  it("does not add nutrition write to existing tokens", async () => {
    const { token } = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Read only",
      scopes: ["nutrition:read"],
      expiresAt: null,
    });

    expect((await validateMcpToken(ctx.db, token))?.scopes).toEqual(["nutrition:read"]);
  });

  it("updates scopes without changing the bearer token", async () => {
    const { token, metadata } = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Editable",
      scopes: ["health:read"],
      expiresAt: null,
    });

    const updated = await updateMcpTokenScopes(ctx.db, testUserId, metadata.id, [
      "health:read",
      "activity:read",
    ]);

    expect(updated?.scopes).toEqual(["health:read", "activity:read"]);
    expect((await validateMcpToken(ctx.db, token))?.scopes).toEqual([
      "health:read",
      "activity:read",
    ]);
  });

  it("persists OAuth scope edits through refresh rotation", async () => {
    const created = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "ChatGPT OAuth",
      scopes: ["nutrition:read"],
      expiresAt: null,
      oauthClientId: "chatgpt-client",
      oauthResource: "https://dofek.example/api/mcp",
    });

    await ctx.db.execute(
      sql`INSERT INTO fitness.mcp_oauth_refresh_token (
            token_hash, client_id, user_id, access_token_id, scopes, resource, expires_at
          ) VALUES (
            ${hashMcpToken("edited-refresh")}, ${"chatgpt-client"}, ${testUserId},
            ${created.metadata.id}::uuid, ARRAY[${"nutrition:read"}]::text[],
            ${"https://dofek.example/api/mcp"}, ${new Date(Date.now() + 86_400_000)}
          )`,
    );

    await updateMcpTokenScopes(ctx.db, testUserId, created.metadata.id, [
      "nutrition:read",
      "nutrition:write",
    ]);

    const refreshed = await rotateRefreshToken(ctx.db, {
      clientId: "chatgpt-client",
      name: "ChatGPT OAuth",
      refreshToken: "edited-refresh",
      resource: "https://dofek.example/api/mcp",
    });

    expect(refreshed?.scopes).toEqual(["nutrition:read", "nutrition:write"]);
  });

  it("does not update expired tokens", async () => {
    const { metadata } = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Expired",
      scopes: ["health:read"],
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(
      updateMcpTokenScopes(ctx.db, testUserId, metadata.id, ["activity:read"]),
    ).resolves.toBeNull();
    expect(
      (await listMcpTokens(ctx.db, testUserId)).find((token) => token.id === metadata.id)?.scopes,
    ).toEqual(["health:read"]);
  });

  it("rejects tokens after revokeMcpToken", async () => {
    const { token, metadata } = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Revoked",
      scopes: ["health:read"],
      expiresAt: null,
    });

    const revoked = await revokeMcpToken(ctx.db, testUserId, metadata.id);
    expect(typeof revoked?.revokedAt).toBe("string");
    expect(revoked?.revokedAt && !Number.isNaN(new Date(revoked.revokedAt).getTime())).toBe(true);

    const validated = await validateMcpToken(ctx.db, token);
    expect(validated).toBeNull();
  });

  it("revokes an OAuth refresh grant when revoking its access token", async () => {
    const first = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Claude OAuth",
      scopes: ["health:read"],
      expiresAt: null,
      oauthClientId: "claude-client",
      oauthResource: "https://dofek.example/api/mcp",
    });
    const child = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Claude OAuth",
      scopes: ["health:read"],
      expiresAt: null,
      oauthClientId: "claude-client",
      oauthResource: "https://dofek.example/api/mcp",
    });
    const unrelated = await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Claude OAuth",
      scopes: ["health:read"],
      expiresAt: null,
      oauthClientId: "claude-client",
      oauthResource: "https://dofek.example/api/mcp",
    });

    const firstRefreshRows = await executeWithSchema(
      ctx.db,
      refreshTokenIdRowSchema,
      sql`INSERT INTO fitness.mcp_oauth_refresh_token (
            token_hash, client_id, user_id, access_token_id, scopes, resource, expires_at
          ) VALUES (
            ${hashMcpToken("claude-refresh")}, ${"claude-client"}, ${testUserId},
            ${first.metadata.id}::uuid, ARRAY[${"health:read"}]::text[], ${"https://dofek.example/api/mcp"},
            ${new Date(Date.now() + 86_400_000)}
          ) RETURNING id`,
    );
    const firstRefreshId = firstRefreshRows[0]?.id;
    if (!firstRefreshId) throw new Error("Failed to create first OAuth refresh token");

    await ctx.db.execute(
      sql`INSERT INTO fitness.mcp_oauth_refresh_token (
            token_hash, client_id, user_id, access_token_id, parent_refresh_token_id,
            scopes, resource, expires_at
          ) VALUES (
            ${hashMcpToken("claude-child-refresh")}, ${"claude-client"}, ${testUserId},
            ${child.metadata.id}::uuid, ${firstRefreshId}::uuid, ARRAY[${"health:read"}]::text[],
            ${"https://dofek.example/api/mcp"}, ${new Date(Date.now() + 86_400_000)}
          )`,
    );

    await ctx.db.execute(
      sql`INSERT INTO fitness.mcp_oauth_refresh_token (
            token_hash, client_id, user_id, access_token_id, scopes, resource, expires_at
          ) VALUES (
            ${hashMcpToken("claude-unrelated-refresh")}, ${"claude-client"}, ${testUserId},
            ${unrelated.metadata.id}::uuid, ARRAY[${"health:read"}]::text[], ${"https://dofek.example/api/mcp"},
            ${new Date(Date.now() + 86_400_000)}
          )`,
    );

    await revokeMcpToken(ctx.db, testUserId, first.metadata.id);

    const refreshRows = await executeWithSchema(
      ctx.db,
      refreshTokenStateRowSchema,
      sql`SELECT access_token_id, revoked_at
          FROM fitness.mcp_oauth_refresh_token
          WHERE client_id = ${"claude-client"}`,
    );
    const refreshStateByAccessTokenId = new Map(
      refreshRows.map((row) => [row.access_token_id, row.revoked_at]),
    );
    expect(refreshStateByAccessTokenId.get(first.metadata.id)).toEqual(expect.any(String));
    expect(refreshStateByAccessTokenId.get(child.metadata.id)).toEqual(expect.any(String));
    expect(refreshStateByAccessTokenId.get(unrelated.metadata.id)).toBeNull();
    await expect(validateMcpToken(ctx.db, unrelated.token)).resolves.not.toBeNull();
  });

  it("listMcpTokens returns scopes as arrays for every token", async () => {
    await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "First",
      scopes: ["health:read"],
      expiresAt: null,
      oauthClientId: "claude-client",
      oauthResource: "https://dofek.example/api/mcp",
    });
    await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Second",
      scopes: ["activity:read", "nutrition:read"],
      expiresAt: null,
    });

    const tokens = await listMcpTokens(ctx.db, testUserId);

    expect(tokens).toHaveLength(2);
    const byName = new Map(tokens.map((token) => [token.name, token]));
    expect(byName.get("First")?.scopes).toEqual(["health:read"]);
    expect(byName.get("First")?.oauthClientId).toBe("claude-client");
    expect(byName.get("Second")?.scopes).toEqual(["activity:read", "nutrition:read"]);
    expect(byName.get("Second")?.oauthClientId).toBeNull();
  });

  it("paginates connected apps without returning personal tokens", async () => {
    for (let index = 0; index < 21; index += 1) {
      await createMcpToken(ctx.db, {
        userId: testUserId,
        name: `OAuth app ${index}`,
        scopes: ["health:read"],
        expiresAt: null,
        oauthClientId: "claude-client",
        oauthResource: "https://dofek.example/api/mcp",
      });
    }
    await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Personal token",
      scopes: ["health:read"],
      expiresAt: null,
    });

    const firstPage = await listMcpConnectedApps(ctx.db, testUserId);
    const nextCursor = firstPage.nextCursor;
    expect(firstPage.items).toHaveLength(20);
    expect(firstPage.items.every((token) => token.oauthClientId === "claude-client")).toBe(true);
    expect(nextCursor).toEqual(expect.any(String));

    const secondPage = await listMcpConnectedApps(ctx.db, testUserId, nextCursor ?? undefined);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.items[0]?.name).toMatch(/^OAuth app /);

    const personalTokens = await listMcpPersonalTokens(ctx.db, testUserId);
    expect(personalTokens).toHaveLength(1);
    expect(personalTokens[0]?.name).toBe("Personal token");
  });
});
