/**
 * Seed a local development database with realistic multi-provider data.
 *
 * Usage:
 *   DATABASE_URL="postgres://health:health@localhost:5432/health" pnpm seed
 *
 * What it creates:
 *   - 1 baseline user
 *   - 2 providers: WHOOP (priority 1) and Apple Health (priority 2)
 *   - 90 days of daily metrics (resting HR, HRV, steps, SpO2, skin temp)
 *   - 30 days of dual-provider sleep (WHOOP 480min + Apple Health 330min
 *     with <80% overlap — exercises the v_sleep dedup edge case)
 *   - 30 days of activities (cycling, running, strength)
 *   - 30 days of nutrition data
 *   - 30 days of body weight measurements
 *   - An auth session ("dev-session") for browser testing
 *
 * The data is designed to exercise real dashboard edge cases:
 *   - Multi-provider sleep dedup (overlapping but <80% threshold)
 *   - Daily metrics from a single provider
 *   - Mixed activity types for training load calculations
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTaggedQueryClient } from "../src/db/tagged-query-client.ts";
import { clearSeedData, seedCore } from "./seed/core.ts";
import { SeedRandom, USER_ID } from "./seed/helpers.ts";
import { seedRecovery } from "./seed/recovery.ts";
import { seedTraining } from "./seed/training.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = createTaggedQueryClient(databaseUrl);

// ---------------------------------------------------------------------------
// Step 1: Apply all migrations and recreate views (same as setupTestDatabase)
// ---------------------------------------------------------------------------

async function applyMigrations() {
  const drizzleDir = resolve(import.meta.dirname, "../drizzle");
  const migrationFiles = readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let applied = 0;
  for (const file of migrationFiles) {
    const content = readFileSync(resolve(drizzleDir, file), "utf-8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      try {
        await sql.unsafe(statement);
      } catch {
        // Ignore duplicate object errors on re-runs
      }
    }
    applied++;
  }
  console.log(`Migrations: ${applied} files applied`);

  // Recreate materialized views from canonical definitions
  const viewsDir = join(drizzleDir, "_views");
  if (existsSync(viewsDir)) {
    const viewFiles = readdirSync(viewsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const parsed = viewFiles.map((file) => {
      const content = readFileSync(join(viewsDir, file), "utf-8");
      const match = content.match(/CREATE\s+MATERIALIZED\s+VIEW\s+fitness\.(\w+)/i);
      return { content, viewName: match?.[1] };
    });

    // Drop in reverse order (dependents first)
    for (const { viewName } of [...parsed].reverse()) {
      if (!viewName) continue;
      await sql.unsafe(`DROP MATERIALIZED VIEW IF EXISTS fitness.${viewName} CASCADE`);
    }

    // Create in filename order
    for (const { content } of parsed) {
      const statements = content
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
    }
    console.log(`Views: ${viewFiles.length} recreated`);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Seed data
// ---------------------------------------------------------------------------

async function seedData() {
  await clearSeedData(sql);
  await seedCore(sql);
  const random = new SeedRandom(42);
  await seedRecovery(sql, random);
  await seedTraining(sql, random);

  const today = new Date();

  // -----------------------------------------------------------------------
  // Nutrition (30 days)
  // -----------------------------------------------------------------------
  for (let daysAgo = 0; daysAgo <= 30; daysAgo++) {
    const date = daysBefore(today, daysAgo);
    await sql`
			INSERT INTO fitness.nutrition_daily (
				date, provider_id, user_id,
				calories, protein_g, carbs_g, fat_g, fiber_g
			) VALUES (
				${date}, 'apple_health', ${USER_ID},
				${randInt(1800, 2800)}, ${randInt(100, 180)},
				${randInt(150, 350)}, ${randInt(50, 100)}, ${randInt(20, 40)}
			) ON CONFLICT DO NOTHING
		`;
  }
  console.log("Seeded: 31 days of nutrition");

  // -----------------------------------------------------------------------
  // Body weight (every 3 days for 90 days)
  // -----------------------------------------------------------------------
  let weightKg = 82.0;
  for (let daysAgo = 90; daysAgo >= 0; daysAgo -= 3) {
    const date = daysBefore(today, daysAgo);
    weightKg += randFloat(-0.3, 0.2, 1);
    await sql`
			INSERT INTO fitness.body_measurement (
				provider_id, user_id, external_id,
				recorded_at, weight_kg, body_fat_pct
			) VALUES (
				'apple_health', ${USER_ID}, ${`bw-${daysAgo}`},
				${localTimestamp(date, "07:30:00")}, ${weightKg}, ${randFloat(14, 18, 1)}
			) ON CONFLICT DO NOTHING
		`;
  }
  console.log("Seeded: ~30 body weight measurements");
}

// ---------------------------------------------------------------------------
// Step 3: Refresh materialized views
// ---------------------------------------------------------------------------

async function refreshViews() {
  await sql`REFRESH MATERIALIZED VIEW fitness.v_sleep`;
  await sql`REFRESH MATERIALIZED VIEW fitness.v_daily_metrics`;
  await sql`REFRESH MATERIALIZED VIEW fitness.v_body_measurement`;
  try {
    await sql`REFRESH MATERIALIZED VIEW fitness.v_activity`;
  } catch {
    // v_activity may fail if activity_summary depends on it
  }
  try {
    await sql`REFRESH MATERIALIZED VIEW fitness.deduped_sensor`;
  } catch {
    // deduped_sensor depends on v_activity + metric_stream
  }
  try {
    await sql`REFRESH MATERIALIZED VIEW fitness.activity_summary`;
  } catch {
    // activity_summary depends on deduped_sensor
  }
  console.log("Views refreshed");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns YYYY-MM-DD for the local calendar date N days before `from`. */
function daysBefore(from: Date, daysAgo: number): string {
  const date = new Date(from);
  date.setDate(date.getDate() - daysAgo);
  // Use local date parts (not UTC) so the date matches the user's timezone
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Build an ISO 8601 timestamp with the local timezone offset.
 * e.g. "2026-03-29T22:00:00-07:00" so PostgreSQL stores the correct absolute time
 * and `AT TIME ZONE 'America/Los_Angeles'` yields the intended local date.
 */
function localTimestamp(dateStr: string, time: string): string {
  const offsetMin = new Date().getTimezoneOffset(); // e.g. 420 for PDT (UTC-7)
  const sign = offsetMin <= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const hours = String(Math.floor(absMin / 60)).padStart(2, "0");
  const mins = String(absMin % 60).padStart(2, "0");
  return `${dateStr}T${time}${sign}${hours}:${mins}`;
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, decimals: number): number {
  const value = Math.random() * (max - min) + min;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
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
  await refreshViews();

  // Verify dedup scenario
  const [{ count: rawCount }] = await sql`SELECT count(*)::int AS count FROM fitness.sleep_session`;
  const [{ count: viewCount }] = await sql`SELECT count(*)::int AS count FROM fitness.v_sleep`;
  const [{ count: dupDates }] = await sql`
		SELECT count(*)::int AS count FROM (
			SELECT started_at::date FROM fitness.v_sleep
			WHERE NOT is_nap GROUP BY 1 HAVING count(*) > 1
		) x
	`;

  console.log(`\nVerification:`);
  console.log(`  Raw sleep sessions: ${rawCount}`);
  console.log(`  v_sleep rows: ${viewCount}`);
  console.log(`  Dates with >1 session in v_sleep: ${dupDates} (dedup edge case)`);
  console.log(`\nDone. Start the server with:`);
  console.log(`  DATABASE_URL="${databaseUrl}" cd packages/server && pnpm dev`);
  console.log(`\nBrowser cookie for auth: session=dev-session`);

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
