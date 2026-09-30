import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resetLegacyClimbingTables } from "./climbing-migration-test-helpers.ts";
import { runMigrations } from "./migrate.ts";
import { setupTestDatabase, writeTestMigrationFiles } from "./test-helpers.ts";

const journalSchema = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number() })),
});

describe("climbing and Apple Health migration histories", () => {
  it.each([
    ["0133_independent_climbing_outcome_count", 1790727480000],
    ["0133_apple_health_workout_revisions", 1790720000000],
  ])(
    "upgrades the previously applied %s history without replay",
    async (appliedTag, appliedWhen) => {
      const context = await setupTestDatabase();
      const client = new Client({ connectionString: context.connectionString });
      const directory = mkdtempSync(join(tmpdir(), "climbing-history-"));
      const userId = randomUUID();
      const entryId = randomUUID();
      try {
        await client.connect();
        await resetLegacyClimbingTables(client);
        await client.query(
          "INSERT INTO fitness.user_profile (id, name) VALUES ($1, 'History fixture')",
          [userId],
        );
        await client.query(
          `INSERT INTO fitness.climbing_entry
        (id, user_id, provider_id, external_id, climb_type, grade_system, grade,
         sent, attempt_count, lead, location_name, raw)
        VALUES ($1, $2, 'mountain-project', 'original', 'route', 'yds', '5.9',
          false, 1, true, 'Country > Wall', '{"Style":"Lead","Lead Style":"Fell/Hung"}')`,
          [entryId, userId],
        );
        const root = join(import.meta.dirname, "../../drizzle");
        const tags = [
          "0133_independent_climbing_outcome_count",
          "0133_apple_health_workout_revisions",
          "0134_climbing_context",
        ];
        const journal = journalSchema.parse(
          JSON.parse(readFileSync(join(root, "meta/_journal.json"), "utf8")),
        );
        const migrations = journal.entries
          .filter((entry) => tags.includes(entry.tag))
          .map((entry) => ({
            file: `${entry.tag}.sql`,
            when: entry.when,
            content: readFileSync(join(root, `${entry.tag}.sql`), "utf8"),
          }));
        writeTestMigrationFiles(directory, migrations);
        const appliedContent = readFileSync(join(root, `${appliedTag}.sql`), "utf8");
        const appliedHash = createHash("sha256").update(appliedContent).digest("hex");
        if (appliedTag === "0133_independent_climbing_outcome_count") {
          await client.query(appliedContent);
          await client.query("DROP VIEW fitness.v_activity CASCADE");
        }
        await client.query(`DROP SCHEMA IF EXISTS drizzle CASCADE;
        CREATE SCHEMA drizzle;
        CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);`);
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [appliedHash, appliedWhen],
        );
        await runMigrations(context.connectionString, directory);
        expect((await client.query("SELECT count(*) FROM fitness.v_activity")).rows).toEqual([
          { count: "0" },
        ]);
        expect(
          (
            await client.query(
              "SELECT id, user_id, location_name, sent, lead, attempt_count FROM fitness.v_climbing_entry WHERE id = $1",
              [entryId],
            )
          ).rows,
        ).toEqual([
          {
            id: entryId,
            user_id: userId,
            location_name: "Country > Wall",
            sent: false,
            lead: true,
            attempt_count: null,
          },
        ]);
        expect(
          (
            await client.query(
              "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE hash = $1",
              [appliedHash],
            )
          ).rows,
        ).toEqual([{ count: "1" }]);
        expect(await runMigrations(context.connectionString, directory)).toBe(0);
      } finally {
        await client.end();
        await context.cleanup();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
