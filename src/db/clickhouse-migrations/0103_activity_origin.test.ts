import { describe, expect, it, vi } from "vitest";
import { createMigration } from "./0103_activity_origin.ts";

describe("activity origin schema migration", () => {
  it.each([false, true])(
    "preserves the original column and can resume after rename (%s)",
    async (alreadyRenamed) => {
      const migration = createMigration();
      expect(migration.run).toBeDefined();
      if (!migration.run) throw new Error("Expected schema-aware origin migration");
      const command = vi.fn(async (_options: { query: string }) => {});
      const query = vi.fn(async () => ({
        json: async () =>
          JSON.parse(
            JSON.stringify(
              (alreadyRenamed ? ["representative_activity_id"] : ["primary_activity_id"]).map(
                (name) => ({ name }),
              ),
            ),
          ),
      }));
      await migration.run({ command, query }, "postgres://test");
      const statements = command.mock.calls.map(([options]) => options.query);
      expect(statements.some((statement) => statement.includes("RENAME COLUMN"))).toBe(
        !alreadyRenamed,
      );
      expect(statements).toContain(
        "ALTER TABLE analytics.deduped_activities ADD COLUMN IF NOT EXISTS primary_activity_id Nullable(UUID) DEFAULT NULL AFTER user_id",
      );
      expect(statements.some((statement) => statement.includes("MATERIALIZE"))).toBe(false);
    },
  );

  it("rejects an incomplete source schema rather than guessing how to preserve it", async () => {
    const migration = createMigration();
    expect(migration.run).toBeDefined();
    if (!migration.run) throw new Error("Expected schema-aware origin migration");
    await expect(
      migration.run(
        {
          command: vi.fn(async () => {}),
          query: vi.fn(async () => ({ json: async () => JSON.parse("[]") })),
        },
        "postgres://test",
      ),
    ).rejects.toThrow("representative");
  });
});
