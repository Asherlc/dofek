import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, escapeIdentifier } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../drizzle/0150_require_climbing_route_methods.sql", import.meta.url),
  "utf8",
);

describe("required route method upgrade", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL?.trim();
    if (!adminUrl)
      throw new Error("TEST_DATABASE_URL is required for route method migration tests.");
    const databaseName = `dofek_route_method_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
    } finally {
      await admin.end();
    }
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    client = new Client({ connectionString: databaseUrl.toString() });
    cleanup = async () => {
      await client.end();
      const drop = new Client({ connectionString: adminUrl });
      await drop.connect();
      try {
        await drop.query(`DROP DATABASE ${escapeIdentifier(databaseName)}`);
      } finally {
        await drop.end();
      }
    };
    await client.connect();
    await client.query(`
      CREATE SCHEMA fitness;
      CREATE TABLE fitness.climb (id uuid PRIMARY KEY, kind text);
      CREATE TABLE fitness.climbing_log_entry (
        id uuid PRIMARY KEY, provider_id text, external_id text,
        climb_id uuid REFERENCES fitness.climb(id), raw jsonb
      );
      CREATE TABLE fitness.climbing_attempt (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        climbing_log_entry_id uuid NOT NULL REFERENCES fitness.climbing_log_entry(id),
        scope text NOT NULL DEFAULT 'climb', rope_method text
      );
    `);
  });
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function migrate() {
    await client.query("BEGIN");
    let committed = false;
    try {
      for (const statement of migration.split("--> statement-breakpoint"))
        if (statement.trim()) await client.query(statement);
      await client.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK");
    }
  }
  async function seed(kind: string, method: string | null) {
    const climbId = randomUUID();
    const logId = randomUUID();
    const attemptId = randomUUID();
    await client.query("INSERT INTO fitness.climb VALUES ($1, $2)", [climbId, kind]);
    await client.query(
      "INSERT INTO fitness.climbing_log_entry VALUES ($1, 'test-provider', 'source-42', $2, $3)",
      [logId, climbId, { attempts: 1, sourceFact: "Retained evidence" }],
    );
    await client.query(
      "INSERT INTO fitness.climbing_attempt (id, climbing_log_entry_id, rope_method) VALUES ($1, $2, $3)",
      [attemptId, logId, method],
    );
    return { logId, attemptId };
  }

  it("blocks unresolved legacy routes while preserving their identities and raw evidence", async () => {
    const { logId, attemptId } = await seed("route", null);
    const before = (await client.query("SELECT * FROM fitness.climbing_log_entry")).rows;
    await expect(migrate()).rejects.toMatchObject({
      code: "23514",
      constraint: "climbing_attempt_route_method_required",
      message: expect.stringContaining(attemptId),
    });
    expect((await client.query("SELECT * FROM fitness.climbing_log_entry")).rows).toEqual(before);
    expect((await client.query("SELECT * FROM fitness.climbing_attempt")).rows).toEqual([
      { id: attemptId, climbing_log_entry_id: logId, scope: "climb", rope_method: null },
    ]);
    await client.query(
      "UPDATE fitness.climbing_attempt SET rope_method = 'top_rope' WHERE id = $1",
      [attemptId],
    );
    await migrate();
    expect((await client.query("SELECT * FROM fitness.climbing_log_entry")).rows).toEqual(before);
    expect(
      (
        await client.query("SELECT rope_method FROM fitness.climbing_attempt WHERE id = $1", [
          attemptId,
        ])
      ).rows,
    ).toEqual([{ rope_method: "top_rope" }]);
  });

  it("upgrades valid routes and methodless boulders then enforces future route writes", async () => {
    const route = await seed("route", "follow");
    await seed("boulder", null);
    await migrate();
    await expect(
      client.query("INSERT INTO fitness.climbing_attempt (climbing_log_entry_id) VALUES ($1)", [
        route.logId,
      ]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "climbing_attempt_route_method_required",
    });
    expect(
      (await client.query("SELECT count(*)::int AS count FROM fitness.climbing_attempt")).rows,
    ).toEqual([{ count: 2 }]);
  });
});
