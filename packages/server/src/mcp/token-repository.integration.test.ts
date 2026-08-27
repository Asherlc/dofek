import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import {
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
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
      scopes: ["health:read", "activity:read", "nutrition:read", "providers:read", "sync:write"],
      expiresAt: null,
    });

    expect(created.metadata.scopes).toEqual([
      "health:read",
      "activity:read",
      "nutrition:read",
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

  it("listMcpTokens returns scopes as arrays for every token", async () => {
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

    const tokens = await listMcpTokens(ctx.db, testUserId);

    expect(tokens).toHaveLength(2);
    const byName = new Map(tokens.map((token) => [token.name, token]));
    expect(byName.get("First")?.scopes).toEqual(["health:read"]);
    expect(byName.get("Second")?.scopes).toEqual(["activity:read", "nutrition:read"]);
  });
});
