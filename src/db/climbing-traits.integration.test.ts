import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";

const migrationDirectory = resolve(import.meta.dirname, "../../drizzle");
let client: Client;
let admin: Client;
const databaseName = `dofek_traits_${randomUUID().replaceAll("-", "")}`;

beforeAll(async () => {
  const adminUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!adminUrl) throw new Error("TEST_DATABASE_URL is required for climbing trait tests.");
  admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  client = new Client({ connectionString: databaseUrl.toString() });
  await client.connect();
  await client.query(`
    CREATE SCHEMA fitness;
    CREATE TYPE fitness.climbing_hold_type AS ENUM ('crimp', 'sloper', 'pinch', 'pocket', 'jug');
    CREATE TYPE fitness.climb_setting AS ENUM ('indoor', 'outdoor');
    CREATE TABLE fitness.area (
      id uuid, user_id uuid, provider_id text, name text, external_id text,
      parent_area_id uuid, coordinates point
    );
    CREATE TABLE fitness.climb (
      id uuid, name text, kind text, setting fitness.climb_setting,
      route_protection text[], coordinates point, area_id uuid
    );
    CREATE TABLE fitness.climbing_log_entry (
      id uuid PRIMARY KEY, user_id uuid, provider_id text, external_id text,
      climb_id uuid, activity_id uuid, climbed_on date, discipline text,
      title text, notes text, board jsonb, wall_angle jsonb,
      hold_type fitness.climbing_hold_type, source_name text, raw jsonb,
      provider_absent_at timestamptz, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE fitness.climb_grade (climb_id uuid, value text, system text, position bigint);
    CREATE TABLE fitness.climbing_log_entry_grade (
      climbing_log_entry_id uuid, value text, system text, position bigint
    );
    CREATE TABLE fitness.climbing_attempt (
      id uuid PRIMARY KEY, climbing_log_entry_id uuid, scope text, outcome text,
      fell_or_hung boolean, used_aid boolean, dabbed boolean
    );
    CREATE VIEW fitness.v_climbing_attempt AS SELECT * FROM fitness.climbing_attempt;
  `);
  await client.query(
    readFileSync(resolve(migrationDirectory, "0164_climbing_catalogue_setting.sql"), "utf8"),
  );
  const legacyAngleFunction = readFileSync(
    resolve(migrationDirectory, "0135_climbing_context.sql"),
    "utf8",
  )
    .split("CREATE OR REPLACE FUNCTION fitness.climbing_wall_angle_valid")[1]
    ?.split("--> statement-breakpoint")[0];
  if (!legacyAngleFunction) throw new Error("Legacy wall-angle validator is required.");
  await client.query(
    `CREATE OR REPLACE FUNCTION fitness.climbing_wall_angle_valid${legacyAngleFunction}`,
  );
  await client.query(
    "ALTER TABLE fitness.climbing_log_entry ADD CONSTRAINT climbing_log_entry_wall_angle_valid CHECK (fitness.climbing_wall_angle_valid(wall_angle))",
  );
});

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(databaseName)}`);
    await admin.end();
  }
});

it("migrates recorded scalar grips in one transaction and serves categories and nonempty grip collections", async () => {
  const known = randomUUID();
  const missing = randomUUID();
  const activity = randomUUID();
  const attempt = randomUUID();
  await client.query(
    `INSERT INTO fitness.climbing_log_entry (id, hold_type, activity_id) VALUES ($1, 'crimp', $3), ($2, NULL, NULL)`,
    [known, missing, activity],
  );
  await client.query(
    `INSERT INTO fitness.climbing_attempt (id, climbing_log_entry_id, scope) VALUES ($1, $2, 'climb')`,
    [attempt, known],
  );
  await client.query("BEGIN");
  try {
    const migration = readFileSync(resolve(migrationDirectory, "0170_climbing_traits.sql"), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  expect(
    (
      await client.query(
        "SELECT id, hold_types::text[], activity_id FROM fitness.v_climbing_log_entry ORDER BY id",
      )
    ).rows,
  ).toEqual(
    expect.arrayContaining([
      { id: known, hold_types: ["crimp"], activity_id: activity },
      { id: missing, hold_types: null, activity_id: null },
    ]),
  );
  expect((await client.query("SELECT id FROM fitness.climbing_attempt")).rows).toEqual([
    { id: attempt },
  ]);
  await client.query(
    `UPDATE fitness.climbing_log_entry SET hold_types = ARRAY['volume', 'jam', 'no_grips']::fitness.climbing_hold_type[], wall_angle = '{"category":"slab"}' WHERE id = $1`,
    [known],
  );
  expect(
    (
      await client.query(
        "SELECT hold_types::text[], wall_angle FROM fitness.v_climbing_log_entry WHERE id = $1",
        [known],
      )
    ).rows,
  ).toEqual([{ hold_types: ["volume", "jam", "no_grips"], wall_angle: { category: "slab" } }]);
  for (const holds of ["'{}'", "ARRAY[NULL]", "ARRAY['crimp',NULL]"]) {
    await expect(
      client.query(
        `UPDATE fitness.climbing_log_entry SET hold_types = ${holds}::fitness.climbing_hold_type[] WHERE id = $1`,
        [known],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  }
  for (const angle of [
    { category: "roof" },
    { category: "vertical" },
    { category: "overhang" },
    { value: -120, unit: null },
    { value: 40, unit: "degrees" },
  ]) {
    await client.query("UPDATE fitness.climbing_log_entry SET wall_angle = $1 WHERE id = $2", [
      angle,
      known,
    ]);
  }
  for (const angle of [
    { category: "invented" },
    { category: "slab", value: -20, unit: "degrees" },
    { value: 91, unit: "degrees" },
    { category: null },
  ]) {
    await expect(
      client.query("UPDATE fitness.climbing_log_entry SET wall_angle = $1 WHERE id = $2", [
        angle,
        known,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  }
});
