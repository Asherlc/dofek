import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgClient, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import { SYSTEM_SEEDED_EXERCISE_DEFINITIONS } from "../src/db/exercise-provenance.ts";
import { executeWithSchema } from "../src/db/typed-sql.ts";

const BATCH_SIZE = 500;
const ADVISORY_LOCK_NAME = "dofek.exercise_provenance_backfill";

const provenanceRowSchema = z.object({
  exercise_id: z.uuid(),
  provider_id: z.string().min(1),
  user_id: z.uuid(),
});
const countRowSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
});

type BackfillClient = NodePgClient;
type BackfillDatabase = NodePgDatabase<Record<string, never>>;

export interface ExerciseProvenanceBackfillResult {
  aliasSourcesInserted: number;
  exerciseSourcesInserted: number;
}

function uuidArray(values: string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}::uuid`),
    sql`, `,
  )}]::uuid[]`;
}

function textArray(values: string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

async function validateBackfill(database: BackfillDatabase): Promise<void> {
  const missingSystemSources = await executeWithSchema(
    database,
    countRowSchema,
    sql`SELECT count(*)::integer AS count
        FROM jsonb_to_recordset(${JSON.stringify(SYSTEM_SEEDED_EXERCISE_DEFINITIONS)}::jsonb) AS definition(
          equipment text,
          "exerciseType" text,
          movement text,
          "muscleGroup" text,
          "muscleGroups" text[],
          name text,
          "sourceKind" text
        )
        JOIN fitness.exercise AS exercise
          ON exercise.name = definition.name
          AND exercise.muscle_group IS NOT DISTINCT FROM definition."muscleGroup"
          AND exercise.muscle_groups IS NOT DISTINCT FROM definition."muscleGroups"
          AND exercise.equipment IS NOT DISTINCT FROM definition.equipment
          AND exercise.exercise_type IS NOT DISTINCT FROM definition."exerciseType"
          AND exercise.movement IS NOT DISTINCT FROM definition.movement
        LEFT JOIN fitness.exercise_source AS source
          ON source.exercise_id = exercise.id
          AND source.source_kind = definition."sourceKind"
        WHERE source.id IS NULL`,
  );
  const missingSystemSourceCount = countRowSchema.parse(missingSystemSources[0]).count;
  if (missingSystemSourceCount !== 0) {
    throw new Error(
      `Exercise provenance backfill left ${missingSystemSourceCount} seeded system exercise sources missing`,
    );
  }

  const missingSources = await executeWithSchema(
    database,
    countRowSchema,
    sql`SELECT count(*)::integer AS count
        FROM (
          SELECT DISTINCT
            strength.exercise_id,
            activity.user_id,
            activity.provider_id
          FROM fitness.strength_set AS strength
          JOIN fitness.activity AS activity
            ON activity.id = strength.activity_id
        ) AS historical_source
        LEFT JOIN fitness.exercise_source AS source
          ON source.exercise_id = historical_source.exercise_id
          AND source.source_kind = 'user'
          AND source.user_id = historical_source.user_id
          AND source.provider_id = historical_source.provider_id
        WHERE source.id IS NULL`,
  );
  const missingSourceCount = countRowSchema.parse(missingSources[0]).count;
  if (missingSourceCount !== 0) {
    throw new Error(
      `Exercise provenance backfill left ${missingSourceCount} historical exercise sources missing`,
    );
  }

  const missingAliasSources = await executeWithSchema(
    database,
    countRowSchema,
    sql`SELECT count(*)::integer AS count
        FROM fitness.exercise_alias AS alias
        JOIN fitness.exercise_source AS source
          ON source.exercise_id = alias.exercise_id
          AND source.source_kind = 'user'
          AND source.provider_id = alias.provider_id
        LEFT JOIN fitness.exercise_alias_source AS alias_source
          ON alias_source.alias_id = alias.id
          AND alias_source.source_id = source.id
        WHERE alias_source.alias_id IS NULL`,
  );
  const missingAliasSourceCount = countRowSchema.parse(missingAliasSources[0]).count;
  if (missingAliasSourceCount !== 0) {
    throw new Error(
      `Exercise provenance backfill left ${missingAliasSourceCount} historical alias sources missing`,
    );
  }
}

export async function backfillExerciseProvenance(
  client: BackfillClient,
): Promise<ExerciseProvenanceBackfillResult> {
  const database = drizzle(client);
  await executeWithSchema(
    database,
    z.object({}),
    sql`SELECT pg_advisory_lock(hashtext(${ADVISORY_LOCK_NAME}))`,
  );
  let exerciseSourcesInserted = 0;
  let aliasSourcesInserted = 0;
  let lastExerciseId: string | null = null;
  let lastUserId: string | null = null;
  let lastProviderId: string | null = null;

  try {
    const systemSources = await executeWithSchema(
      database,
      z.object({ exercise_id: z.uuid() }),
      sql`INSERT INTO fitness.exercise_source (
            exercise_id,
            source_kind,
            user_id,
            provider_id
          )
          SELECT
            exercise.id,
            definition."sourceKind",
            NULL,
            NULL
          FROM jsonb_to_recordset(${JSON.stringify(SYSTEM_SEEDED_EXERCISE_DEFINITIONS)}::jsonb) AS definition(
            equipment text,
            "exerciseType" text,
            movement text,
            "muscleGroup" text,
            "muscleGroups" text[],
            name text,
            "sourceKind" text
          )
          JOIN fitness.exercise AS exercise
            ON exercise.name = definition.name
            AND exercise.muscle_group IS NOT DISTINCT FROM definition."muscleGroup"
            AND exercise.muscle_groups IS NOT DISTINCT FROM definition."muscleGroups"
            AND exercise.equipment IS NOT DISTINCT FROM definition.equipment
            AND exercise.exercise_type IS NOT DISTINCT FROM definition."exerciseType"
            AND exercise.movement IS NOT DISTINCT FROM definition.movement
          ON CONFLICT (exercise_id) WHERE source_kind = 'system'
          DO NOTHING
          RETURNING exercise_id`,
    );
    exerciseSourcesInserted += systemSources.length;

    while (true) {
      const rows: z.infer<typeof provenanceRowSchema>[] = await executeWithSchema(
        database,
        provenanceRowSchema,
        sql`SELECT DISTINCT
              strength.exercise_id::text AS exercise_id,
              activity.user_id::text AS user_id,
              activity.provider_id
            FROM fitness.strength_set AS strength
            JOIN fitness.activity AS activity
              ON activity.id = strength.activity_id
            WHERE (
              ${lastExerciseId}::uuid IS NULL
              OR (
                strength.exercise_id,
                activity.user_id,
                activity.provider_id
              ) > (${lastExerciseId}::uuid, ${lastUserId}::uuid, ${lastProviderId}::text)
            )
            ORDER BY exercise_id, user_id, provider_id
            LIMIT ${BATCH_SIZE}`,
      );
      if (rows.length === 0) break;

      const lastRow: z.infer<typeof provenanceRowSchema> | undefined = rows.at(-1);
      if (!lastRow) {
        throw new Error("Exercise provenance backfill returned an empty batch");
      }

      await database.execute(sql`BEGIN`);
      try {
        const exerciseIds = uuidArray(rows.map((row) => row.exercise_id));
        const userIds = uuidArray(rows.map((row) => row.user_id));
        const providerIds = textArray(rows.map((row) => row.provider_id));
        const sources = await executeWithSchema(
          database,
          z.object({ exercise_id: z.uuid() }),
          sql`INSERT INTO fitness.exercise_source (
                exercise_id,
                source_kind,
                user_id,
                provider_id
              )
              SELECT
                provenance.exercise_id,
                'user',
                provenance.user_id,
                provenance.provider_id
              FROM unnest(
                ${exerciseIds},
                ${userIds},
                ${providerIds}
              ) AS provenance(exercise_id, user_id, provider_id)
              ON CONFLICT (
                exercise_id,
                user_id,
                provider_id
              ) WHERE source_kind = 'user'
              DO NOTHING
              RETURNING exercise_id`,
        );
        exerciseSourcesInserted += sources.length;

        const aliasSources = await executeWithSchema(
          database,
          z.object({ alias_id: z.uuid() }),
          sql`INSERT INTO fitness.exercise_alias_source (
                alias_id,
                source_id,
                exercise_id
              )
              SELECT
                alias.id,
                source.id,
                source.exercise_id
              FROM unnest(
                ${exerciseIds},
                ${userIds},
                ${providerIds}
              ) AS provenance(exercise_id, user_id, provider_id)
              JOIN fitness.exercise_source AS source
                ON source.exercise_id = provenance.exercise_id
                AND source.source_kind = 'user'
                AND source.user_id = provenance.user_id
                AND source.provider_id = provenance.provider_id
              JOIN fitness.exercise_alias AS alias
                ON alias.exercise_id = source.exercise_id
                AND alias.provider_id = source.provider_id
              ON CONFLICT (alias_id, source_id) DO NOTHING
              RETURNING alias_id`,
        );
        aliasSourcesInserted += aliasSources.length;
        await database.execute(sql`COMMIT`);
      } catch (error) {
        await database.execute(sql`ROLLBACK`);
        throw error;
      }

      lastExerciseId = lastRow.exercise_id;
      lastUserId = lastRow.user_id;
      lastProviderId = lastRow.provider_id;
    }

    await validateBackfill(database);
    return { aliasSourcesInserted, exerciseSourcesInserted };
  } finally {
    await executeWithSchema(
      database,
      z.object({}),
      sql`SELECT pg_advisory_unlock(hashtext(${ADVISORY_LOCK_NAME}))`,
    );
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await backfillExerciseProvenance(client);
    console.log(
      `Exercise provenance backfill complete: ${result.exerciseSourcesInserted} exercise sources and ${result.aliasSourcesInserted} alias sources inserted.`,
    );
  } finally {
    await client.end();
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
