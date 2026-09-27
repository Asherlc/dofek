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
const MP_WRAPPER = "20000000-0000-4000-8000-000000000001";
const OTHER_WRAPPER = "20000000-0000-4000-8000-000000000002";
const NON_MP_WRAPPER = "20000000-0000-4000-8000-000000000003";
const NON_MP_DUPLICATE_WRAPPER = "20000000-0000-4000-8000-000000000004";
const EMPTY_MP_WRAPPER = "20000000-0000-4000-8000-000000000005";
const MP_TICK = "30000000-0000-4000-8000-000000000001";
const MP_TICK_ABSENT = "30000000-0000-4000-8000-000000000002";
const NON_MP_TICK = "30000000-0000-4000-8000-000000000003";
const NON_MP_DUPLICATE_TICK = "30000000-0000-4000-8000-000000000004";
const migrationFile = "0128_unattached_mountain_project_ticks.sql";
const migrationPath = join(import.meta.dirname, "../../drizzle", migrationFile);
const validationMigrationFile = "0129_validate_unattached_mountain_project_ticks.sql";
const validationMigrationPath = join(import.meta.dirname, "../../drizzle", validationMigrationFile);

describe("Mountain Project tick migration", () => {
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
    databaseName = `mountain_ticks_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    connectionString = url.toString();
    client = new Client({ connectionString });
    await client.connect();
    migrationDirectory = mkdtempSync(join(tmpdir(), "mountain-ticks-migration-"));
    await client.query(`
      CREATE SCHEMA fitness;
      CREATE TABLE fitness.user_profile (
        id uuid PRIMARY KEY,
        name text NOT NULL
      );
      CREATE TABLE fitness.provider (
        id text PRIMARY KEY,
        name text NOT NULL,
        user_id uuid NOT NULL
      );
      CREATE TABLE fitness.activity (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL,
        provider_id text NOT NULL,
        external_id text NOT NULL,
        canonical_type text NOT NULL,
        provider_type text NOT NULL,
        started_at timestamptz NOT NULL,
        deleted_at timestamptz,
        provider_absent_at timestamptz
      );
      CREATE TABLE fitness.climbing_entry (
        id uuid PRIMARY KEY,
        activity_id uuid NOT NULL,
        external_id text,
        climb_type text NOT NULL,
        grade_system text NOT NULL,
        grade text NOT NULL,
        sent boolean,
        attempt_count integer,
        raw jsonb,
        CONSTRAINT climbing_entry_activity_id_fkey
          FOREIGN KEY (activity_id) REFERENCES fitness.activity(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX climbing_entry_activity_external_id_idx
        ON fitness.climbing_entry (activity_id, external_id) WHERE external_id IS NOT NULL;
    `);
    await client.query(`
      INSERT INTO fitness.user_profile (id, name) VALUES ('${USER}', 'Climber');
      INSERT INTO fitness.provider (id, name, user_id) VALUES
        ('mountain-project', 'Mountain Project', '${USER}'),
        ('kaya-export', 'Kaya', '${USER}');
      INSERT INTO fitness.activity (id, user_id, provider_id, external_id, canonical_type,
        provider_type, started_at, provider_absent_at) VALUES
        ('${MP_WRAPPER}', '${USER}', 'mountain-project', 'wrapper-one', 'climbing', 'climbing', '2026-05-04T00:00:00Z', NULL),
        ('${OTHER_WRAPPER}', '${USER}', 'mountain-project', 'wrapper-two', 'climbing', 'climbing', '2026-05-05T00:00:00Z', '2026-06-01T00:00:00Z'),
        ('${NON_MP_WRAPPER}', '${USER}', 'kaya-export', 'wrapper-three', 'climbing', 'climbing', '2026-05-06T14:00:00Z', NULL),
        ('${NON_MP_DUPLICATE_WRAPPER}', '${USER}', 'kaya-export', 'wrapper-four', 'climbing', 'climbing', '2026-05-07T14:00:00Z', NULL),
        ('${EMPTY_MP_WRAPPER}', '${USER}', 'mountain-project', 'wrapper-empty', 'climbing', 'climbing', '2026-05-08T00:00:00Z', NULL);
      INSERT INTO fitness.climbing_entry (id, activity_id, external_id, climb_type, grade_system, grade, sent, attempt_count, raw) VALUES
        ('${MP_TICK}', '${MP_WRAPPER}', 'tick-one', 'boulder', 'v_scale', 'V4', true, 1, '{"preserve":"one"}'),
        ('${MP_TICK_ABSENT}', '${OTHER_WRAPPER}', 'tick-two', 'route', 'yds', '5.10a', true, 1, '{"preserve":"two"}'),
        ('${NON_MP_TICK}', '${NON_MP_WRAPPER}', 'kaya-one', 'boulder', 'v_scale', 'V2', true, 1, '{"preserve":"kaya"}'),
        ('${NON_MP_DUPLICATE_TICK}', '${NON_MP_DUPLICATE_WRAPPER}', 'kaya-one', 'boulder', 'v_scale', 'V3', true, 1, '{"preserve":"kaya-duplicate"}');
    `);
  }, 60_000);

  afterEach(async () => {
    await client?.end();
    if (databaseName)
      await admin.query(`DROP DATABASE ${escapeIdentifier(databaseName)} WITH (FORCE)`);
    await admin?.end();
    if (migrationDirectory) rmSync(migrationDirectory, { recursive: true, force: true });
  });

  it("detaches and retires Mountain Project wrappers while retaining every tick", async () => {
    expect(existsSync(migrationPath), "tick migration must exist").toBe(true);
    const journal = z
      .object({
        entries: z.array(z.object({ tag: z.string(), when: z.number() })),
      })
      .parse(
        JSON.parse(
          readFileSync(join(import.meta.dirname, "../../drizzle/meta/_journal.json"), "utf8"),
        ),
      );
    const migrationEntries = [migrationFile, validationMigrationFile].map((file, index) => {
      const tag = file.replace(/\.sql$/, "");
      return {
        content: readFileSync(join(import.meta.dirname, "../../drizzle", file), "utf8"),
        file,
        when: journal.entries.find((entry) => entry.tag === tag)?.when ?? 1_790_000_000_000 + index,
      };
    });
    expect(existsSync(validationMigrationPath), "constraint validation migration must exist").toBe(
      true,
    );
    writeTestMigrationFiles(migrationDirectory, migrationEntries);
    expect(await runMigrations(connectionString, migrationDirectory)).toBe(2);

    const ticks = await client.query(`SELECT id, user_id, provider_id, activity_id,
      unattached_date::text, provider_absent_at, raw
      FROM fitness.climbing_entry ORDER BY id`);
    expect(ticks.rows).toEqual([
      {
        id: MP_TICK,
        user_id: USER,
        provider_id: "mountain-project",
        activity_id: null,
        unattached_date: "2026-05-04",
        provider_absent_at: null,
        raw: { preserve: "one" },
      },
      {
        id: MP_TICK_ABSENT,
        user_id: USER,
        provider_id: "mountain-project",
        activity_id: null,
        unattached_date: "2026-05-05",
        provider_absent_at: new Date("2026-06-01T00:00:00.000Z"),
        raw: { preserve: "two" },
      },
      {
        id: NON_MP_TICK,
        user_id: USER,
        provider_id: "kaya-export",
        activity_id: NON_MP_WRAPPER,
        unattached_date: null,
        provider_absent_at: null,
        raw: { preserve: "kaya" },
      },
      {
        id: NON_MP_DUPLICATE_TICK,
        user_id: USER,
        provider_id: "kaya-export",
        activity_id: NON_MP_DUPLICATE_WRAPPER,
        unattached_date: null,
        provider_absent_at: null,
        raw: { preserve: "kaya-duplicate" },
      },
    ]);
    expect((await client.query("SELECT count(*) FROM fitness.climbing_entry")).rows).toEqual([
      { count: "4" },
    ]);
    expect(
      (await client.query("SELECT id FROM fitness.activity WHERE deleted_at IS NULL ORDER BY id"))
        .rows,
    ).toEqual([{ id: NON_MP_WRAPPER }, { id: NON_MP_DUPLICATE_WRAPPER }]);
  });
});
