import { describe, expect, it, vi } from "vitest";
import { createMigration } from "./0076_stable_activity_group_id.ts";
import { clickHouseMigrations } from "./registry.ts";

describe("stable activity group migration", () => {
  it("registers the persisted membership columns without a fabricated group default", () => {
    const migration = clickHouseMigrations("postgres://test").find(
      (candidate) => candidate.id === "0076_stable_activity_group_id",
    );
    expect(migration?.statements).toEqual(
      expect.arrayContaining([
        "ALTER TABLE postgres_fitness.activity ADD COLUMN IF NOT EXISTS group_id Nullable(UUID)",
        "ALTER TABLE analytics.activity_source_records ADD COLUMN IF NOT EXISTS group_id Nullable(UUID) AFTER activity_id",
      ]),
    );
  });

  it.each([0, 1])(
    "alters the dbt projection only when its table exists (count %s)",
    async (count) => {
      const migration = createMigration();
      if (!migration.run) throw new Error("Expected migration runner");
      const command = vi.fn(async () => {});
      const query = vi.fn(async () => ({
        json: async () => JSON.parse(JSON.stringify([{ count }])),
      }));
      await migration.run({ command, query }, "postgres://test");
      expect(command.mock.calls).toMatchObject(
        migration.statements.slice(0, count + 1).map((statement) => [{ query: statement }]),
      );
    },
  );

  it("requires schema inspection before applying the migration", async () => {
    const migration = createMigration();
    if (!migration.run) throw new Error("Expected migration runner");
    await expect(
      migration.run({ command: vi.fn(async () => {}) }, "postgres://test"),
    ).rejects.toThrow("query-capable client");
  });
});
