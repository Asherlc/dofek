import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import {
  createOrGetCompanionToken,
  listActiveCompanionTokens,
  regenerateCompanionToken,
  revokeCompanionToken,
  validateCompanionToken,
} from "./token-repository.ts";

const insertedUserRowSchema = z.object({ id: z.string() });
const activeTokenCountRowSchema = z.object({ active_count: z.coerce.number() });

describe("companion token repository (integration)", () => {
  let ctx: TestContext;
  let testUserId: string;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM fitness.companion_token`);
    await ctx.db.execute(
      sql`DELETE FROM fitness.user_profile WHERE email = 'companion-token-test@test.com'`,
    );
    const rows = await executeWithSchema(
      ctx.db,
      insertedUserRowSchema,
      sql`INSERT INTO fitness.user_profile (name, email)
          VALUES ('Companion Token Test User', 'companion-token-test@test.com')
          RETURNING id`,
    );
    const insertedUser = rows[0];
    if (!insertedUser) throw new Error("Failed to create test user");
    testUserId = insertedUser.id;
  });

  it("keeps the old token valid when creating its replacement fails", async () => {
    const previous = await createOrGetCompanionToken(ctx.db, testUserId);
    if (!previous.token) throw new Error("Failed to create initial companion token");

    await ctx.db.execute(
      sql.raw(`
      CREATE FUNCTION fitness.fail_companion_token_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced companion token insertion failure';
      END;
      $$`),
    );
    await ctx.db.execute(
      sql.raw(`
      CREATE TRIGGER fail_companion_token_insert
      BEFORE INSERT ON fitness.companion_token
      FOR EACH ROW EXECUTE FUNCTION fitness.fail_companion_token_insert();
    `),
    );

    try {
      await expect(regenerateCompanionToken(ctx.db, testUserId)).rejects.toThrow();
    } finally {
      await ctx.db.execute(
        sql.raw("DROP TRIGGER fail_companion_token_insert ON fitness.companion_token"),
      );
      await ctx.db.execute(sql.raw("DROP FUNCTION fitness.fail_companion_token_insert()"));
    }

    expect(await validateCompanionToken(ctx.db, previous.token)).toBe(testUserId);
  });

  it("leaves exactly one active token after successful regeneration", async () => {
    const previous = await createOrGetCompanionToken(ctx.db, testUserId);
    if (!previous.token) throw new Error("Failed to create initial companion token");

    const replacement = await regenerateCompanionToken(ctx.db, testUserId);

    if (!replacement.token) throw new Error("Regeneration did not return a replacement token");
    expect(await validateCompanionToken(ctx.db, previous.token)).toBeNull();
    expect(await validateCompanionToken(ctx.db, replacement.token)).toBe(testUserId);
    const activeTokenRows = await executeWithSchema(
      ctx.db,
      activeTokenCountRowSchema,
      sql`SELECT count(*)::int AS active_count
          FROM fitness.companion_token
          WHERE user_id = ${testUserId} AND revoked_at IS NULL`,
    );
    expect(activeTokenRows[0]?.active_count).toBe(1);
  });

  it("keeps independent normal-app and workout-extension tokens active", async () => {
    const mainToken = await createOrGetCompanionToken(ctx.db, testUserId, "zepp-main");
    const workoutToken = await createOrGetCompanionToken(ctx.db, testUserId, "zepp-workout");
    if (!mainToken.token || !workoutToken.token) {
      throw new Error("Failed to create typed companion tokens");
    }

    expect(await validateCompanionToken(ctx.db, mainToken.token)).toBe(testUserId);
    expect(await validateCompanionToken(ctx.db, workoutToken.token)).toBe(testUserId);
    await expect(listActiveCompanionTokens(ctx.db, testUserId)).resolves.toEqual([
      expect.objectContaining({ connectionType: "zepp-main" }),
      expect.objectContaining({ connectionType: "zepp-workout" }),
    ]);
  });

  it("revokes one connection type without invalidating the other", async () => {
    const mainToken = await createOrGetCompanionToken(ctx.db, testUserId, "zepp-main");
    const workoutToken = await createOrGetCompanionToken(ctx.db, testUserId, "zepp-workout");
    if (!mainToken.token || !workoutToken.token) {
      throw new Error("Failed to create typed companion tokens");
    }

    await revokeCompanionToken(ctx.db, testUserId, "zepp-main");

    expect(await validateCompanionToken(ctx.db, mainToken.token)).toBeNull();
    expect(await validateCompanionToken(ctx.db, workoutToken.token)).toBe(testUserId);
    await expect(listActiveCompanionTokens(ctx.db, testUserId)).resolves.toEqual([
      expect.objectContaining({ connectionType: "zepp-workout" }),
    ]);
  });

  it("deletes companion tokens when their user is deleted", async () => {
    const token = await createOrGetCompanionToken(ctx.db, testUserId, "zepp-main");
    if (!token.token) throw new Error("Failed to create companion token");

    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE id = ${testUserId}`);

    expect(await validateCompanionToken(ctx.db, token.token)).toBeNull();
  });

  it("returns a conflict result when regenerations contend", async () => {
    await createOrGetCompanionToken(ctx.db, testUserId);

    await ctx.db.execute(
      sql.raw(`
        CREATE FUNCTION fitness.delay_companion_token_update()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(0.1);
          RETURN NEW;
        END;
        $$`),
    );
    await ctx.db.execute(
      sql.raw(`
        CREATE TRIGGER delay_companion_token_update
        BEFORE UPDATE ON fitness.companion_token
        FOR EACH ROW EXECUTE FUNCTION fitness.delay_companion_token_update();
      `),
    );

    const results = await (async () => {
      try {
        return await Promise.all([
          regenerateCompanionToken(ctx.db, testUserId),
          regenerateCompanionToken(ctx.db, testUserId),
        ]);
      } finally {
        await ctx.db.execute(
          sql.raw("DROP TRIGGER delay_companion_token_update ON fitness.companion_token"),
        );
        await ctx.db.execute(sql.raw("DROP FUNCTION fitness.delay_companion_token_update()"));
      }
    })();
    const returnedTokens = results.flatMap((result) => (result.token ? [result.token] : []));

    expect(returnedTokens).toHaveLength(1);
    const returnedToken = returnedTokens[0];
    if (!returnedToken) throw new Error("Concurrent regeneration did not return a token");
    expect(await validateCompanionToken(ctx.db, returnedToken)).toBe(testUserId);
  });
});
