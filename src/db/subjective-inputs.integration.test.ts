import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.ts";
import { setupTestDatabase, type TestContext, writeTestMigrationFiles } from "./test-helpers.ts";

const USER_ID = "10000000-0000-4000-8000-000000002247";
const ACTIVITY_ID = "20000000-0000-4000-8000-000000002247";

describe("subjective input persistence (integration)", () => {
  let context: TestContext;
  let client: Client;

  beforeAll(async () => {
    context = await setupTestDatabase();
    client = new Client({ connectionString: context.connectionString });
    await client.connect();
    await client.query(
      `INSERT INTO fitness.user_profile (id, name) VALUES ($1, 'Subjective Test User')`,
      [USER_ID],
    );
    await client.query(
      `INSERT INTO fitness.provider (id, name) VALUES ('subjective-fixture', 'Subjective Fixture')`,
    );
    await client.query(
      `INSERT INTO fitness.activity (
         id, user_id, provider_id, external_id, provider_type, canonical_type, started_at
       )
       VALUES ($1, $2, 'subjective-fixture', 'activity-2247', 'running', 'running', NOW())`,
      [ACTIVITY_ID, USER_ID],
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await context?.cleanup();
  });

  it("seeds stable bilateral hand and pulley region references", async () => {
    const result = await client.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id
       FROM fitness.body_region
       WHERE id IN (
         'left_hand', 'right_hand', 'left_hand_thumb',
         'left_hand_index_a1_pulley', 'left_hand_index_a5_pulley',
         'right_hand_little_a1_pulley', 'right_hand_little_a5_pulley'
       )
       ORDER BY id`,
    );

    expect(result.rows).toEqual([
      { id: "left_hand", parent_id: "left_upper_limb" },
      { id: "left_hand_index_a1_pulley", parent_id: "left_hand_index" },
      { id: "left_hand_index_a5_pulley", parent_id: "left_hand_index" },
      { id: "left_hand_thumb", parent_id: "left_hand" },
      { id: "right_hand", parent_id: "right_upper_limb" },
      { id: "right_hand_little_a1_pulley", parent_id: "right_hand_little" },
      { id: "right_hand_little_a5_pulley", parent_id: "right_hand_little" },
    ]);
  });

  it("allows a canonical all-clear check-in with no symptom rows", async () => {
    await client.query(
      `INSERT INTO fitness.subjective_check_in (user_id, date) VALUES ($1, '2026-08-02')`,
      [USER_ID],
    );
    const result = await client.query<{ symptom_count: string }>(
      `SELECT count(*)::text AS symptom_count
       FROM fitness.subjective_symptom symptom
       JOIN fitness.subjective_check_in check_in ON check_in.id = symptom.check_in_id
       WHERE check_in.user_id = $1 AND check_in.date = '2026-08-02'`,
      [USER_ID],
    );

    expect(result.rows).toEqual([{ symptom_count: "0" }]);
  });

  it("rejects out-of-range activity RPE, invalid symptom scores, and reversed injury dates", async () => {
    await expect(
      client.query(`UPDATE fitness.activity SET perceived_exertion = 10.1 WHERE id = $1`, [
        ACTIVITY_ID,
      ]),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      client.query(
        `INSERT INTO fitness.subjective_symptom (check_in_id, body_region_id, kind, score)
         SELECT id, 'left_hand', 'soreness', 0
         FROM fitness.subjective_check_in
         WHERE user_id = $1 AND date = '2026-08-02'`,
        [USER_ID],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      client.query(
        `INSERT INTO fitness.injury_event
          (user_id, kind, body_region_id, onset_date, resolved_date, severity, description)
         VALUES ($1, 'injury', 'left_hand', '2026-08-02', '2026-08-01', 4, 'Finger pain')`,
        [USER_ID],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("repairs a database that skipped the subjective-input migration", async () => {
    const migrationDirectory = mkdtempSync(join(tmpdir(), "subjective-input-repair-"));
    const migrationFile = "0070_repair_subjective_inputs.sql";
    const migrationContent = readFileSync(
      resolve(import.meta.dirname, "../../drizzle", migrationFile),
      "utf8",
    );

    try {
      await client.query(
        readFileSync(
          resolve(import.meta.dirname, "../../drizzle/_views/01_v_activity.sql"),
          "utf8",
        ),
      );
      await client.query("DROP TABLE IF EXISTS health.stale_v_activity");
      await client.query(`
        CREATE TABLE health.stale_v_activity AS
        SELECT
          id,
          provider_id,
          user_id,
          primary_activity_id,
          canonical_type,
          provider_type,
          modality,
          started_at,
          ended_at,
          source_name,
          name,
          notes,
          timezone,
          raw,
          source_providers,
          source_external_ids,
          member_activity_ids,
          absent_source_external_ids,
          start_utc_offset_minutes,
          end_utc_offset_minutes,
          local_time_source
        FROM fitness.v_activity
      `);
      await client.query("DROP VIEW fitness.v_activity CASCADE");
      await client.query(`CREATE VIEW fitness.v_activity AS SELECT * FROM health.stale_v_activity`);
      await client.query(
        "DROP TABLE fitness.injury_event, fitness.subjective_symptom, fitness.subjective_check_in, fitness.body_region",
      );
      await client.query(
        "ALTER TABLE fitness.activity DROP CONSTRAINT IF EXISTS activity_perceived_exertion_range",
      );

      writeTestMigrationFiles(migrationDirectory, [
        { content: migrationContent, file: migrationFile, when: 1785770820000 },
      ]);

      await expect(runMigrations(context.connectionString, migrationDirectory)).resolves.toBe(1);

      const viewColumns = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'fitness' AND table_name = 'v_activity'
         ORDER BY ordinal_position`,
      );
      expect(viewColumns.rows.at(-1)).toEqual({ column_name: "perceived_exertion" });

      await client.query("UPDATE fitness.activity SET perceived_exertion = 7.5 WHERE id = $1", [
        ACTIVITY_ID,
      ]);
      const activity = await client.query<{ perceived_exertion: number }>(
        "SELECT perceived_exertion FROM fitness.v_activity WHERE id = $1",
        [ACTIVITY_ID],
      );
      expect(activity.rows).toEqual([{ perceived_exertion: 7.5 }]);

      const restoredTables = await client.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'fitness'
           AND table_name IN ('body_region', 'subjective_check_in', 'subjective_symptom', 'injury_event')
         ORDER BY table_name`,
      );
      expect(restoredTables.rows).toEqual([
        { table_name: "body_region" },
        { table_name: "injury_event" },
        { table_name: "subjective_check_in" },
        { table_name: "subjective_symptom" },
      ]);
    } finally {
      rmSync(migrationDirectory, { force: true, recursive: true });
    }
  });
});
