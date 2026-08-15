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
 *   - Journal and life-event context for reports/correlation
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
import { SeedRandom } from "./seed/helpers.ts";
import { seedNutrition } from "./seed/nutrition.ts";
import { seedRecovery } from "./seed/recovery.ts";
import { seedReviewSurfaces } from "./seed/review-surfaces.ts";
import { seedTraining } from "./seed/training.ts";
import { verifySeed } from "./seed/verification.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = createTaggedQueryClient(databaseUrl);

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
  await verifySeed(sql);
  console.log(`\nDone. Start the server with:`);
  console.log(`  DATABASE_URL="${databaseUrl}" cd packages/server && pnpm dev`);
  console.log(`\nBrowser cookie for auth: session=dev-session`);

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
