import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../db/clickhouse.ts";
import { eraseClickHouseAccount } from "./clickhouse-erasure.ts";

const userId = "10000000-0000-4000-8000-000000001994";
const operationId = "20000000-0000-4000-8000-000000001994";

interface QueryOptions {
  clickhouse_settings?: Record<string, string | number | boolean>;
  format: "JSONEachRow";
  query: string;
  query_params?: Record<string, unknown>;
}

function emptyCapturedIdentifiers() {
  return [
    {
      activity_ids: [],
      operation_ids: [],
      record_ids: [],
      sleep_ids: [],
      string_relation_ids: [],
    },
  ];
}

function queryReturningTables(tables: readonly Record<string, unknown>[]) {
  return vi.fn(async (options: QueryOptions) => {
    if (options.query.includes("FROM system.tables")) {
      return { json: async () => tables };
    }
    if (options.query.includes(" AS activity_ids")) {
      return { json: async () => emptyCapturedIdentifiers() };
    }
    if (options.query.includes("SELECT DISTINCT _part")) {
      return { json: async () => [] };
    }
    if (options.query.includes("FROM system.parts") && options.query.includes("active = 0")) {
      return { json: async () => [] };
    }
    if (options.query.includes("FROM system.detached_parts")) {
      return { json: async () => [] };
    }
    if (
      options.query.includes("SELECT mutation_id") &&
      options.query.includes("FROM system.mutations")
    ) {
      return { json: async () => [] };
    }
    return { json: async () => [{ count: "0" }] };
  });
}

function successfulQuery() {
  return queryReturningTables([
    {
      age_milliseconds: 1_000_000,
      columns: [["user_id", "UUID"]],
      database: "analytics",
      engine: "ReplacingMergeTree",
      name: "daily_sleep",
    },
  ]);
}

describe("eraseClickHouseAccount", () => {
  it("uses only the production database allowlist and disables query logging for PII work", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = successfulQuery();

    await eraseClickHouseAccount(
      { command, insert, query },
      {
        activityIds: [],
        operationIds: [operationId],
        sleepSessionIds: [],
        userId,
      },
    );

    const discoveryCall = query.mock.calls.find(([options]) =>
      options.query.includes("FROM system.tables"),
    );
    expect(discoveryCall?.[0].query_params).toEqual({
      managed_databases: ["analytics", "ingest", "postgres_fitness"],
    });
    expect(discoveryCall?.[0].query).not.toContain("engine LIKE");
    expect(
      query.mock.calls.every(([options]) => options.clickhouse_settings?.log_queries === 0),
    ).toBe(true);
    expect(
      command.mock.calls.every(([options]) => options.clickhouse_settings?.log_queries === 0),
    ).toBe(true);
    expect(command.mock.calls.map(([options]) => options.query).join("\n")).toContain(
      "ALTER TABLE `analytics`.`daily_sleep`",
    );
    expect(command.mock.calls[0]?.[0]).toEqual({
      query: expect.stringContaining("INSERT INTO ingest.account_erasure_fence"),
      query_params: {
        user_hash: createHash("sha256").update(userId).digest("hex"),
      },
      clickhouse_settings: { log_queries: 0 },
    });
    expect(insert).toHaveBeenCalledWith({
      table: "ingest.account_erasure_operation_fence",
      values: [
        {
          operation_hash: createHash("sha256").update(operationId).digest("hex"),
        },
      ],
      format: "JSONEachRow",
      clickhouse_settings: { log_queries: 0 },
    });
  });

  it("accepts a custom managed database only through explicit configuration", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = successfulQuery();

    await eraseClickHouseAccount(
      { command, insert, query },
      {
        activityIds: [],
        operationIds: [],
        sleepSessionIds: [],
        userId,
      },
      { managedDatabases: ["account_erasure_test"] },
    );

    const discoveryCall = query.mock.calls.find(([options]) =>
      options.query.includes("FROM system.tables"),
    );
    expect(discoveryCall?.[0].query_params).toEqual({
      managed_databases: ["account_erasure_test"],
    });
  });

  it("fails closed when a new ownership identifier is not mapped", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = vi.fn(async (options: QueryOptions) => {
      if (options.query.includes("FROM system.tables")) {
        return {
          json: async () => [
            {
              age_milliseconds: 1_000_000,
              columns: [
                ["account_id", "UUID"],
                ["email", "String"],
              ],
              database: "analytics",
              engine: "MergeTree",
              name: "new_personal_rows",
            },
          ],
        };
      }
      return { json: async () => [{ count: "0" }] };
    });

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [],
          userId,
        },
      ),
    ).rejects.toThrow("account_id");
    expect(command.mock.calls.some(([options]) => options.query.includes("ALTER TABLE"))).toBe(
      false,
    );
  });

  it("fails closed on an unsupported physical storage engine before deleting rows", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([
      {
        age_milliseconds: 1_000_000,
        columns: [["user_id", "UUID"]],
        database: "analytics",
        engine: "Memory",
        name: "ephemeral_personal_rows",
      },
    ]);

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [],
          userId,
        },
      ),
    ).rejects.toThrow(
      "Unsupported ClickHouse physical storage engine for analytics.ephemeral_personal_rows: Memory",
    );
    expect(command.mock.calls.some(([options]) => options.query.includes("ALTER TABLE"))).toBe(
      false,
    );
  });

  it("explicitly skips known non-storage engines during physical table discovery", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([
      {
        age_milliseconds: 1_000_000,
        columns: [
          ["account_id", "UUID"],
          ["email", "String"],
        ],
        database: "analytics",
        engine: "View",
        name: "personal_view",
      },
      {
        age_milliseconds: 1_000_000,
        columns: [["user_id", "UUID"]],
        database: "analytics",
        engine: "MaterializedView",
        name: "personal_materialized_view",
      },
      {
        age_milliseconds: 1_000_000,
        columns: [["user_id", "UUID"]],
        database: "analytics",
        engine: "Null",
        name: "discarded_personal_rows",
      },
      {
        age_milliseconds: 1_000_000,
        columns: [["user_id", "UUID"]],
        database: "analytics",
        engine: "ReplacingMergeTree",
        name: "daily_sleep",
      },
    ]);

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [],
          userId,
        },
      ),
    ).resolves.toBeUndefined();

    const mutations = command.mock.calls
      .map(([options]) => options.query)
      .filter((queryText) => queryText.includes("ALTER TABLE"));
    expect(mutations.join("\n")).toContain("`analytics`.`daily_sleep`");
    expect(mutations.join("\n")).not.toContain("personal_view");
    expect(mutations.join("\n")).not.toContain("personal_materialized_view");
    expect(mutations.join("\n")).not.toContain("discarded_personal_rows");
  });

  it("fails closed when a dbt staging marker does not have an invocation UUID", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = vi.fn(async (options: QueryOptions) => {
      if (options.query.includes("FROM system.tables")) {
        return {
          json: async () => [
            {
              age_milliseconds: 1_000_000,
              columns: [["user_id", "UUID"]],
              database: "analytics",
              engine: "MergeTree",
              name: "daily_sleep__dbt_new_data_not_an_invocation_uuid",
            },
          ],
        };
      }
      return { json: async () => [{ count: "0" }] };
    });

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        {
          activityIds: [],
          operationIds: [],
          sleepSessionIds: [],
          userId,
        },
      ),
    ).rejects.toThrow("dbt staging table name");
    expect(command.mock.calls.some(([options]) => options.query.includes("ALTER TABLE"))).toBe(
      false,
    );
  });
});
