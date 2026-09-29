import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import {
  createMcpToken,
  listMcpConnectedApps,
  listMcpPersonalTokens,
  markMcpConnectedAppUsed,
  revokeMcpConnectedApp,
  revokeMcpToken,
  updateMcpConnectedAppScopes,
  updateMcpTokenScopes,
  validateMcpToken,
} from "./token-repository.ts";

const insertedUserRowSchema = z.object({ id: z.string() });
const tokenScopesRowSchema = z.object({ scopes: z.array(z.string()) });

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
    await ctx.db.execute(sql`DELETE FROM fitness.mcp_oidc_adapter`);
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
      (await listMcpPersonalTokens(ctx.db, testUserId)).find((token) => token.id === metadata.id)
        ?.scopes,
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

  it("listMcpPersonalTokens returns scopes as arrays for every token", async () => {
    await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "First",
      scopes: ["health:read"],
      expiresAt: null,
    });
    await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Second",
      scopes: ["activity:read", "nutrition:read"],
      expiresAt: null,
    });

    const tokens = await listMcpPersonalTokens(ctx.db, testUserId);

    expect(tokens).toHaveLength(2);
    const byName = new Map(tokens.map((token) => [token.name, token]));
    expect(byName.get("First")?.scopes).toEqual(["health:read"]);
    expect(byName.get("Second")?.scopes).toEqual(["activity:read", "nutrition:read"]);
  });

  it("lists, updates, and revokes OIDC connected-app grants", async () => {
    const clientId = "https://claude.ai/oauth/mcp-oauth-client-metadata";
    const resource = "https://dofek.example/api/mcp";
    const expiresAt = new Date(Date.now() + 86_400_000);
    const accessTokenId = createHash("sha256").update("access-token-id").digest("hex");
    const refreshTokenId = createHash("sha256").update("refresh-token-id").digest("hex");
    await ctx.db.execute(sql`INSERT INTO fitness.mcp_oidc_adapter (model, id, payload, user_id, grant_id, expires_at)
      VALUES
        ('Grant', 'grant-earlier', ${JSON.stringify({ accountId: testUserId, clientId, resources: { [resource]: "health:read" } })}::jsonb, ${testUserId}::uuid, NULL, ${expiresAt}),
        ('Grant', 'grant-current', ${JSON.stringify({ accountId: testUserId, clientId, resources: { [resource]: "activity:read" } })}::jsonb, ${testUserId}::uuid, NULL, ${expiresAt}),
        ('AccessToken', ${accessTokenId}, ${JSON.stringify({ accountId: testUserId, clientId, grantId: "grant-current" })}::jsonb, ${testUserId}::uuid, 'grant-current', ${expiresAt}),
        ('RefreshToken', ${refreshTokenId}, ${JSON.stringify({ accountId: testUserId, clientId, grantId: "grant-current" })}::jsonb, ${testUserId}::uuid, 'grant-current', ${expiresAt})`);

    const beforeUpdate = await listMcpConnectedApps(ctx.db, testUserId);
    expect(beforeUpdate.items).toEqual([
      {
        oauthClientId: clientId,
        oauthResource: resource,
        name: clientId,
        scopes: ["activity:read", "health:read"],
        connectedAt: expect.any(String),
        lastUsedAt: null,
        isActive: true,
      },
    ]);

    await expect(markMcpConnectedAppUsed(ctx.db, accessTokenId)).resolves.toBe(true);
    const lastUsedAt = (await listMcpConnectedApps(ctx.db, testUserId)).items[0]?.lastUsedAt;
    expect(lastUsedAt).toEqual(expect.any(String));

    await expect(
      updateMcpConnectedAppScopes(ctx.db, testUserId, clientId, resource, ["health:read"]),
    ).resolves.toBe(true);
    const afterUpdate = await listMcpConnectedApps(ctx.db, testUserId);
    expect(afterUpdate.items[0]?.scopes).toEqual(["health:read"]);
    expect(afterUpdate.items[0]?.lastUsedAt).toBe(lastUsedAt);
    const remainingAccessTokens = await executeWithSchema(
      ctx.db,
      z.object({ count: z.number() }),
      sql`SELECT COUNT(*)::int AS count FROM fitness.mcp_oidc_adapter WHERE model = 'AccessToken'`,
    );
    expect(remainingAccessTokens[0]?.count).toBe(0);
    const remainingRefreshTokens = await executeWithSchema(
      ctx.db,
      z.object({ count: z.number() }),
      sql`SELECT COUNT(*)::int AS count FROM fitness.mcp_oidc_adapter WHERE model = 'RefreshToken'`,
    );
    expect(remainingRefreshTokens[0]?.count).toBe(1);

    await expect(revokeMcpConnectedApp(ctx.db, testUserId, clientId, resource)).resolves.toBe(true);
    const remainingGrantArtifacts = await executeWithSchema(
      ctx.db,
      z.object({ count: z.number() }),
      sql`SELECT COUNT(*)::int AS count FROM fitness.mcp_oidc_adapter
          WHERE grant_id IN ('grant-earlier', 'grant-current')
             OR (model = 'Grant' AND id IN ('grant-earlier', 'grant-current'))`,
    );
    expect(remainingGrantArtifacts[0]?.count).toBe(0);

    await createMcpToken(ctx.db, {
      userId: testUserId,
      name: "Personal token",
      scopes: ["health:read"],
      expiresAt: null,
    });
    expect(await listMcpPersonalTokens(ctx.db, testUserId)).toHaveLength(1);
  });
});
