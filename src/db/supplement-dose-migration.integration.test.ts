import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runMigrations } from "./migrate.ts";
import { setupTestDatabase, type TestContext, writeTestMigrationFiles } from "./test-helpers.ts";

const migratedRowsSchema = z.array(
  z.object({
    definition_count: z.coerce.number(),
    nutrient_count: z.coerce.number(),
    schedule_count: z.coerce.number(),
  }),
);
const definitionRowsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    supplement_id: z.string(),
  }),
);
const nutrientRowsSchema = z.array(
  z.object({
    amount: z.coerce.number(),
    definition_id: z.string(),
    nutrient_id: z.string(),
  }),
);
const relationRowsSchema = z.array(
  z.object({
    definition_exists: z.boolean(),
    definition_nutrient_exists: z.boolean(),
    dose_event_exists: z.boolean(),
    legacy_nutrient_exists: z.boolean(),
    legacy_supplement_exists: z.boolean(),
    nutrient_exists: z.boolean(),
    supplement_exists: z.boolean(),
  }),
);
const columnRowsSchema = z.array(z.object({ column_name: z.string() }));
const constraintRowsSchema = z.array(z.object({ constraint_name: z.string() }));
const legacySupplementRowsSchema = z.array(
  z.object({
    amount: z.coerce.number(),
    id: z.string(),
    name: z.string(),
    sort_order: z.coerce.number(),
    unit: z.string(),
  }),
);
const cleanupRowsSchema = z.array(
  z.object({
    external_id: z.string(),
    nutrient_amount: z.coerce.number(),
    provider_id: z.string(),
  }),
);
const activeDefinitionRowsSchema = z.array(
  z.object({
    definition_id: z.string(),
    effective_to: z.string().nullable(),
    name: z.string(),
    supplement_id: z.string(),
  }),
);

const FIRST_ID = "10000000-0000-4000-8000-000000002064";
const SECOND_ID = "20000000-0000-4000-8000-000000002064";
const FICTIONAL_FOOD_ID = "30000000-0000-4000-8000-000000002064";
const REAL_FOOD_ID = "40000000-0000-4000-8000-000000002064";

async function restoreLegacySupplementSchema(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DROP VIEW fitness.v_nutrition_daily");
    await client.query("DROP VIEW fitness.v_nutrition_canonical_nutrient");
    await client.query("DROP VIEW fitness.v_supplement_dose_current");
    await client.query("DROP VIEW fitness.v_supplement_with_nutrition");
    await client.query("DROP TABLE fitness.supplement_dose_event");
    await client.query("DROP TYPE fitness.supplement_dose_status");
    await client.query("DROP TABLE fitness.supplement_definition_nutrient");
    await client.query("DROP TABLE fitness.supplement_definition");
    await client.query("DROP TABLE fitness.supplement");
    await client.query(`
      CREATE TABLE fitness.supplement (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES fitness.user_profile(id),
        name text NOT NULL,
        amount real,
        unit text,
        form text,
        description text,
        meal fitness.meal,
        sort_order integer DEFAULT 0 NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      );
      CREATE UNIQUE INDEX supplement_user_name_idx
        ON fitness.supplement (user_id, name);
      CREATE INDEX supplement_user_idx
        ON fitness.supplement (user_id);
      CREATE TABLE fitness.supplement_nutrient (
        supplement_id uuid NOT NULL REFERENCES fitness.supplement(id) ON DELETE CASCADE,
        nutrient_id text NOT NULL REFERENCES fitness.nutrient(id),
        amount real NOT NULL,
        PRIMARY KEY (supplement_id, nutrient_id)
      );
      CREATE INDEX supplement_nutrient_supplement_idx
        ON fitness.supplement_nutrient (supplement_id);
      CREATE VIEW fitness.v_supplement_with_nutrition AS
        SELECT id FROM fitness.supplement;
      CREATE VIEW fitness.v_nutrition_canonical_nutrient AS
        SELECT NULL::uuid AS user_id WHERE FALSE;
      CREATE VIEW fitness.v_nutrition_daily AS
        SELECT NULL::date AS date WHERE FALSE;
    `);
    await client.query(
      `INSERT INTO fitness.supplement (
         id, user_id, name, amount, unit, meal, sort_order, created_at, updated_at
       )
       VALUES
         ($1, '00000000-0000-0000-0000-000000000001', 'Vitamin D', 25, 'mcg', 'breakfast', 0,
          '2026-01-01T08:00:00Z', '2026-01-02T08:00:00Z'),
         ($2, '00000000-0000-0000-0000-000000000001', 'Magnesium', 400, 'mg', 'dinner', 1,
          '2026-01-03T08:00:00Z', '2026-01-04T08:00:00Z')`,
      [FIRST_ID, SECOND_ID],
    );
    await client.query(
      `INSERT INTO fitness.supplement_nutrient (supplement_id, nutrient_id, amount)
       VALUES
         ($1, 'vitamin_d', 25),
         ($2, 'magnesium', 400),
         ($2, 'calories', 5)`,
      [FIRST_ID, SECOND_ID],
    );
    await client.query(`
      INSERT INTO fitness.provider (id, name)
      VALUES
        ('auto-supplements', 'Auto-Supplements'),
        ('fixture-food-source', 'Fixture Food Source')
      ON CONFLICT (id) DO NOTHING
    `);
    await client.query(
      `INSERT INTO fitness.food_entry (
         id, user_id, provider_id, external_id, date, food_name
       )
       VALUES
         ($1, '00000000-0000-0000-0000-000000000001', 'auto-supplements',
          'fictional-food', '2022-01-01', 'Fictional supplement food'),
         ($2, '00000000-0000-0000-0000-000000000001', 'fixture-food-source',
          'real-food', '2022-01-01', 'Real food')`,
      [FICTIONAL_FOOD_ID, REAL_FOOD_ID],
    );
    await client.query(
      `INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount)
       VALUES ($1, 'vitamin_d', 10), ($2, 'vitamin_d', 5)`,
      [FICTIONAL_FOOD_ID, REAL_FOOD_ID],
    );
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

function migrationDirectory(temporaryDirectories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "supplement-dose-migration-"));
  temporaryDirectories.push(directory);
  writeTestMigrationFiles(directory, [
    {
      content: readFileSync(
        resolve(import.meta.dirname, "../../drizzle/0061_supplement_dose_events.sql"),
        "utf8",
      ),
      file: "9001_supplement_dose_events.sql",
      when: 9_001_000_000_000,
    },
  ]);
  return directory;
}

describe("supplement dose schema migration", () => {
  let context: TestContext;
  let temporaryDirectories: string[];

  beforeEach(async () => {
    temporaryDirectories = [];
    context = await setupTestDatabase();
    await restoreLegacySupplementSchema(context.connectionString);
  }, 120_000);

  afterEach(async () => {
    try {
      await context?.cleanup();
    } finally {
      for (const directory of temporaryDirectories) {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  });

  it("preserves every schedule, definition, nutrient, key, and ownership constraint", async () => {
    await expect(
      runMigrations(context.connectionString, migrationDirectory(temporaryDirectories)),
    ).resolves.toBe(1);
    const client = new Client({ connectionString: context.connectionString });
    await client.connect();
    try {
      const counts = migratedRowsSchema.parse(
        (
          await client.query(`
            SELECT
              (SELECT count(*) FROM fitness.supplement) AS schedule_count,
              (SELECT count(*) FROM fitness.supplement_definition) AS definition_count,
              (SELECT count(*) FROM fitness.supplement_definition_nutrient) AS nutrient_count
          `)
        ).rows,
      );
      expect(counts).toEqual([{ schedule_count: 2, definition_count: 2, nutrient_count: 3 }]);

      const definitions = definitionRowsSchema.parse(
        (
          await client.query(`
            SELECT id, supplement_id, name
            FROM fitness.supplement_definition
            ORDER BY name
          `)
        ).rows,
      );
      expect(definitions).toEqual([
        { id: SECOND_ID, supplement_id: SECOND_ID, name: "Magnesium" },
        { id: FIRST_ID, supplement_id: FIRST_ID, name: "Vitamin D" },
      ]);

      const nutrients = nutrientRowsSchema.parse(
        (
          await client.query(`
            SELECT definition_id, nutrient_id, amount
            FROM fitness.supplement_definition_nutrient
            ORDER BY definition_id, nutrient_id
          `)
        ).rows,
      );
      expect(nutrients).toEqual([
        { definition_id: FIRST_ID, nutrient_id: "vitamin_d", amount: 25 },
        { definition_id: SECOND_ID, nutrient_id: "calories", amount: 5 },
        { definition_id: SECOND_ID, nutrient_id: "magnesium", amount: 400 },
      ]);

      const relations = relationRowsSchema.parse(
        (
          await client.query(`
            SELECT
              to_regclass('fitness.supplement') IS NOT NULL AS supplement_exists,
              to_regclass('fitness.supplement_definition') IS NOT NULL AS definition_exists,
              to_regclass('fitness.supplement_definition_nutrient') IS NOT NULL
                AS definition_nutrient_exists,
              to_regclass('fitness.supplement_dose_event') IS NOT NULL AS dose_event_exists,
              to_regclass('fitness.supplement_nutrient') IS NOT NULL AS nutrient_exists,
              to_regclass('fitness.supplement_legacy') IS NOT NULL AS legacy_supplement_exists,
              to_regclass('fitness.supplement_nutrient_legacy') IS NOT NULL
                AS legacy_nutrient_exists
          `)
        ).rows,
      );
      expect(relations).toEqual([
        {
          supplement_exists: true,
          definition_exists: true,
          definition_nutrient_exists: true,
          dose_event_exists: true,
          nutrient_exists: false,
          legacy_supplement_exists: false,
          legacy_nutrient_exists: false,
        },
      ]);

      const columns = columnRowsSchema.parse(
        (
          await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'fitness' AND table_name = 'supplement'
            ORDER BY ordinal_position
          `)
        ).rows,
      );
      expect(columns.map((row) => row.column_name)).toEqual([
        "id",
        "user_id",
        "sort_order",
        "created_at",
        "updated_at",
      ]);

      const constraints = constraintRowsSchema.parse(
        (
          await client.query(`
            SELECT constraint_name
            FROM information_schema.table_constraints
            WHERE table_schema = 'fitness'
              AND table_name = 'supplement_dose_event'
              AND constraint_name IN (
                'supplement_dose_event_supplement_user_fkey',
                'supplement_dose_event_definition_fkey'
              )
            ORDER BY constraint_name
          `)
        ).rows,
      );
      expect(constraints.map((row) => row.constraint_name)).toEqual([
        "supplement_dose_event_definition_fkey",
        "supplement_dose_event_supplement_user_fkey",
      ]);

      const cleanupRows = cleanupRowsSchema.parse(
        (
          await client.query(
            `
              SELECT
                food.external_id,
                food.provider_id,
                nutrient.amount AS nutrient_amount
              FROM fitness.food_entry AS food
              INNER JOIN fitness.food_entry_nutrient AS nutrient
                ON nutrient.food_entry_id = food.id
              WHERE food.id IN ($1, $2)
              ORDER BY food.external_id
            `,
            [FICTIONAL_FOOD_ID, REAL_FOOD_ID],
          )
        ).rows,
      );
      expect(cleanupRows).toEqual([
        {
          external_id: "real-food",
          nutrient_amount: 5,
          provider_id: "fixture-food-source",
        },
      ]);

      const activeDefinitions = activeDefinitionRowsSchema.parse(
        (
          await client.query(`
            SELECT definition_id, supplement_id, name, effective_to
            FROM fitness.v_supplement_with_nutrition
            ORDER BY name
          `)
        ).rows,
      );
      expect(activeDefinitions).toEqual([
        {
          definition_id: SECOND_ID,
          effective_to: null,
          name: "Magnesium",
          supplement_id: SECOND_ID,
        },
        {
          definition_id: FIRST_ID,
          effective_to: null,
          name: "Vitamin D",
          supplement_id: FIRST_ID,
        },
      ]);

      await expect(
        client.query(
          `INSERT INTO fitness.supplement_definition (
             id, supplement_id, supersedes_definition_id, name, effective_from
           )
           VALUES ($1, $2, $1, 'Self reference', '2026-07-27')`,
          ["50000000-0000-4000-8000-000000002064", FIRST_ID],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "supplement_definition_not_self_superseding",
      });
    } finally {
      await client.end();
    }
  });

  it("rolls the entire normalization back when a legacy dependency blocks removal", async () => {
    const client = new Client({ connectionString: context.connectionString });
    await client.connect();
    try {
      await client.query(
        "CREATE VIEW fitness.block_supplement_normalization AS SELECT id, name FROM fitness.supplement",
      );
    } finally {
      await client.end();
    }

    await expect(
      runMigrations(context.connectionString, migrationDirectory(temporaryDirectories)),
    ).rejects.toThrow();

    const verification = new Client({ connectionString: context.connectionString });
    await verification.connect();
    try {
      const relations = relationRowsSchema.parse(
        (
          await verification.query(`
            SELECT
              to_regclass('fitness.supplement') IS NOT NULL AS supplement_exists,
              to_regclass('fitness.supplement_definition') IS NOT NULL AS definition_exists,
              to_regclass('fitness.supplement_definition_nutrient') IS NOT NULL
                AS definition_nutrient_exists,
              to_regclass('fitness.supplement_dose_event') IS NOT NULL AS dose_event_exists,
              to_regclass('fitness.supplement_nutrient') IS NOT NULL AS nutrient_exists,
              to_regclass('fitness.supplement_legacy') IS NOT NULL AS legacy_supplement_exists,
              to_regclass('fitness.supplement_nutrient_legacy') IS NOT NULL
                AS legacy_nutrient_exists
          `)
        ).rows,
      );
      expect(relations).toEqual([
        {
          supplement_exists: true,
          definition_exists: false,
          definition_nutrient_exists: false,
          dose_event_exists: false,
          nutrient_exists: true,
          legacy_supplement_exists: false,
          legacy_nutrient_exists: false,
        },
      ]);

      const columns = columnRowsSchema.parse(
        (
          await verification.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'fitness' AND table_name = 'supplement'
            ORDER BY ordinal_position
          `)
        ).rows,
      );
      expect(columns.map((row) => row.column_name)).toEqual([
        "id",
        "user_id",
        "name",
        "amount",
        "unit",
        "form",
        "description",
        "meal",
        "sort_order",
        "created_at",
        "updated_at",
      ]);

      const supplements = legacySupplementRowsSchema.parse(
        (
          await verification.query(`
            SELECT id, name, amount, unit, sort_order
            FROM fitness.supplement
            ORDER BY name
          `)
        ).rows,
      );
      expect(supplements).toEqual([
        { id: SECOND_ID, name: "Magnesium", amount: 400, unit: "mg", sort_order: 1 },
        { id: FIRST_ID, name: "Vitamin D", amount: 25, unit: "mcg", sort_order: 0 },
      ]);

      const nutrients = nutrientRowsSchema.parse(
        (
          await verification.query(`
            SELECT supplement_id AS definition_id, nutrient_id, amount
            FROM fitness.supplement_nutrient
            ORDER BY supplement_id, nutrient_id
          `)
        ).rows,
      );
      expect(nutrients).toEqual([
        { definition_id: FIRST_ID, nutrient_id: "vitamin_d", amount: 25 },
        { definition_id: SECOND_ID, nutrient_id: "calories", amount: 5 },
        { definition_id: SECOND_ID, nutrient_id: "magnesium", amount: 400 },
      ]);
    } finally {
      await verification.end();
    }
  });
});
