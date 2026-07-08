import { describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";
import { createMigration } from "./0038_body_measurement_sample_synced_at_non_nullable.ts";

function createClient(opts: {
  tableCount: number;
  columnType?: string;
  defaultKind?: string | null;
  defaultExpression?: string | null;
}): ClickHouseCommandClient {
  const command = vi.fn();
  const tableCountResult = { json: async () => [{ count: String(opts.tableCount) }] };
  const columnTypeResult = {
    json: async () =>
      opts.columnType !== undefined
        ? [
            {
              type: opts.columnType,
              default_kind: opts.defaultKind ?? null,
              default_expression: opts.defaultExpression ?? null,
            },
          ]
        : [],
  };
  const query = vi.fn().mockImplementation((args: { query: string }) => {
    const trimmed = args.query.trim();
    if (trimmed.startsWith("SELECT count()")) return Promise.resolve(tableCountResult);
    if (trimmed.startsWith("SELECT type")) return Promise.resolve(columnTypeResult);
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

  it("backfills NULL _peerdb_synced_at rows and tightens the column to non-nullable", async () => {
    const client = createClient({
      tableCount: 1,
      columnType: "Nullable(DateTime64(9))",
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
      columnType: "DateTime64(9)",
      defaultKind: "DEFAULT",
      defaultExpression: "now()",
    });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).not.toHaveBeenCalled();
  });

  it("applies the default when the column is non-nullable without the target default", async () => {
    const client = createClient({
      tableCount: 1,
      columnType: "DateTime64(9)",
    });
    const migration = createMigration();

    await migration.run?.(client, "postgres://test:test@localhost:5432/test");

    expect(client.command).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.command).mock.calls[0]?.[0]?.query).toBe(
      "ALTER TABLE analytics.body_measurement_sample MODIFY COLUMN _peerdb_synced_at DateTime64(9) DEFAULT now()",
    );
  });
});
