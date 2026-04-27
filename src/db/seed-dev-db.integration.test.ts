import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const userId = "00000000-0000-0000-0000-000000000001";

interface CountRow {
  count: number;
}

interface SeedCounts {
  providers: number;
  sessions: number;
  providerPriorities: number;
  userSettings: number;
  syncLogs: number;
  dailyMetrics: number;
  sleepSessions: number;
  sleepStages: number;
  activities: number;
  metricStream: number;
  activityIntervals: number;
  strengthWorkouts: number;
  strengthSets: number;
  nutritionDaily: number;
  foodEntries: number;
  supplements: number;
  bodyMeasurements: number;
  labPanels: number;
  labResults: number;
  dexaScans: number;
  journalEntries: number;
  lifeEvents: number;
  breathworkSessions: number;
  menstrualPeriods: number;
  vSleep: number;
  vDailyMetrics: number;
  vBodyMeasurement: number;
  activitySummary: number;
}

interface BareDatabaseContext {
  connectionString: string;
  cleanup: () => Promise<void>;
}

async function setupBareDatabase(): Promise<BareDatabaseContext> {
  const container = await new GenericContainer("timescale/timescaledb:latest-pg18")
    .withEnvironment({
      POSTGRES_DB: "test",
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .start();

  const connectionString = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;

  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const probe = postgres(connectionString, { max: 1 });
      await probe`SELECT 1`;
      await probe.end();
      break;
    } catch {
      if (attempt === 29) {
        throw new Error("Database did not become ready in time");
      }
      await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 500));
    }
  }

  const sql = postgres(connectionString, { max: 1 });
  const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
  const migrationFiles = readdirSync(drizzleDir)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  for (const fileName of migrationFiles) {
    const content = readFileSync(resolve(drizzleDir, fileName), "utf-8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  }

  await sql.end();

  return {
    connectionString,
    cleanup: async () => {
      await container.stop();
    },
  };
}

describe("seed-dev-db", () => {
  let ctx: BareDatabaseContext;

  beforeAll(async () => {
    ctx = await setupBareDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("creates an idempotent comprehensive reviewer dataset", async () => {
    await runSeed(ctx.connectionString);
    const sql = postgres(ctx.connectionString, { max: 1 });

    const [userRow] = await sql<{ id: string; name: string }[]>`
        SELECT id::text AS id, name
        FROM fitness.user_profile
        WHERE id = ${userId}
    `;
    if (!userRow) {
      throw new Error("Seed script did not create the expected baseline user");
    }
    expect(userRow).toEqual({
      id: userId,
      name: "Review User",
    });

    const firstCounts = await readSeedCounts(sql);
    await runSeed(ctx.connectionString);
    const secondCounts = await readSeedCounts(sql);

    try {
      expect(secondCounts).toEqual(firstCounts);
      expect(firstCounts.sessions).toBe(1);
      expect(firstCounts.providers).toBeGreaterThanOrEqual(5);
      expect(firstCounts.providerPriorities).toBeGreaterThanOrEqual(5);
      expect(firstCounts.userSettings).toBeGreaterThanOrEqual(2);
      expect(firstCounts.syncLogs).toBeGreaterThanOrEqual(10);
      expect(firstCounts.dailyMetrics).toBeGreaterThanOrEqual(170);
      expect(firstCounts.sleepSessions).toBeGreaterThanOrEqual(100);
      expect(firstCounts.sleepStages).toBeGreaterThanOrEqual(250);
      expect(firstCounts.activities).toBeGreaterThanOrEqual(90);
      expect(firstCounts.metricStream).toBeGreaterThanOrEqual(1_000);
      expect(firstCounts.activityIntervals).toBeGreaterThanOrEqual(10);
      expect(firstCounts.strengthWorkouts).toBeGreaterThanOrEqual(12);
      expect(firstCounts.strengthSets).toBeGreaterThanOrEqual(80);
      expect(firstCounts.nutritionDaily).toBeGreaterThanOrEqual(85);
      expect(firstCounts.foodEntries).toBeGreaterThanOrEqual(20);
      expect(firstCounts.supplements).toBeGreaterThanOrEqual(3);
      expect(firstCounts.bodyMeasurements).toBeGreaterThanOrEqual(50);
      expect(firstCounts.labPanels).toBeGreaterThanOrEqual(2);
      expect(firstCounts.labResults).toBeGreaterThanOrEqual(8);
      expect(firstCounts.dexaScans).toBeGreaterThanOrEqual(2);
      expect(firstCounts.journalEntries).toBeGreaterThanOrEqual(30);
      expect(firstCounts.lifeEvents).toBeGreaterThanOrEqual(3);
      expect(firstCounts.breathworkSessions).toBeGreaterThanOrEqual(10);
      expect(firstCounts.menstrualPeriods).toBeGreaterThanOrEqual(4);
      expect(firstCounts.vSleep).toBeGreaterThanOrEqual(90);
      expect(firstCounts.vDailyMetrics).toBeGreaterThanOrEqual(170);
      expect(firstCounts.vBodyMeasurement).toBeGreaterThanOrEqual(50);
      expect(firstCounts.activitySummary).toBeGreaterThanOrEqual(80);
    } finally {
      await sql.end();
    }
  }, 420_000);
});

async function runSeed(connectionString: string): Promise<void> {
  await execFileAsync("pnpm", ["exec", "tsx", "scripts/seed-dev-db.ts"], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
    },
    timeout: 300_000,
  });
}

async function readCount(sql: postgres.Sql, query: string): Promise<number> {
  const [row] = await sql.unsafe<CountRow[]>(query);
  if (!row) throw new Error(`Count query returned no rows: ${query}`);
  return row.count;
}

async function readSeedCounts(sql: postgres.Sql): Promise<SeedCounts> {
  return {
    providers: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.provider WHERE user_id = '${userId}'`,
    ),
    sessions: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.session WHERE user_id = '${userId}' AND id = 'dev-session'`,
    ),
    providerPriorities: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.provider_priority pp JOIN fitness.provider p ON p.id = pp.provider_id WHERE p.user_id = '${userId}'`,
    ),
    userSettings: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.user_settings WHERE user_id = '${userId}'`,
    ),
    syncLogs: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.sync_log WHERE user_id = '${userId}'`,
    ),
    dailyMetrics: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.daily_metrics WHERE user_id = '${userId}'`,
    ),
    sleepSessions: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.sleep_session WHERE user_id = '${userId}'`,
    ),
    sleepStages: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.sleep_stage stage JOIN fitness.sleep_session session ON session.id = stage.session_id WHERE session.user_id = '${userId}'`,
    ),
    activities: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.activity WHERE user_id = '${userId}'`,
    ),
    metricStream: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.metric_stream WHERE user_id = '${userId}'`,
    ),
    activityIntervals: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.activity_interval interval JOIN fitness.activity activity ON activity.id = interval.activity_id WHERE activity.user_id = '${userId}'`,
    ),
    strengthWorkouts: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.activity WHERE user_id = '${userId}' AND activity_type = 'strength'`,
    ),
    strengthSets: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.strength_set strength_set JOIN fitness.activity activity ON activity.id = strength_set.activity_id WHERE activity.user_id = '${userId}'`,
    ),

    nutritionDaily: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.nutrition_daily WHERE user_id = '${userId}'`,
    ),
    foodEntries: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.food_entry WHERE user_id = '${userId}'`,
    ),
    supplements: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.supplement WHERE user_id = '${userId}'`,
    ),
    bodyMeasurements: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.body_measurement WHERE user_id = '${userId}'`,
    ),
    labPanels: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.lab_panel WHERE user_id = '${userId}'`,
    ),
    labResults: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.lab_result WHERE user_id = '${userId}'`,
    ),
    dexaScans: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.dexa_scan WHERE user_id = '${userId}'`,
    ),
    journalEntries: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.journal_entry WHERE user_id = '${userId}'`,
    ),
    lifeEvents: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.life_events WHERE user_id = '${userId}'`,
    ),
    breathworkSessions: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.breathwork_session WHERE user_id = '${userId}'`,
    ),
    menstrualPeriods: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.menstrual_period WHERE user_id = '${userId}'`,
    ),
    vSleep: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.v_sleep WHERE user_id = '${userId}'`,
    ),
    vDailyMetrics: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.v_daily_metrics WHERE user_id = '${userId}'`,
    ),
    vBodyMeasurement: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.v_body_measurement WHERE user_id = '${userId}'`,
    ),
    activitySummary: await readCount(
      sql,
      `SELECT COUNT(*)::int AS count FROM fitness.activity_summary WHERE user_id = '${userId}'`,
    ),
  };
}
