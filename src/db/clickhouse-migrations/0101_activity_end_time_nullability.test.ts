import { describe, expect, it, vi } from "vitest";
import { createMigration } from "./0101_activity_end_time_nullability.ts";

describe("activity end time migration dispatch", () => {
  it.each([0, 1])("alters only existing read models (table count %s)", async (count) => {
    const migration = createMigration();
    if (!migration.run) throw new Error("Expected query-aware migration");
    const command = vi.fn(async () => {});
    const query = vi.fn(async () => ({
      json: async () => JSON.parse(JSON.stringify(count ? [{ name: "deduped_activities" }] : [])),
    }));
    await migration.run({ command, query }, "postgres://test");
    expect(query).toHaveBeenCalledWith({
      query:
        "SELECT name FROM system.tables WHERE database = 'analytics' AND name = 'deduped_activities'",
      format: "JSONEachRow",
    });
    expect(command.mock.calls).toMatchObject(
      migration.statements.slice(0, count + 1).map((statement) => [{ query: statement }]),
    );
  });

  it("rejects an invalid schema inspection response", async () => {
    const migration = createMigration();
    if (!migration.run) throw new Error("Expected query-aware migration");
    const query = vi.fn(async () => ({ json: async () => JSON.parse("[{}]") }));
    await expect(
      migration.run({ command: vi.fn(async () => {}), query }, "postgres://test"),
    ).rejects.toThrow("name");
  });

  it("requires schema inspection before altering tables", async () => {
    const migration = createMigration();
    if (!migration.run) throw new Error("Expected query-aware migration");
    await expect(
      migration.run({ command: vi.fn(async () => {}) }, "postgres://test"),
    ).rejects.toThrow("query-capable client");
  });
});
