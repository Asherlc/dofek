import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { drizzleSchema as schema } from "./drizzle-schema.ts";
import { createDatabase } from "./index.ts";

export type TestDatabase = ReturnType<typeof createDatabase>;

export interface TestContext {
  db: TestDatabase;
  connectionString: string;
  addCleanup: (cleanup: () => Promise<void>) => void;
  cleanup: () => Promise<void>;
}

interface TestMigrationFile {
  content: string;
  file: string;
  when: number;
}

export function writeTestMigrationFiles(
  migrationsDir: string,
  migrations: TestMigrationFile[],
): void {
  mkdirSync(join(migrationsDir, "meta"), { recursive: true });
  for (const migration of migrations) {
    writeFileSync(join(migrationsDir, migration.file), migration.content);
  }
  writeFileSync(
    join(migrationsDir, "meta/_journal.json"),
    JSON.stringify({
      dialect: "postgresql",
      entries: migrations.map((migration, index) => ({
        breakpoints: true,
        idx: index,
        tag: migration.file.replace(/\.sql$/, ""),
        version: "7",
        when: migration.when,
      })),
      version: "7",
    }),
  );
}

const isRunnableMigrationStatement = (statement: string): boolean =>
  statement.length > 0 && !statement.includes("CREATE OR REPLACE VIEW clickhouse.v_sleep AS");

let templateDatabasePromise: Promise<string> | null = null;
let templateDatabaseCleanup: { adminUrl: string; templateName: string } | null = null;
let templateDatabaseCleanupRegistered = false;
const templateDatabaseInstanceId = randomBytes(8).toString("hex");

const databaseNameForUrl = (adminUrl: string, dbName: string): string => {
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
};

const processTemplateDatabaseName = (): string =>
  `dofek_integration_template_${process.pid}_${templateDatabaseInstanceId}`;

async function ensureTemplateDatabase(adminUrl: string): Promise<string> {
  templateDatabasePromise ??= createTemplateDatabase(adminUrl).catch((error: unknown) => {
    templateDatabasePromise = null;
    throw error;
  });
  return templateDatabasePromise;
}

async function createTemplateDatabase(adminUrl: string): Promise<string> {
  const templateName = processTemplateDatabaseName();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(templateName)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${escapeIdentifier(templateName)}`);
  } finally {
    await admin.end();
  }

  const templateConnectionString = databaseNameForUrl(adminUrl, templateName);
  await waitForDatabase(templateConnectionString);
  await migrateTestDatabase(templateConnectionString);
  await lockTemplateDatabase(adminUrl, templateName);
  registerTemplateDatabaseCleanup(adminUrl, templateName);

  return templateName;
}

async function lockTemplateDatabase(adminUrl: string, templateName: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `ALTER DATABASE ${escapeIdentifier(templateName)} WITH ALLOW_CONNECTIONS false`,
    );
    await terminateDatabaseConnections(admin, templateName);
  } finally {
    await admin.end();
  }
}

function registerTemplateDatabaseCleanup(adminUrl: string, templateName: string): void {
  templateDatabaseCleanup = { adminUrl, templateName };
  if (templateDatabaseCleanupRegistered) return;

  templateDatabaseCleanupRegistered = true;
  process.once("beforeExit", () => {
    void cleanupTemplateDatabaseAtProcessExit().catch((error: unknown) => {
      process.emitWarning(error instanceof Error ? error : String(error), {
        type: "TestDatabaseCleanupWarning",
      });
    });
  });
}

async function cleanupTemplateDatabaseAtProcessExit(): Promise<void> {
  const cleanup = templateDatabaseCleanup;
  templateDatabaseCleanup = null;
  templateDatabasePromise = null;
  if (!cleanup) return;

  await dropDatabase(cleanup.adminUrl, cleanup.templateName);
}

async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(dbName)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function terminateDatabaseConnections(admin: Client, dbName: string): Promise<void> {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
}

async function waitForDatabase(connectionString: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const probe = new Client({ connectionString });
      await probe.connect();
      await probe.query("SELECT 1");
      await probe.end();
      return;
    } catch {
      if (attempt === 29) throw new Error("Database did not become ready in time");
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
}

async function migrateTestDatabase(connectionString: string): Promise<void> {
  const migrationClient = new Client({ connectionString });
  await migrationClient.connect();
  const drizzleDir = resolve(import.meta.dirname, "../../drizzle");
  const migrationFiles = readdirSync(drizzleDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const content = readFileSync(resolve(drizzleDir, file), "utf-8");
    const statements = content
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(isRunnableMigrationStatement);

    for (const statement of statements) {
      await migrationClient.query(statement);
    }
  }

  // Recreate canonical fitness views from their checked-in definitions.
  const viewsDir = join(drizzleDir, "_views");
  if (existsSync(viewsDir)) {
    const viewFiles = readdirSync(viewsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    // Parse view files upfront so we know which views to drop.
    // Only files containing CREATE MATERIALIZED VIEW are matviews; CREATE OR
    // REPLACE VIEW files are plain views (handled differently below).
    const parsedViews = viewFiles.map((file) => {
      const content = readFileSync(join(viewsDir, file), "utf-8");
      const match = content.match(
        /CREATE\s+MATERIALIZED\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?fitness\.(\w+)/i,
      );
      return { content, viewName: match?.[1] };
    });

    // Drop managed matviews in reverse order (dependents first). CASCADE is
    // used so dependencies are removed before canonical definitions are
    // recreated below.
    for (const { viewName } of [...parsedViews].reverse()) {
      if (!viewName) continue;
      await migrationClient.query(
        `DROP MATERIALIZED VIEW IF EXISTS ${escapeIdentifier("fitness")}.${escapeIdentifier(viewName)} CASCADE`,
      );
    }

    // Recreate in filename order so base views exist before dependents.
    for (const { content } of parsedViews) {
      const statements = content
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) {
        await migrationClient.query(statement);
      }
    }
  }

  // Seed the canonical integration-test user.
  // Many integration tests use TEST_USER_ID fixtures and expect this row to exist.
  await migrationClient.query(
    `INSERT INTO fitness.user_profile (id, name)
     VALUES ($1, 'Test User')
     ON CONFLICT (id) DO NOTHING`,
    [schema.TEST_USER_ID],
  );

  // Seed billing record with existing_account grant so tests get full access.
  await migrationClient.query(
    `INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
     VALUES ($1, 'existing_account')
     ON CONFLICT (user_id) DO NOTHING`,
    [schema.TEST_USER_ID],
  );

  await migrationClient.end();
}

/**
 * Clone an isolated database from the migrated integration-test template.
 * Call cleanup() in afterAll to tear down the clone.
 */
export async function setupTestDatabase(): Promise<TestContext> {
  const adminUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!adminUrl) {
    throw new Error(
      "TEST_DATABASE_URL is required for integration tests. Run `pnpm test:integration` to start the workspace database.",
    );
  }

  const cleanupTasks: Array<() => Promise<void>> = [];
  const templateName = await ensureTemplateDatabase(adminUrl);
  const databaseName = `test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await terminateDatabaseConnections(admin, templateName);
    await admin.query(
      `CREATE DATABASE ${escapeIdentifier(databaseName)} WITH TEMPLATE ${escapeIdentifier(templateName)}`,
    );
  } finally {
    await admin.end();
  }

  const connectionString = databaseNameForUrl(adminUrl, databaseName);
  await waitForDatabase(connectionString);
  const db = createDatabase(connectionString);

  return {
    db,
    connectionString,
    addCleanup: (cleanup) => {
      cleanupTasks.push(cleanup);
    },
    cleanup: async () => {
      for (const cleanupTask of [...cleanupTasks].reverse()) {
        await cleanupTask();
      }
      await db.$client.end();
      await dropDatabase(adminUrl, databaseName);
    },
  };
}
