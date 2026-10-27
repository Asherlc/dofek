import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, createDatabaseFromEnv } from "./index.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

let ctx: TestContext;
const developerClientOwnerId = "00000000-0000-4000-8000-000000000096";

beforeAll(async () => {
  ctx = await setupTestDatabase();
  await ctx.db.execute(sql`
    INSERT INTO fitness.user_profile (id, name)
    VALUES (${developerClientOwnerId}, 'Developer Client Owner')
  `);
}, 120_000);

afterAll(async () => {
  await ctx?.cleanup();
});

describe("createDatabase", () => {
  it("returns a valid Drizzle instance that can execute queries", async () => {
    const db = createDatabase(ctx.connectionString);
    try {
      const rows = await db.execute<{ one: number }>(sql`SELECT 1 AS one`);
      expect(rows.length).toBe(1);
      expect(rows[0]?.one).toBe(1);
    } finally {
      await db.$client.end();
    }
  });

  it("has schema tables available", async () => {
    const db = createDatabase(ctx.connectionString);
    try {
      const tables = await db.execute<{ table_name: string }>(
        sql`SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'fitness'
            ORDER BY table_name`,
      );

      const tableNames = tables.map((t) => t.table_name);
      expect(tableNames).toContain("provider");
      expect(tableNames).toContain("activity");
      expect(tableNames).toContain("sync_log");
    } finally {
      await db.$client.end();
    }
  });
});

describe("createDatabaseFromEnv", () => {
  it("throws when DATABASE_URL is not set", () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => createDatabaseFromEnv()).toThrow(
        "DATABASE_URL environment variable is required",
      );
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      }
    }
  });

  it("returns a database when DATABASE_URL is set", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = ctx.connectionString;
    try {
      const db = createDatabaseFromEnv();
      try {
        expect(db).toBeDefined();
        const rows = await db.execute<{ one: number }>(sql`SELECT 1 AS one`);
        expect(rows[0]?.one).toBe(1);
      } finally {
        await db.$client.end();
      }
    } finally {
      if (original !== undefined) {
        process.env.DATABASE_URL = original;
      } else {
        delete process.env.DATABASE_URL;
      }
    }
  });
});

describe("developer client schema", () => {
  it("requires an owner for active clients but preserves revoked legacy clients", async () => {
    const activeClientId = `ext_${randomUUID()}`;
    const revokedClientId = `ext_${randomUUID()}`;
    await expect(
      ctx.db.execute(sql`
        INSERT INTO fitness.external_client (
          client_id,
          name,
          secret_hash,
          scopes
        ) VALUES (
          ${activeClientId},
          'Ownerless active client',
          'active-secret-hash',
          ARRAY['nutrition:write']::text[]
        )
      `),
    ).rejects.toThrow();

    await expect(
      ctx.db.execute(sql`
        INSERT INTO fitness.external_client (
          client_id,
          name,
          secret_hash,
          scopes,
          revoked_at
        ) VALUES (
          ${revokedClientId},
          'Revoked legacy client',
          'revoked-secret-hash',
          ARRAY['nutrition:write']::text[],
          now()
        )
      `),
    ).resolves.toBeDefined();
  });

  it("requires credential-free HTTPS redirects without fragments or whitespace", async () => {
    const clientId = `ext_${randomUUID()}`;
    await ctx.db.execute(sql`
      INSERT INTO fitness.external_client (
        client_id,
        owner_user_id,
        name,
        secret_hash,
        scopes
      ) VALUES (
        ${clientId},
        ${developerClientOwnerId},
        'Redirect constraints',
        'redirect-secret-hash',
        ARRAY['nutrition:write']::text[]
      )
    `);

    const invalidRedirectUris = [
      "http://client.example/callback",
      "https://user:password@client.example/callback",
      "https://client.example/callback#fragment",
      "https://client.example/call back",
      "https:///callback",
      "https://client.example:not-a-port/callback",
    ];
    for (const redirectUri of invalidRedirectUris) {
      await expect(
        ctx.db.execute(sql`
          INSERT INTO fitness.external_client_redirect_uri (client_id, redirect_uri)
          VALUES (${clientId}, ${redirectUri})
        `),
      ).rejects.toThrow();
    }

    await ctx.db.execute(sql`
      INSERT INTO fitness.external_client_redirect_uri (client_id, redirect_uri)
      VALUES
        (${clientId}, 'https://client.example/callback'),
        (${clientId}, 'https://client.example:8443/callback?email=a@b.example'),
        (${clientId}, 'https://[2001:db8::1]/callback')
    `);
    await expect(
      ctx.db.execute(sql`
        INSERT INTO fitness.external_client_redirect_uri (client_id, redirect_uri)
        VALUES (${clientId}, 'https://client.example/callback')
      `),
    ).rejects.toThrow();
  });

  it("accepts only lifecycle audit actions", async () => {
    const clientId = `ext_${randomUUID()}`;
    await ctx.db.execute(sql`
      INSERT INTO fitness.external_client (
        client_id,
        owner_user_id,
        name,
        secret_hash,
        scopes
      ) VALUES (
        ${clientId},
        ${developerClientOwnerId},
        'Audit constraints',
        'audit-secret-hash',
        ARRAY['nutrition:write']::text[]
      )
    `);
    await expect(
      ctx.db.execute(sql`
        INSERT INTO fitness.external_client_audit (client_id, actor_user_id, action)
        VALUES
          (${clientId}, ${developerClientOwnerId}, 'create'),
          (${clientId}, ${developerClientOwnerId}, 'update'),
          (${clientId}, ${developerClientOwnerId}, 'rotate'),
          (${clientId}, ${developerClientOwnerId}, 'revoke')
      `),
    ).resolves.toBeDefined();
    await expect(
      ctx.db.execute(sql`
        INSERT INTO fitness.external_client_audit (client_id, actor_user_id, action)
        VALUES (${clientId}, ${developerClientOwnerId}, 'read')
      `),
    ).rejects.toThrow();
  });

  it("deletes an owner's clients, redirects, and audit events", async () => {
    const ownerId = randomUUID();
    const clientId = `ext_${randomUUID()}`;
    await ctx.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${ownerId}, 'Deleted Developer Client Owner')
    `);
    await ctx.db.execute(sql`
      INSERT INTO fitness.external_client (
        client_id,
        owner_user_id,
        name,
        secret_hash,
        scopes
      ) VALUES (
        ${clientId},
        ${ownerId},
        'Cascade client',
        'cascade-secret-hash',
        ARRAY['nutrition:write']::text[]
      )
    `);
    await ctx.db.execute(sql`
      INSERT INTO fitness.external_client_redirect_uri (client_id, redirect_uri)
      VALUES (${clientId}, 'https://client.example/cascade')
    `);
    await ctx.db.execute(sql`
      INSERT INTO fitness.external_client_audit (client_id, actor_user_id, action)
      VALUES (${clientId}, ${ownerId}, 'create')
    `);

    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE id = ${ownerId}`);

    const rows = await ctx.db.execute<{
      audit_count: number;
      client_count: number;
      redirect_count: number;
    }>(sql`
      SELECT
        (SELECT count(*)::int FROM fitness.external_client
          WHERE client_id = ${clientId}) AS client_count,
        (SELECT count(*)::int FROM fitness.external_client_redirect_uri
          WHERE client_id = ${clientId}) AS redirect_count,
        (SELECT count(*)::int FROM fitness.external_client_audit
          WHERE client_id = ${clientId}) AS audit_count
    `);
    expect(rows[0]).toEqual({ audit_count: 0, client_count: 0, redirect_count: 0 });
  });
});
