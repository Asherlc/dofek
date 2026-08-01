import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const installerUserId = "a0000000-0000-4000-8000-000000001994";
const unrelatedSlackUserId = "b0000000-0000-4000-8000-000000001994";

function databaseUrlWithName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function migrationStatements(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.length > 0 && !statement.includes("CREATE OR REPLACE VIEW clickhouse.v_sleep AS"),
    );
}

describe("0062 account erasure migration (integration)", () => {
  let admin: Client;
  let database: Client;
  let databaseName: string;

  beforeAll(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL?.trim();
    if (!adminUrl) {
      throw new Error(
        "TEST_DATABASE_URL is required for integration tests. Run `pnpm test:integration` to start the workspace database.",
      );
    }

    databaseName = `test_account_erasure_migration_${randomBytes(6).toString("hex")}`;
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);

    database = new Client({
      connectionString: databaseUrlWithName(adminUrl, databaseName),
    });
    await database.connect();

    const migrationsDirectory = resolve(import.meta.dirname, "../../drizzle");
    const preAccountErasureMigrations = readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith(".sql") && file !== "0062_account_erasure.sql")
      .sort();
    for (const migration of preAccountErasureMigrations) {
      for (const statement of migrationStatements(resolve(migrationsDirectory, migration))) {
        await database.query(statement);
      }
    }

    await database.query(
      `INSERT INTO fitness.user_profile (id, name)
       VALUES
         ($1::uuid, 'Legacy Slack installer'),
         ($2::uuid, 'Unrelated Slack identity')`,
      [installerUserId, unrelatedSlackUserId],
    );
    await database.query(
      `INSERT INTO fitness.auth_account (
         user_id, auth_provider, provider_account_id
       )
       VALUES
         ($1::uuid, 'slack', 'U-LEGACY-INSTALLER-1994'),
         ($2::uuid, 'slack', 'U-LEGACY-UNRELATED-1994')`,
      [installerUserId, unrelatedSlackUserId],
    );
    await database.query(
      `INSERT INTO fitness.slack_installation (
         team_id,
         bot_token,
         installer_slack_user_id,
         raw_installation
       )
       VALUES
         ('T-LEGACY-INFERABLE-1994', 'legacy-token', 'U-LEGACY-INSTALLER-1994', '{}'::jsonb),
         ('T-LEGACY-NO-AUTH-1994', 'legacy-token', 'U-NO-AUTH-1994', '{}'::jsonb)`,
    );

    for (const statement of migrationStatements(
      resolve(migrationsDirectory, "0062_account_erasure.sql"),
    )) {
      await database.query(statement);
    }
  }, 240_000);

  afterAll(async () => {
    await database?.end();
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(databaseName)} WITH (FORCE)`);
    }
    await admin?.end();
  });

  it("creates only the membership schema and leaves legacy data to the operator backfill", async () => {
    const result = await database.query(
      `SELECT team_id, user_id, slack_user_id
       FROM fitness.slack_team_membership
       ORDER BY team_id, user_id`,
    );

    expect(result.rows).toEqual([]);
  });
});
