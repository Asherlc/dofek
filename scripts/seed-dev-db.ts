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
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

const USER_ID = "00000000-0000-0000-0000-000000000001";

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
  // Clear existing seed data (idempotent re-runs)
  await sql`DELETE FROM fitness.metric_stream WHERE provider_id IN ('whoop', 'apple_health')`;
  await sql`DELETE FROM fitness.sleep_session WHERE provider_id IN ('whoop', 'apple_health')`;
  await sql`DELETE FROM fitness.activity WHERE provider_id IN ('whoop', 'apple_health')`;
  await sql`DELETE FROM fitness.daily_metrics WHERE provider_id IN ('whoop', 'apple_health')`;
  await sql`DELETE FROM fitness.nutrition_daily WHERE provider_id IN ('whoop', 'apple_health')`;
  await sql`DELETE FROM fitness.body_measurement WHERE provider_id IN ('whoop', 'apple_health')`;

  // Providers
  await sql`
		INSERT INTO fitness.provider (id, name, user_id) VALUES
			('whoop', 'WHOOP', ${USER_ID}),
			('apple_health', 'Apple Health', ${USER_ID})
		ON CONFLICT DO NOTHING
	`;
  await sql`
		INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority) VALUES
			('whoop', 1, 1),
			('apple_health', 2, 2)
		ON CONFLICT (provider_id) DO UPDATE
			SET priority = EXCLUDED.priority, sleep_priority = EXCLUDED.sleep_priority
	`;

  // Auth session for browser testing
  await sql`
		INSERT INTO fitness.session (id, user_id, expires_at)
		VALUES ('dev-session', ${USER_ID}, NOW() + INTERVAL '365 days')
		ON CONFLICT DO NOTHING
	`;

  const today = new Date();

  // -----------------------------------------------------------------------
  // Daily metrics (90 days)
  // -----------------------------------------------------------------------
  for (let daysAgo = 0; daysAgo <= 90; daysAgo++) {
    const date = daysBefore(today, daysAgo);
    await sql`
			INSERT INTO fitness.daily_metrics (
				date, provider_id, user_id,
				resting_hr, hrv, spo2_avg, skin_temp_c,
				steps, active_energy_kcal, basal_energy_kcal
			) VALUES (
				${date}, 'whoop', ${USER_ID},
				${randInt(48, 58)}, ${randInt(45, 80)}, ${randFloat(95, 99, 1)}, ${randFloat(35.5, 37.0, 1)},
				${randInt(5000, 14000)}, ${randInt(350, 700)}, 1800
			) ON CONFLICT DO NOTHING
		`;
  }
  console.log("Seeded: 91 days of daily metrics");

  // -----------------------------------------------------------------------
  // Sleep sessions: dual-provider with <80% overlap (the dedup edge case)
  // WHOOP: 22:00 → 06:00 = 480 min
  // Apple Health: 23:30 → 05:00 = 330 min (overlap ≈ 69%)
  // -----------------------------------------------------------------------
  for (let daysAgo = 1; daysAgo <= 30; daysAgo++) {
    const nightDate = daysBefore(today, daysAgo);

    // WHOOP session — vary bedtime and wake time for realistic durations
    const wakeDate = daysBefore(today, daysAgo - 1);
    const bedHour = randInt(21, 23);
    const bedMin = randInt(0, 59);
    const wakeHour = randInt(5, 7);
    const wakeMin = randInt(0, 59);
    const whoopStart = localTimestamp(
      nightDate,
      `${String(bedHour).padStart(2, "0")}:${String(bedMin).padStart(2, "0")}:00`,
    );
    const whoopEnd = localTimestamp(
      wakeDate,
      `${String(wakeHour).padStart(2, "0")}:${String(wakeMin).padStart(2, "0")}:00`,
    );
    // Compute duration from times (bed→midnight + midnight→wake)
    const durationMin = (24 - bedHour) * 60 - bedMin + wakeHour * 60 + wakeMin;
    const deepMin = randInt(50, 90);
    const remMin = randInt(80, 120);
    const lightMin = randInt(
      Math.max(60, durationMin - deepMin - remMin - 50),
      Math.max(80, durationMin - deepMin - remMin - 20),
    );
    const awakeMin = Math.max(10, durationMin - deepMin - remMin - lightMin);
    await sql`
			INSERT INTO fitness.sleep_session (
				provider_id, user_id, external_id,
				started_at, ended_at,
				duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
				efficiency_pct, sleep_type
			) VALUES (
				'whoop', ${USER_ID}, ${`w-${daysAgo}`},
				${whoopStart}, ${whoopEnd},
				${durationMin}, ${deepMin}, ${remMin}, ${lightMin}, ${awakeMin},
				${randFloat(82, 96, 1)}, 'sleep'
			)
		`;

    // Apple Health session (shifted — doesn't overlap >80%)
    const ahBedMin = bedMin + randInt(60, 120);
    const ahBedHour = bedHour + Math.floor(ahBedMin / 60);
    const ahStart = localTimestamp(
      nightDate,
      `${String(ahBedHour % 24).padStart(2, "0")}:${String(ahBedMin % 60).padStart(2, "0")}:00`,
    );
    const ahWakeHour = wakeHour - 1;
    const ahEnd = localTimestamp(
      wakeDate,
      `${String(Math.max(4, ahWakeHour)).padStart(2, "0")}:${String(wakeMin).padStart(2, "0")}:00`,
    );
    const ahDuration = randInt(280, 380);
    await sql`
			INSERT INTO fitness.sleep_session (
				provider_id, user_id, external_id,
				started_at, ended_at,
				duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes,
				efficiency_pct, sleep_type
			) VALUES (
				'apple_health', ${USER_ID}, ${`ah-${daysAgo}`},
				${ahStart}, ${ahEnd},
				${ahDuration}, ${randInt(30, 60)}, ${randInt(50, 80)}, ${randInt(120, 180)}, ${randInt(20, 45)},
				NULL, 'sleep'
			)
		`;
  }
  console.log("Seeded: 30 nights × 2 providers (60 sleep sessions)");

  // -----------------------------------------------------------------------
  // Activities (30 days — mix of cycling, running, strength)
  // -----------------------------------------------------------------------
  const activityTypes = ["cycling", "running", "strength_training"] as const;
  for (let daysAgo = 1; daysAgo <= 30; daysAgo++) {
    const date = daysBefore(today, daysAgo);
    const activityType = activityTypes[daysAgo % activityTypes.length];
    const durationMin = activityType === "strength_training" ? randInt(40, 70) : randInt(30, 90);
    const startHour = randInt(6, 18);
    const startedAt = localTimestamp(date, `${String(startHour).padStart(2, "0")}:00:00`);
    const endedAtDate = new Date();
    endedAtDate.setDate(endedAtDate.getDate() - daysAgo);
    endedAtDate.setHours(startHour, durationMin, 0, 0);
    const endedAt = localTimestamp(
      date,
      `${String(endedAtDate.getHours()).padStart(2, "0")}:${String(endedAtDate.getMinutes()).padStart(2, "0")}:00`,
    );

    const activityName =
      activityType === "cycling"
        ? "Morning Ride"
        : activityType === "running"
          ? "Easy Run"
          : "Gym Session";
    const [{ id: activityId }] = await sql<{ id: string }[]>`
			INSERT INTO fitness.activity (
				provider_id, user_id, external_id,
				activity_type, started_at, ended_at, name
			) VALUES (
				'whoop', ${USER_ID}, ${`act-${daysAgo}`},
				${activityType}, ${startedAt}, ${endedAt},
				${activityName}
			) RETURNING id
		`;
    // Seed metric_stream samples so activity_summary computes avg_hr / max_hr
    const baseHr = activityType === "strength_training" ? randInt(100, 120) : randInt(130, 155);
    const sampleCount = Math.floor(durationMin / 5); // one sample every 5 min
    for (let sample = 0; sample < sampleCount; sample++) {
      const sampleTime = localTimestamp(
        date,
        `${String(startHour + Math.floor((sample * 5) / 60)).padStart(2, "0")}:${String((sample * 5) % 60).padStart(2, "0")}:00`,
      );
      await sql`
				INSERT INTO fitness.metric_stream (recorded_at, user_id, provider_id, device_id, source_type, channel, activity_id, scalar)
				VALUES (${sampleTime}, ${USER_ID}, 'whoop', NULL, 'api', 'heart_rate', ${activityId}, ${randInt(baseHr - 15, baseHr + 25)})
			`;
    }
  }
  console.log("Seeded: 30 activities with HR samples");

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
