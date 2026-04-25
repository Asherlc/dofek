import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { GenericContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const userId = "00000000-0000-0000-0000-000000000001";

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

  const viewsDir = join(drizzleDir, "_views");
  if (existsSync(viewsDir)) {
    const viewFiles = readdirSync(viewsDir)
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

    const parsedViews = viewFiles.map((fileName) => {
      const content = readFileSync(join(viewsDir, fileName), "utf-8");
      const match = content.match(/CREATE\s+MATERIALIZED\s+VIEW\s+fitness\.(\w+)/i);
      return { content, viewName: match?.[1] };
    });

    for (const { viewName } of [...parsedViews].reverse()) {
      if (!viewName) continue;
      await sql.unsafe(`DROP MATERIALIZED VIEW IF EXISTS fitness.${viewName} CASCADE`);
    }

    for (const { content } of parsedViews) {
      const statements = content
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await sql.unsafe(statement);
      }
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

  it("creates the baseline user before inserting provider data", async () => {
    await execFileAsync("pnpm", ["exec", "tsx", "scripts/seed-dev-db.ts"], {
      cwd: resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        DATABASE_URL: ctx.connectionString,
      },
      timeout: 120_000,
    });

    const sql = postgres(ctx.connectionString, { max: 1 });
    const [userRow] = await sql<{ id: string; name: string }[]>`
        SELECT id::text AS id, name
        FROM fitness.user_profile
        WHERE id = ${userId}
    `;
    const [providerCountRow] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM fitness.provider
        WHERE user_id = ${userId}
    `;
    const [sessionCountRow] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM fitness.session
        WHERE user_id = ${userId} AND id = 'dev-session'
    `;

    if (!userRow || !providerCountRow || !sessionCountRow) {
      throw new Error("Seed script did not create the expected baseline rows");
    }

    expect(userRow).toEqual({
      id: userId,
      name: "Baseline User",
    });
    expect(providerCountRow.count).toBe(2);
    expect(sessionCountRow.count).toBe(1);

    await sql.end();
  }, 180_000);
});
