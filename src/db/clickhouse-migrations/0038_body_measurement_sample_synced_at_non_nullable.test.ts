import { describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0038_body_measurement_sample_synced_at_non_nullable.ts";

function createClient(opts: {
  tableCount: number;
  columnSchemas?: Array<{
    type: string;
    default_kind?: string | null;
    default_expression?: string | null;
  }>;
  tableRows?: Array<{ count: string | number }>;
}): ClickHouseCommandClient {
  const command = vi.fn();
  const tableRows = opts.tableRows ?? [{ count: String(opts.tableCount) }];
  const tableCountResult = { json: async () => tableRows };
  const columnSchemas = opts.columnSchemas ?? [];
  let columnSchemaQueryCount = 0;
  const query = vi.fn().mockImplementation((args: { query: string }) => {
    const trimmed = args.query.trim();
    if (trimmed.startsWith("SELECT count()")) return Promise.resolve(tableCountResult);
    if (trimmed.startsWith("SELECT type")) {
      const schema = columnSchemas[Math.min(columnSchemaQueryCount, columnSchemas.length - 1)];
      columnSchemaQueryCount += 1;
      return Promise.resolve({
        json: async () =>
          schema
            ? [
                {
                  type: schema.type,
                  default_kind: schema.default_kind ?? null,
                  default_expression: schema.default_expression ?? null,
                },
              ]
            : [],
      });
    }
    return Promise.resolve({ json: async () => [] });
  });
  return { command, query };
}

describe("0038_body_measurement_sample_synced_at_non_nullable", () => {
  it("skips when the table does not exist", async () => {
    const client = createClient({ tableCount: 0 });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).not.toHaveBeenCalled();
  });

  it("skips when the table metadata query returns no rows", async () => {
    const client = createClient({ tableCount: 0, tableRows: [] });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).not.toHaveBeenCalled();
  });

  it("requires a query-capable client", async () => {
    const migration = createMigration();

    await expect(
      migration.run?.({ command: vi.fn() }, "postgres://test:test@localhost:5432/test"),
    ).rejects.toThrow("ClickHouse migrations require a query-capable client");
  });

  it("backfills NULL _peerdb_synced_at rows and tightens the column to non-nullable", async () => {
    const client = createClient({
      tableCount: 1,
      columnSchemas: [{ type: "Nullable(DateTime64(9))" }],
    });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.command).mock.calls[0]?.[0]?.query).toBe(
      "ALTER TABLE analytics.body_measurement_sample UPDATE _peerdb_synced_at = recorded_at WHERE _peerdb_synced_at IS NULL",
    );
    expect(vi.mocked(client.command).mock.calls[0]?.[0]?.clickhouse_settings).toEqual({
      mutations_sync: 2,
    });
    expect(vi.mocked(client.command).mock.calls[1]?.[0]?.query).toBe(
      "ALTER TABLE analytics.body_measurement_sample MODIFY COLUMN _peerdb_synced_at DateTime64(9) DEFAULT now()",
    );
  });

  it("skips mutation and modify when the target schema is already applied", async () => {
    const client = createClient({
      tableCount: 1,
      columnSchemas: [
        {
          type: "DateTime64(9)",
          default_kind: "DEFAULT",
          default_expression: "now()",
        },
      ],
    });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).not.toHaveBeenCalled();
  });

  it("applies the default when the column is non-nullable without the target default", async () => {
    const client = createClient({
      tableCount: 1,
      columnSchemas: [{ type: "DateTime64(9)" }],
    });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.command).mock.calls[0]?.[0]?.query).toBe(
      "ALTER TABLE analytics.body_measurement_sample MODIFY COLUMN _peerdb_synced_at DateTime64(9) DEFAULT now()",
    );
  });

  it("applies the migration when only the default expression already matches", async () => {
    const client = createClient({
      tableCount: 1,
      columnSchemas: [
        {
          type: "Nullable(DateTime64(9))",
          default_expression: "now()",
        },
      ],
    });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).toHaveBeenCalledTimes(2);
  });

  it("applies the migration when only the type already matches", async () => {
    const client = createClient({
      tableCount: 1,
      columnSchemas: [{ type: "DateTime64(9)", default_kind: "DEFAULT" }],
    });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).toHaveBeenCalledTimes(1);
  });

  it("skips the modify statement when the second schema check observes the target schema", async () => {
    const client = createClient({
      tableCount: 1,
      columnSchemas: [
        { type: "DateTime64(9)" },
        {
          type: "DateTime64(9)",
          default_kind: "DEFAULT",
          default_expression: "now()",
        },
      ],
    });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).not.toHaveBeenCalled();
  });

  it("backfills and tightens when the column metadata query returns no rows", async () => {
    const client = createClient({ tableCount: 1 });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.command).mock.calls[0]?.[0]?.clickhouse_settings).toEqual({
      mutations_sync: 2,
    });
    expect(vi.mocked(client.command).mock.calls[1]?.[0]?.query).toBe(
      "ALTER TABLE analytics.body_measurement_sample MODIFY COLUMN _peerdb_synced_at DateTime64(9) DEFAULT now()",
    );
  });
});
