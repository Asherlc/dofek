import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "./migrate.ts";
import { writeTestMigrationFiles } from "./test-helpers.ts";

const USER = "10000000-0000-4000-8000-000000000001";
const OTHER_USER = "10000000-0000-4000-8000-000000000002";
const FIRST = "20000000-0000-4000-8000-000000000001";
const REPRESENTATIVE = "20000000-0000-4000-8000-000000000002";
const DELETED = "20000000-0000-4000-8000-000000000003";
const ABSENT = "20000000-0000-4000-8000-000000000004";
const OTHER = "20000000-0000-4000-8000-000000000005";
const migrationFile = "0112_stable_activity_groups.sql";
const migrationPath = join(import.meta.dirname, "../../drizzle", migrationFile);
const groupRow = z.object({ group_id: z.string(), id: z.string(), user_id: z.string() });
const visibleRow = z.object({ id: z.string(), member_activity_ids: z.array(z.string()) });

describe("stable activity group migration", () => {
  let admin: Client;
  let client: Client;
  let databaseName: string;
  let connectionString: string;
  let migrationDirectory: string;

  beforeEach(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL;
    if (!adminUrl) throw new Error("TEST_DATABASE_URL is required; run pnpm test:integration");
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    databaseName = `stable_groups_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    connectionString = url.toString();
    client = new Client({ connectionString });
    await client.connect();
    migrationDirectory = mkdtempSync(join(tmpdir(), "stable-groups-migration-"));
    // Minimal pre-0110 tables, with the actual deployed overlap view below.
    await client.query(`
      CREATE SCHEMA fitness;
      CREATE TABLE fitness.user_profile (id uuid PRIMARY KEY);
      CREATE TABLE fitness.provider (id text PRIMARY KEY);
      CREATE TABLE fitness.provider_priority (provider_id text PRIMARY KEY, priority integer);
      CREATE TABLE fitness.device_priority (provider_id text, source_name_pattern text, priority integer);
      CREATE TABLE fitness.activity (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
        provider_id text NOT NULL REFERENCES fitness.provider(id),
        external_id text NOT NULL,
        canonical_type text NOT NULL DEFAULT 'cycling',
        provider_type text NOT NULL DEFAULT 'cycling',
        modality text,
        started_at timestamptz NOT NULL DEFAULT '2026-09-01T08:00:00Z',
        ended_at timestamptz DEFAULT '2026-09-01T09:00:00Z',
        created_at timestamptz NOT NULL DEFAULT '2026-09-01T10:00:00Z',
        provider_absent_at timestamptz, deleted_at timestamptz,
        name text, notes text, raw jsonb, source_name text, strava_id text,
        perceived_exertion real, timezone text,
        start_utc_offset_minutes bigint, end_utc_offset_minutes bigint,
        local_time_source text NOT NULL DEFAULT 'unknown',
        UNIQUE (user_id, provider_id, external_id)
      );
      INSERT INTO fitness.user_profile VALUES ('${USER}'), ('${OTHER_USER}');
      INSERT INTO fitness.provider VALUES ('provider-a'), ('provider-b');
      INSERT INTO fitness.provider_priority VALUES ('provider-a', 100), ('provider-b', 10);
      INSERT INTO fitness.activity (id, user_id, provider_id, external_id) VALUES
        ('${FIRST}', '${USER}', 'provider-a', 'first'),
        ('${REPRESENTATIVE}', '${USER}', 'provider-b', 'representative'),
        ('${DELETED}', '${USER}', 'provider-a', 'deleted'),
        ('${ABSENT}', '${USER}', 'provider-a', 'absent'),
        ('${OTHER}', '${OTHER_USER}', 'provider-a', 'other');
      UPDATE fitness.activity SET deleted_at = now() WHERE id = '${DELETED}';
      UPDATE fitness.activity SET provider_absent_at = now(),
        started_at = '2026-08-01T08:00:00Z', ended_at = '2026-08-01T09:00:00Z'
        WHERE id = '${ABSENT}';
    `);
    await client.query(
      readFileSync(
        join(import.meta.dirname, "../../drizzle/0109_v_activity_atomic_local_time_context.sql"),
        "utf8",
      ),
    );
  }, 60_000);

  afterEach(async () => {
    await client?.end();
    if (databaseName)
      await admin.query(`DROP DATABASE ${escapeIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
    if (migrationDirectory) rmSync(migrationDirectory, { recursive: true, force: true });
  });

  async function assertPreMigration(): Promise<void> {
    expect(
      (
        await client.query(`SELECT
      to_regclass('fitness.activity_group') IS NULL AS no_groups,
      to_regclass('fitness.activity_group_alias') IS NULL AS no_aliases,
      NOT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'fitness' AND table_name = 'activity' AND column_name = 'group_id') AS no_membership
    `)
      ).rows,
    ).toEqual([{ no_aliases: true, no_groups: true, no_membership: true }]);
  }

  async function applyMigration(suffix = ""): Promise<number> {
    expect(existsSync(migrationPath), "stable group migration must exist").toBe(true);
    writeTestMigrationFiles(migrationDirectory, [
      {
        content: readFileSync(migrationPath, "utf8") + suffix,
        file: migrationFile,
        when: 1_788_768_000_000,
      },
    ]);
    return runMigrations(connectionString, migrationDirectory);
  }

  async function insertActivity(id: string, extra = ""): Promise<void> {
    await client.query(
      `INSERT INTO fitness.activity (id, user_id, provider_id, external_id)
      VALUES ($1, $2, 'provider-a', $3) ${extra}`,
      [id, USER, id],
    );
  }

  it("preserves public IDs and assigns every historical member a same-user group", async () => {
    await assertPreMigration();
    const before = visibleRow
      .array()
      .parse(
        (await client.query("SELECT id, member_activity_ids FROM fitness.v_activity ORDER BY id"))
          .rows,
      );
    expect(before).toEqual([
      { id: REPRESENTATIVE, member_activity_ids: [FIRST, REPRESENTATIVE] },
      { id: OTHER, member_activity_ids: [OTHER] },
    ]);
    expect(await applyMigration()).toBe(1);
    expect(
      (await client.query("SELECT id, member_activity_ids FROM fitness.v_activity ORDER BY id"))
        .rows,
    ).toEqual(before);
    const members = groupRow
      .array()
      .parse(
        (await client.query("SELECT id, group_id, user_id FROM fitness.activity ORDER BY id")).rows,
      );
    expect(members).toEqual([
      { id: FIRST, group_id: REPRESENTATIVE, user_id: USER },
      { id: REPRESENTATIVE, group_id: REPRESENTATIVE, user_id: USER },
      { id: DELETED, group_id: DELETED, user_id: USER },
      { id: ABSENT, group_id: ABSENT, user_id: USER },
      { id: OTHER, group_id: OTHER, user_id: OTHER_USER },
    ]);
    expect(
      (
        await client.query(`SELECT a.id FROM fitness.activity a
      LEFT JOIN fitness.activity_group g ON g.id = a.group_id AND g.user_id = a.user_id
      WHERE g.id IS NULL`)
      ).rows,
    ).toEqual([]);
    expect(
      (
        await client.query(
          `SELECT id, anchor_activity_id, created_at FROM fitness.activity_group
      WHERE id = $1`,
          [REPRESENTATIVE],
        )
      ).rows,
    ).toEqual([
      {
        id: REPRESENTATIVE,
        anchor_activity_id: REPRESENTATIVE,
        created_at: new Date("2026-09-01T10:00:00Z"),
      },
    ]);
  });

  it("creates singleton groups for direct inserts without leaking groups on upserts or rollback", async () => {
    await applyMigration();
    const id = randomUUID();
    await insertActivity(id);
    expect(
      (
        await client.query(
          `SELECT g.anchor_activity_id, g.user_id FROM fitness.activity a
      JOIN fitness.activity_group g ON g.id = a.group_id WHERE a.id = $1`,
          [id],
        )
      ).rows,
    ).toEqual([{ anchor_activity_id: id, user_id: USER }]);
    const countBefore = (await client.query("SELECT count(*) FROM fitness.activity_group")).rows;
    await insertActivity(id, "ON CONFLICT (id) DO NOTHING");
    expect((await client.query("SELECT count(*) FROM fitness.activity_group")).rows).toEqual(
      countBefore,
    );
    await client.query(
      `INSERT INTO fitness.activity (user_id, provider_id, external_id, name)
      VALUES ($1, 'provider-a', $2, 'updated')
      ON CONFLICT (user_id, provider_id, external_id) DO UPDATE SET name = excluded.name`,
      [USER, id],
    );
    expect((await client.query("SELECT count(*) FROM fitness.activity_group")).rows).toEqual(
      countBefore,
    );
    await client.query("BEGIN");
    await insertActivity(randomUUID());
    await client.query("ROLLBACK");
    expect((await client.query("SELECT count(*) FROM fitness.activity_group")).rows).toEqual(
      countBefore,
    );
  });

  it("enforces membership ownership and alias target ownership, reason, and non-self identity", async () => {
    await applyMigration();
    await expect(
      client.query("UPDATE fitness.activity SET group_id = $1 WHERE id = $2", [OTHER, FIRST]),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query("UPDATE fitness.activity SET group_id = NULL WHERE id = $1", [FIRST]),
    ).rejects.toMatchObject({ code: "23502" });
    await expect(
      client.query("UPDATE fitness.activity SET group_id = $1 WHERE id = $2", [
        randomUUID(),
        FIRST,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    const alias = randomUUID();
    const insertAlias = (aliasId: string, groupId: string, reason: string) =>
      client.query(
        "INSERT INTO fitness.activity_group_alias (alias_id, group_id, user_id, reason) VALUES ($1, $2, $3, $4)",
        [aliasId, groupId, USER, reason],
      );
    await expect(insertAlias(alias, OTHER, "merge")).rejects.toMatchObject({ code: "23503" });
    await expect(insertAlias(REPRESENTATIVE, REPRESENTATIVE, "merge")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insertAlias(alias, REPRESENTATIVE, "unknown")).rejects.toMatchObject({
      code: "23514",
    });
    await insertAlias(alias, REPRESENTATIVE, "merge");
    expect(
      (
        await client.query(
          "SELECT group_id FROM fitness.activity_group_alias WHERE alias_id = $1",
          [alias],
        )
      ).rows,
    ).toEqual([{ group_id: REPRESENTATIVE }]);
  });

  it("rolls back all schema and membership work when the migration transaction fails", async () => {
    await assertPreMigration();
    await expect(applyMigration("\n--> statement-breakpoint\nSELECT 1 / 0;")).rejects.toThrow(
      /division by zero/,
    );
    await assertPreMigration();
    expect((await client.query("SELECT count(*) FROM fitness.activity")).rows).toEqual([
      { count: "5" },
    ]);
    expect(await applyMigration()).toBe(1);
  });
});
