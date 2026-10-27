import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetLegacyClimbingTables } from "./climbing-migration-test-helpers.ts";
import { runMigrations } from "./migrate.ts";
import { setupTestDatabase, type TestContext, writeTestMigrationFiles } from "./test-helpers.ts";

describe("canonical climbing context conversion", () => {
  let context: TestContext;
  let client: Client;
  const userId = "00000000-0000-4000-8000-000000000099";
  const entryId = "00000000-0000-4000-8000-000000000098";
  const activityId = "00000000-0000-4000-8000-000000000097";
  const attemptId = "00000000-0000-4000-8000-000000000096";

  beforeAll(async () => {
    context = await setupTestDatabase();
    client = new Client({ connectionString: context.connectionString });
    await client.connect();
    await resetLegacyClimbingTables(client);
    await client.query(`INSERT INTO fitness.user_profile (id, name) VALUES ('${userId}', 'Context test');
      INSERT INTO fitness.climbing_entry
        (id, user_id, provider_id, activity_id, unattached_date, provider_absent_at, external_id,
         climb_type, grade_system, grade, sent, attempt_count, lead, wall_angle_degrees, location_name, raw)
      VALUES ('${entryId}', '${userId}', 'mountain-project', NULL, '2026-09-29', '2026-09-30', 'original',
        'route', 'yds', '5.10a', false, 1, true, 40, 'Country > State > Region > Park > Crag > Wall',
        '{"Style":"Lead","Lead Style":"Fell/Hung"}'),
        (gen_random_uuid(), '${userId}', 'kaya', '${activityId}', NULL, NULL, 'gym',
        'boulder', 'v_scale', 'V3', true, 3, NULL, NULL, 'Test Gym', '{"ascent_type":{"name":"Repeat"}}'),
        (gen_random_uuid(), '${userId}', 'kaya-export', '${activityId}', NULL, NULL, 'csv-unknown-count',
        'boulder', 'v_scale', 'V3', true, 1, NULL, NULL, 'Test Gym', '{"ascentType":"Flash","attempts":null}');
      INSERT INTO fitness.climbing_attempt (id, climbing_entry_id, attempt_index, outcome, failure_reason)
        VALUES ('${attemptId}', '${entryId}', 1, 'failed', 'fell');`);
    const directory = mkdtempSync(join(tmpdir(), "climbing-context-"));
    try {
      writeTestMigrationFiles(directory, [
        {
          file: "0135_climbing_context.sql",
          when: 2_000_000_000_134,
          content: readFileSync(
            join(import.meta.dirname, "../../drizzle/0135_climbing_context.sql"),
            "utf8",
          ),
        },
      ]);
      await runMigrations(context.connectionString, directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
  afterAll(async () => {
    await client?.end();
    await context?.cleanup();
  });

  it("preserves legacy identities, raw facts, and detailed attempts", async () => {
    const { rows } = await client.query(
      `SELECT *, unattached_date::text AS date FROM fitness.v_climbing_entry WHERE id = $1`,
      [entryId],
    );
    expect(rows[0]).toMatchObject({
      id: entryId,
      user_id: userId,
      provider_id: "mountain-project",
      external_id: "original",
      activity_id: null,
      date: "2026-09-29",
      grade: "5.10a",
      grade_system: "yds",
      raw: { Style: "Lead", "Lead Style": "Fell/Hung" },
      climb_style: "lead",
      result_style: "Fell/Hung",
      lead: true,
      sent: false,
      attempt_count: null,
      wall_angle: { value: 40, unit: "degrees" },
      wall_angle_degrees: 40,
      location_path: ["Country", "State", "Region", "Park", "Crag", "Wall"].map((name) => ({
        name,
        externalId: null,
        kind: null,
      })),
      location_name: "Country > State > Region > Park > Crag > Wall",
    });
    expect(rows[0].provider_absent_at).toBeInstanceOf(Date);
    expect((await client.query("SELECT * FROM fitness.climbing_attempt")).rows).toEqual([
      expect.objectContaining({
        id: attemptId,
        climbing_entry_id: entryId,
        attempt_index: 1,
        outcome: "failed",
        failure_reason: "fell",
      }),
    ]);
    expect(
      (await client.query("SELECT * FROM fitness.v_climbing_entry WHERE external_id = 'gym'"))
        .rows[0],
    ).toMatchObject({
      activity_id: activityId,
      unattached_date: null,
      location_path: [{ name: "Test Gym", externalId: null, kind: null }],
      result_style: "Repeat",
      sent: true,
      attempt_count: 3,
    });
  });

  it.each([
    ["lead", "Flash", true, true],
    ["top-rope", null, false, null],
    ["follow", "Fell/Hung", null, false],
    ["solo", "Frenchfree", null, null],
    ["aid", "Unfamiliar", null, null],
    [null, "Attempt", null, false],
    [null, "Not sent", null, false],
    [null, "Send", null, true],
  ])("derives independent method/result %s/%s", async (method, result, lead, sent) => {
    const inserted = await client.query(
      `INSERT INTO fitness.climbing_entry
      (user_id, provider_id, climb_type, grade_system, grade, climb_style, result_style)
      VALUES ($1, 'openbeta', 'route', 'yds', '5.9', $2, $3) RETURNING id`,
      [userId, method, result],
    );
    const row = (
      await client.query(
        "SELECT lead, sent, attempt_count FROM fitness.v_climbing_entry WHERE id = $1",
        [inserted.rows[0].id],
      )
    ).rows[0];
    expect(row).toEqual({ lead, sent, attempt_count: null });
  });

  it.each([
    ["location_path", ["Wall"]],
    ["board", "Board"],
    ["location_path", [{ name: " ", externalId: null, kind: null }]],
    ["location_path", [{ name: "Wall", externalId: null, kind: null, extra: true }]],
    ["location_path", {}],
    ["board", { name: "", externalId: null }],
    ["board", { name: "Board" }],
    ["wall_angle", { value: 91, unit: "degrees" }],
    ["wall_angle", { value: "40", unit: null }],
    ["wall_angle", { value: 0, unit: "radians" }],
  ])("rejects malformed %s %j", async (column, value) => {
    await expect(
      client.query(
        `INSERT INTO fitness.climbing_entry
      (user_id, provider_id, climb_type, grade_system, grade, ${column})
      VALUES ($1, 'kaya', 'boulder', 'v_scale', 'V4', $2)`,
        [userId, JSON.stringify(value)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("clears a legacy CSV count inferred from a missing recorded count", async () => {
    expect(
      (
        await client.query(
          "SELECT result_style, attempt_count FROM fitness.v_climbing_entry WHERE external_id = 'csv-unknown-count'",
        )
      ).rows,
    ).toEqual([{ result_style: "Flash", attempt_count: null }]);
  });
  it.each([
    [{ value: -20, unit: null }, null],
    [{ value: 0, unit: "degrees" }, 0],
  ])("projects only verified degree units for %j", async (angle, degrees) => {
    const inserted = await client.query(
      `INSERT INTO fitness.climbing_entry
        (user_id, provider_id, climb_type, grade_system, grade, wall_angle)
        VALUES ($1, 'kaya', 'boulder', 'v_scale', 'V1', $2) RETURNING id`,
      [userId, JSON.stringify(angle)],
    );
    expect(
      (
        await client.query(
          "SELECT wall_angle_degrees FROM fitness.v_climbing_entry WHERE id = $1",
          [inserted.rows[0].id],
        )
      ).rows,
    ).toEqual([{ wall_angle_degrees: degrees }]);
  });
});
