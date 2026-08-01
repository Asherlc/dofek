import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../clickhouse.ts";

const { mockRunClickHouseMigrationStatement } = vi.hoisted(() => ({
  mockRunClickHouseMigrationStatement: vi.fn(),
}));

vi.mock("./statement-runner.ts", () => ({
  runClickHouseMigrationStatement: mockRunClickHouseMigrationStatement,
}));

import { createMigration } from "./0067_repair_local_time_column_order.ts";

type QueryOptions = Parameters<NonNullable<ClickHouseCommandClient["query"]>>[0];

class TestClickHouseClient implements ClickHouseCommandClient {
  readonly #existingTables: readonly string[];
  readonly #tableCountOverride: number | string | undefined;
  readonly command = vi.fn(async () => undefined);
  readonly queryCalls: QueryOptions[] = [];

  constructor(existingTables: readonly string[], tableCountOverride?: number | string) {
    this.#existingTables = existingTables;
    this.#tableCountOverride = tableCountOverride;
  }

  async query<TRow extends object>(options: QueryOptions): Promise<{ json(): Promise<TRow[]> }> {
    this.queryCalls.push(options);
    const tableName = String(options.query_params?.name);
    const count = this.#tableCountOverride ?? (this.#existingTables.includes(tableName) ? 1 : 0);
    return {
      json: async () => JSON.parse(JSON.stringify([{ count }])),
    };
  }
}

function readModelColumns(name: string): string[] {
  const modelUrl = new URL(`../../../analytics/models/read_models/${name}.sql`, import.meta.url);
  const sql = readFileSync(modelUrl, "utf8");
  // Each model ends with one or two top-level `SELECT ... FROM` projections (an
  // incremental tombstone branch adds a UNION ALL with the same column aliases).
  // Only the final projections start at column 0, so a line-anchored `SELECT` is
  // unambiguous. Take the first one and read its ordered output column aliases.
  const projection = sql.match(/\nSELECT\n(?<body>[\s\S]*?)\nFROM /);
  const body = projection?.groups?.body;
  if (!body) {
    throw new Error(`Could not locate a final SELECT projection in ${name}.sql`);
  }
  return body
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => line.length > 0)
    .map((expression) => {
      const alias = expression.match(/(?:.*\bAS\s+)?(?<alias>[A-Za-z_][A-Za-z0-9_]*)$/);
      if (!alias?.groups?.alias) {
        throw new Error(`Could not read a column alias from "${expression}" in ${name}.sql`);
      }
      return alias.groups.alias;
    });
}

// Rebuild the physical column order the migration produces for `table` by
// walking its `MODIFY COLUMN <column> ... AFTER <anchor>` chain from the given
// starting anchor. Every ALTER statement for `table` must parse; a statement
// that falls through the pattern would silently shorten the chain and let an
// ordering regression pass, so fail loudly instead.
const MODIFY_COLUMN_PATTERN =
  /ALTER TABLE analytics\.(\w+)\s+MODIFY COLUMN (\w+)[\s\S]*?AFTER (\w+)/;

function repositionedOrder(statements: readonly string[], table: string, anchor: string): string[] {
  const nextColumnByAnchor = new Map<string, string>();
  for (const statement of statements) {
    if (!statement.startsWith(`ALTER TABLE analytics.${table}`)) {
      continue;
    }
    const [, , column, columnAnchor] = statement.match(MODIFY_COLUMN_PATTERN) ?? [];
    if (!column || !columnAnchor) {
      throw new Error(`Could not parse the MODIFY COLUMN layout for ${table}: "${statement}"`);
    }
    nextColumnByAnchor.set(columnAnchor, column);
  }

  const order = [anchor];
  let nextColumn = nextColumnByAnchor.get(anchor);
  while (nextColumn !== undefined) {
    order.push(nextColumn);
    nextColumn = nextColumnByAnchor.get(nextColumn);
  }
  return order;
}

describe("0067_repair_local_time_column_order", () => {
  beforeEach(() => {
    mockRunClickHouseMigrationStatement.mockReset();
  });

  it("repositions the record-local time columns to match each model's SELECT order", () => {
    const migration = createMigration();

    expect(migration.id).toBe("0067_repair_local_time_column_order");
    expect(migration.statements).toEqual([
      `ALTER TABLE analytics.activity_source_records
  MODIFY COLUMN start_utc_offset_minutes Nullable(Int16) AFTER timezone`,
      `ALTER TABLE analytics.activity_source_records
  MODIFY COLUMN end_utc_offset_minutes Nullable(Int16) AFTER start_utc_offset_minutes`,
      `ALTER TABLE analytics.activity_source_records
  MODIFY COLUMN local_time_source LowCardinality(String) DEFAULT 'unknown' AFTER end_utc_offset_minutes`,
      `ALTER TABLE analytics.deduped_activities
  MODIFY COLUMN start_utc_offset_minutes Nullable(Int16) AFTER timezone`,
      `ALTER TABLE analytics.deduped_activities
  MODIFY COLUMN end_utc_offset_minutes Nullable(Int16) AFTER start_utc_offset_minutes`,
      `ALTER TABLE analytics.deduped_activities
  MODIFY COLUMN local_time_source LowCardinality(String) DEFAULT 'unknown' AFTER end_utc_offset_minutes`,
      `ALTER TABLE analytics.daily_sleep
  MODIFY COLUMN timezone Nullable(String) AFTER overlapping_sessions`,
      `ALTER TABLE analytics.daily_sleep
  MODIFY COLUMN start_utc_offset_minutes Nullable(Int16) AFTER timezone`,
      `ALTER TABLE analytics.daily_sleep
  MODIFY COLUMN end_utc_offset_minutes Nullable(Int16) AFTER start_utc_offset_minutes`,
      `ALTER TABLE analytics.daily_sleep
  MODIFY COLUMN local_time_source LowCardinality(String) DEFAULT 'unknown' AFTER end_utc_offset_minutes`,
    ]);
  });

  // The regression the incident needed: the physical column order the migration
  // produces must equal each dbt model's final SELECT order, because
  // dbt-clickhouse binds `INSERT INTO <table> (<physical order>) <model SELECT>`
  // positionally. Substring assertions on the model SQL cannot catch this.
  it.each([
    { anchor: "timezone", model: "activity_source_records", table: "activity_source_records" },
    { anchor: "timezone", model: "deduped_activities", table: "deduped_activities" },
    { anchor: "overlapping_sessions", model: "daily_sleep", table: "daily_sleep" },
  ])("aligns $table with the $model model projection", ({ anchor, model, table }) => {
    const columns = readModelColumns(model);
    const anchorIndex = columns.indexOf(anchor);
    expect(anchorIndex).toBeGreaterThanOrEqual(0);

    const migrationOrder = repositionedOrder(createMigration().statements, table, anchor);
    const modelOrder = columns.slice(anchorIndex, anchorIndex + migrationOrder.length);

    expect(migrationOrder).toEqual(modelOrder);
    expect(migrationOrder.at(-1)).toBe("local_time_source");
  });

  it("only repositions serving tables that already exist", async () => {
    const client = new TestClickHouseClient(["activity_source_records", "daily_sleep"]);
    const migration = createMigration();

    await migration.run?.(client, "postgres://test");

    // deduped_activities is absent, so its three statements are skipped while the
    // other two tables' statements still run in order.
    expect(
      mockRunClickHouseMigrationStatement.mock.calls.map(([, statement]) => statement),
    ).toEqual([
      migration.statements[0],
      migration.statements[1],
      migration.statements[2],
      migration.statements[6],
      migration.statements[7],
      migration.statements[8],
      migration.statements[9],
    ]);
    expect(client.queryCalls.map((call) => call.query_params)).toEqual([
      { name: "activity_source_records" },
      { name: "deduped_activities" },
      { name: "daily_sleep" },
    ]);
  });

  it("requires a query-capable client", async () => {
    const client: ClickHouseCommandClient = { command: vi.fn(async () => undefined) };

    await expect(createMigration().run?.(client, "postgres://test")).rejects.toThrow(
      "ClickHouse migrations require a query-capable client",
    );
  });

  it("rejects a malformed serving-table count", async () => {
    const client = new TestClickHouseClient([], "not-a-count");

    await expect(createMigration().run?.(client, "postgres://test")).rejects.toThrow();
  });
});
