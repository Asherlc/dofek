import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erasePostgresAccount } from "../src/account-erasure/postgres-erasure.ts";
import { initiateAccountErasure } from "../src/db/account-erasure.ts";
import { setupTestDatabase, type TestContext } from "../src/db/test-helpers.ts";
import { backfillExerciseProvenance } from "./backfill-exercise-provenance.ts";

const userId = "10000000-0000-4000-8000-000000001996";
const seededExerciseId = "20000000-0000-4000-8000-000000001996";
const userExerciseId = "20000000-0000-4000-8000-000000001997";

describe("exercise provenance backfill (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${userId}::uuid, 'Historical Exercise User')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES ('historical-strength', 'Historical Strength')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.exercise (
            id,
            name,
            muscle_group,
            muscle_groups,
            equipment,
            exercise_type,
            movement
          )
          VALUES
            (
              ${seededExerciseId}::uuid,
              'Back Squat',
              'legs',
              ARRAY['legs'],
              'barbell',
              'strength',
              'compound'
            ),
            (
              ${userExerciseId}::uuid,
              'Bench Press',
              'triceps',
              ARRAY['triceps'],
              'barbell',
              'strength',
              'compound'
            )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.exercise_alias (
            id, exercise_id, provider_id, provider_exercise_name
          )
          VALUES (
            '30000000-0000-4000-8000-000000001996'::uuid,
            ${userExerciseId}::uuid,
            'historical-strength',
            'Historical Exercise Alias'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.activity (
            id,
            provider_id,
            user_id,
            external_id,
            canonical_type,
            provider_type,
            started_at
          )
          VALUES (
            '40000000-0000-4000-8000-000000001996'::uuid,
            'historical-strength',
            ${userId}::uuid,
            'historical-activity-1996',
            'strength',
            'strength',
            '2026-01-01T00:00:00.000Z'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.strength_set (
            activity_id,
            exercise_id,
            exercise_index,
            set_index,
            set_type
          )
          VALUES
            (
              '40000000-0000-4000-8000-000000001996'::uuid,
              ${seededExerciseId}::uuid,
              0,
              0,
              'working'
            ),
            (
              '40000000-0000-4000-8000-000000001996'::uuid,
              ${userExerciseId}::uuid,
              1,
              0,
              'working'
            )`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("retains only exact historical system definitions during user erasure", async () => {
    const client = {
      query: async (queryText: string, values?: unknown[]) => {
        const result = await context.db.$client.query(queryText, values);
        return { rowCount: result.rowCount, rows: result.rows };
      },
    };

    await expect(backfillExerciseProvenance(client)).resolves.toEqual({
      aliasSourcesInserted: 1,
      exerciseSourcesInserted: 3,
    });
    await expect(backfillExerciseProvenance(client)).resolves.toEqual({
      aliasSourcesInserted: 0,
      exerciseSourcesInserted: 0,
    });

    const sourceRows = await context.db.execute(
      sql`SELECT exercise_id, source_kind
          FROM fitness.exercise_source
          ORDER BY exercise_id, source_kind`,
    );
    expect(sourceRows).toEqual([
      { exercise_id: seededExerciseId, source_kind: "system" },
      { exercise_id: seededExerciseId, source_kind: "user" },
      { exercise_id: userExerciseId, source_kind: "user" },
    ]);

    const request = await initiateAccountErasure(
      context.db,
      userId,
      async () => "encrypted-historical-exercise-snapshot",
      async () => undefined,
    );
    await erasePostgresAccount(context.db, request.requestId, userId);

    await expect(
      context.db.execute(
        sql`SELECT id, name
            FROM fitness.exercise
            WHERE id IN (${seededExerciseId}::uuid, ${userExerciseId}::uuid)
            ORDER BY id`,
      ),
    ).resolves.toEqual([{ id: seededExerciseId, name: "Back Squat" }]);
  });
});
