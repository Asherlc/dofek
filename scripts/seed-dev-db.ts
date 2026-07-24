/**
 * Seed a local development or review-app database with deterministic reviewer data.
 *
 * Usage:
 *   DATABASE_URL="postgres://health:health@localhost:5432/health" pnpm seed
 *
 * What it creates:
 *   - 1 reviewer user with an auth session ("dev-session")
 *   - 5 connected providers with priorities and sync logs
 *   - 180 days of recovery/daily metrics
 *   - 90 WHOOP nights plus 30 Apple Health overlap sessions
 *   - 120 days of deterministic activity history and strength work
 *   - 90 days of nutrition, recent meals, and supplements
 *   - Body composition, labs, DEXA, clinical records, and cycle data
 *   - Journal, life event, and breathwork context for reports/correlation
 *
 * The data is designed to exercise reviewer-facing product surfaces:
 *   - Multi-provider sleep dedup (overlapping but <80% threshold)
 *   - Missing days, training build/deload, a bad sleep week, and sync failures
 *   - Web and mobile dashboard, recovery, strain, nutrition, body, and provider screens
 */

import { runMigrations } from "../src/db/migrate.ts";
import { createTaggedQueryClient } from "../src/db/tagged-query-client.ts";
import { seedBodyHealth } from "./seed/body-health.ts";
import { clearSeedData, seedCore } from "./seed/core.ts";
import { SeedRandom, USER_ID } from "./seed/helpers.ts";
import { seedNutrition } from "./seed/nutrition.ts";
import { seedRecovery } from "./seed/recovery.ts";
import { seedReviewSurfaces } from "./seed/review-surfaces.ts";
import { seedTraining } from "./seed/training.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = createTaggedQueryClient(databaseUrl);

interface CountRow {
  count: number;
}

// ---------------------------------------------------------------------------
// Step 1: Apply all migrations
// ---------------------------------------------------------------------------

async function applyMigrations() {
  const applied = await runMigrations(databaseUrl);
  console.log(`Migrations: ${applied} files applied`);
}

// ---------------------------------------------------------------------------
// Step 2: Seed data
// ---------------------------------------------------------------------------

async function seedData() {
  await clearSeedData(sql);
  await seedCore(sql);
  const random = new SeedRandom(42);
  await seedRecovery(sql, random);
  await seedTraining(sql);
  await seedNutrition(sql, random);
  await seedBodyHealth(sql);
  await seedReviewSurfaces(sql, random);
}

async function verifySeed() {
  const minimums = [
    [
      "providers",
      5,
      `SELECT COUNT(*)::int AS count FROM fitness.provider WHERE user_id = '${USER_ID}'`,
    ],
    [
      "daily metrics",
      170,
      `SELECT COUNT(*)::int AS count FROM fitness.daily_metrics WHERE user_id = '${USER_ID}'`,
    ],
    [
      "sleep sessions",
      100,
      `SELECT COUNT(*)::int AS count FROM fitness.sleep_session WHERE user_id = '${USER_ID}'`,
    ],
    [
      "activities",
      90,
      `SELECT COUNT(*)::int AS count FROM fitness.activity WHERE user_id = '${USER_ID}'`,
    ],
    [
      "nutrition days",
      85,
      `SELECT COUNT(*)::int AS count FROM fitness.food_entry WHERE user_id = '${USER_ID}'`,
    ],
    [
      "food entries",
      20,
      `SELECT COUNT(*)::int AS count FROM fitness.food_entry WHERE user_id = '${USER_ID}'`,
    ],
    [
      "lab results",
      8,
      `SELECT COUNT(*)::int AS count FROM fitness.lab_result WHERE user_id = '${USER_ID}'`,
    ],
    [
      "journal entries",
      30,
      `SELECT COUNT(*)::int AS count FROM fitness.journal_entry WHERE user_id = '${USER_ID}'`,
    ],
    [
      "breathwork sessions",
      10,
      `SELECT COUNT(*)::int AS count FROM fitness.breathwork_session WHERE user_id = '${USER_ID}'`,
    ],
    [
      "cycle periods",
      4,
      `SELECT COUNT(*)::int AS count FROM fitness.menstrual_period WHERE user_id = '${USER_ID}'`,
    ],
  ] as const;

  console.log("\nVerification:");
  for (const [label, minimum, query] of minimums) {
    const count = await readCount(query);
    if (count < minimum) {
      throw new Error(
        `Seed verification failed for ${label}: expected at least ${minimum}, got ${count}`,
      );
    }
    console.log(`  ${label}: ${count}`);
  }
}

async function readCount(query: string): Promise<number> {
  const [row] = await sql.unsafe<CountRow[]>(query);
  if (!row) throw new Error(`Count query returned no rows: ${query}`);
  return row.count;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Seeding development database...\n");

  // Skip migrations if the schema already exists (e.g., web container already ran them).
  // This avoids "relation already exists" errors when seed runs after web in Docker Compose.
  const [{ exists: schemaExists }] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'fitness' AND table_name = 'activity'
    ) AS exists`;
  if (schemaExists) {
    console.log("Schema already exists — skipping migrations (web already applied them)");
  } else {
    await applyMigrations();
  }
  await seedData();
  await verifySeed();
  console.log(`\nDone. Start the server with:`);
  console.log(`  DATABASE_URL="${databaseUrl}" cd packages/server && pnpm dev`);
  console.log(`\nBrowser cookie for auth: session=dev-session`);

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
