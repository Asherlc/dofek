import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "./index.ts";
import { executeWithSchema } from "./typed-sql.ts";

const resolvedExerciseRowSchema = z.object({
  alias_exercise_id: z.uuid(),
  exercise_id: z.uuid(),
  source_linked: z.boolean(),
});

export interface SystemSeededExerciseDefinition {
  equipment: string;
  exerciseType: string;
  movement: string;
  muscleGroup: string;
  muscleGroups: readonly string[];
  name: string;
  sourceKind: "system";
}

/**
 * Stable identities for the review seed's shared catalog rows. Historical
 * backfills match every persisted attribute, so retain old definitions here
 * if the review catalog ever changes.
 */
export const SYSTEM_SEEDED_EXERCISE_DEFINITIONS = [
  {
    equipment: "barbell",
    exerciseType: "strength",
    movement: "compound",
    muscleGroup: "legs",
    muscleGroups: ["legs"],
    name: "Back Squat",
    sourceKind: "system",
  },
  {
    equipment: "barbell",
    exerciseType: "strength",
    movement: "compound",
    muscleGroup: "chest",
    muscleGroups: ["chest"],
    name: "Bench Press",
    sourceKind: "system",
  },
  {
    equipment: "barbell",
    exerciseType: "strength",
    movement: "compound",
    muscleGroup: "posterior_chain",
    muscleGroups: ["posterior_chain"],
    name: "Deadlift",
    sourceKind: "system",
  },
  {
    equipment: "bodyweight",
    exerciseType: "strength",
    movement: "compound",
    muscleGroup: "back",
    muscleGroups: ["back"],
    name: "Pull Up",
    sourceKind: "system",
  },
  {
    equipment: "barbell",
    exerciseType: "strength",
    movement: "compound",
    muscleGroup: "hamstrings",
    muscleGroups: ["hamstrings"],
    name: "Romanian Deadlift",
    sourceKind: "system",
  },
  {
    equipment: "barbell",
    exerciseType: "strength",
    movement: "compound",
    muscleGroup: "shoulders",
    muscleGroups: ["shoulders"],
    name: "Overhead Press",
    sourceKind: "system",
  },
] as const satisfies readonly SystemSeededExerciseDefinition[];

export interface UserExerciseProvenanceInput {
  equipment: string | null;
  exerciseType: string | null;
  muscleGroups: readonly string[] | null;
  name: string;
  providerExerciseId: string | null;
  providerExerciseName: string;
  providerId: string;
  userId: string;
}

function textArrayExpression(values: readonly string[] | null) {
  if (values === null) {
    return sql`NULL::text[]`;
  }
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Resolves a shared exercise and atomically records both exercise and alias
 * attribution for the importing user. A write-fence rejection therefore rolls
 * back every catalog write in the statement.
 */
export async function resolveUserExerciseWithProvenance(
  database: Pick<SyncDatabase, "execute">,
  input: UserExerciseProvenanceInput,
): Promise<string> {
  const rows = await executeWithSchema(
    database,
    resolvedExerciseRowSchema,
    sql`WITH existing_alias AS MATERIALIZED (
          SELECT id, exercise_id
          FROM fitness.exercise_alias
          WHERE provider_id = ${input.providerId}
            AND provider_exercise_name = ${input.providerExerciseName}
          ORDER BY id
          LIMIT 1
        ),
        inserted_exercise AS (
          INSERT INTO fitness.exercise (
            name,
            equipment,
            muscle_groups,
            exercise_type
          )
          SELECT
            ${input.name},
            ${input.equipment},
            ${textArrayExpression(input.muscleGroups)},
            ${input.exerciseType}
          WHERE NOT EXISTS (SELECT 1 FROM existing_alias)
          ON CONFLICT DO NOTHING
          RETURNING id
        ),
        resolved_exercise AS MATERIALIZED (
          SELECT exercise_id AS id
          FROM existing_alias
          UNION ALL
          SELECT id
          FROM inserted_exercise
          UNION ALL
          SELECT id
          FROM fitness.exercise
          WHERE name = ${input.name}
            AND equipment IS NOT DISTINCT FROM ${input.equipment}
            AND NOT EXISTS (SELECT 1 FROM existing_alias)
          ORDER BY id
          LIMIT 1
        ),
        updated_exercise AS (
          UPDATE fitness.exercise
          SET
            muscle_groups = COALESCE(
              fitness.exercise.muscle_groups,
              ${textArrayExpression(input.muscleGroups)}
            ),
            exercise_type = COALESCE(
              fitness.exercise.exercise_type,
              ${input.exerciseType}
            )
          WHERE id = (SELECT id FROM resolved_exercise)
          RETURNING id
        ),
        inserted_source AS (
          INSERT INTO fitness.exercise_source (
            exercise_id,
            source_kind,
            user_id,
            provider_id
          )
          SELECT
            id,
            'user',
            ${input.userId}::uuid,
            ${input.providerId}
          FROM resolved_exercise
          ON CONFLICT (
            exercise_id,
            user_id,
            provider_id
          ) WHERE source_kind = 'user'
          DO UPDATE SET source_kind = EXCLUDED.source_kind
          RETURNING id, exercise_id
        ),
        resolved_source AS MATERIALIZED (
          SELECT id, exercise_id
          FROM inserted_source
          UNION ALL
          SELECT source.id, source.exercise_id
          FROM fitness.exercise_source AS source
          JOIN resolved_exercise AS exercise
            ON exercise.id = source.exercise_id
          WHERE source.source_kind = 'user'
            AND source.user_id = ${input.userId}::uuid
            AND source.provider_id = ${input.providerId}
          ORDER BY id
          LIMIT 1
        ),
        inserted_alias AS (
          INSERT INTO fitness.exercise_alias (
            exercise_id,
            provider_id,
            provider_exercise_id,
            provider_exercise_name
          )
          SELECT
            id,
            ${input.providerId},
            ${input.providerExerciseId},
            ${input.providerExerciseName}
          FROM resolved_exercise
          ON CONFLICT (provider_id, provider_exercise_name) DO NOTHING
          RETURNING id, exercise_id
        ),
        resolved_alias AS MATERIALIZED (
          SELECT id, exercise_id
          FROM inserted_alias
          UNION ALL
          SELECT alias.id, alias.exercise_id
          FROM fitness.exercise_alias AS alias
          WHERE alias.provider_id = ${input.providerId}
            AND alias.provider_exercise_name = ${input.providerExerciseName}
          ORDER BY id
          LIMIT 1
        ),
        linked_alias AS (
          INSERT INTO fitness.exercise_alias_source (
            alias_id,
            source_id,
            exercise_id
          )
          SELECT
            alias.id,
            source.id,
            source.exercise_id
          FROM resolved_alias AS alias
          CROSS JOIN resolved_source AS source
          WHERE alias.exercise_id = source.exercise_id
          ON CONFLICT (alias_id, source_id) DO NOTHING
          RETURNING alias_id
        )
        SELECT
          exercise.id AS exercise_id,
          alias.exercise_id AS alias_exercise_id,
          EXISTS (
            SELECT 1
            FROM linked_alias
            WHERE linked_alias.alias_id = alias.id
            UNION ALL
            SELECT 1
            FROM fitness.exercise_alias_source AS alias_source
            WHERE alias_source.alias_id = alias.id
              AND alias_source.source_id = source.id
          ) AS source_linked
        FROM resolved_exercise AS exercise
        CROSS JOIN resolved_source AS source
        CROSS JOIN resolved_alias AS alias`,
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`Could not resolve exercise: ${input.name}`);
  }
  if (row.alias_exercise_id !== row.exercise_id || !row.source_linked) {
    throw new Error(
      `Exercise alias ${input.providerExerciseName} conflicts with its canonical exercise`,
    );
  }
  return row.exercise_id;
}
