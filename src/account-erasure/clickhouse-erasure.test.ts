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

interface CapturedIdentifiers {
  activity_ids: string[];
  operation_ids: string[];
  record_ids: string[];
  sleep_ids: string[];
  string_relation_ids: string[];
}

function emptyCapturedIdentifiers(): CapturedIdentifiers[] {
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

function queryReturningTables(
  tables: readonly Record<string, unknown>[],
  capturedIdentifiers = emptyCapturedIdentifiers(),
) {
  return vi.fn(async (options: QueryOptions) => {
    if (options.query.includes("FROM system.tables")) {
      return { json: async () => tables };
    }
    if (options.query.includes(" AS activity_ids")) {
      return { json: async () => capturedIdentifiers };
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

function managedTable(
  name: string,
  columns: readonly (readonly [string, string])[],
  database = "analytics",
) {
  return {
    age_milliseconds: 1_000_000,
    columns,
    database,
    engine: "ReplacingMergeTree",
    name,
  };
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
    const mutationCall = command.mock.calls.find(([options]) =>
      options.query.includes("ALTER TABLE `analytics`.`daily_sleep`"),
    );
    expect(mutationCall?.[0].query).toContain("SHA256(toString(user_id))");
    expect(mutationCall?.[0].query).not.toContain(userId);
    expect(mutationCall?.[0].query_params).toEqual({
      user_hash: createHash("sha256").update(userId).digest("hex"),
    });
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

  it("handles every supported ownership relation and verified staging schema", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const activityId = "30000000-0000-4000-8000-000000001994";
    const recordId = "40000000-0000-4000-8000-000000001994";
    const sleepId = "50000000-0000-4000-8000-000000001994";
    const capturedIdentifiers = [
      {
        activity_ids: [activityId],
        operation_ids: [operationId],
        record_ids: [recordId],
        sleep_ids: [sleepId],
        string_relation_ids: ["group-1994"],
      },
    ];
    const query = queryReturningTables(
      [
        managedTable("activity", [
          ["id", "UUID"],
          ["user_id", "UUID"],
          ["activity_id", "UUID"],
          ["operation_id", "UUID"],
          ["member_activity_ids", "Array(UUID)"],
          ["group_id", "String"],
          ["email", "String"],
        ]),
        managedTable("sleep_session", [
          ["id", "UUID"],
          ["user_id", "Nullable(UUID)"],
          ["sleep_session_id", "UUID"],
        ]),
        managedTable("user_profile", [
          ["id", "UUID"],
          ["email", "String"],
        ]),
        managedTable("daily_sleep", [
          ["id", "UUID"],
          ["user_id", "UUID"],
          ["source_metric_stream_id", "UUID"],
          ["metadata", "String"],
        ]),
        managedTable("relation_rows", [
          ["activity_id", "UUID"],
          ["operation_id", "UUID"],
          ["member_activity_ids", "Array(UUID)"],
          ["group_id", "String"],
          ["metric_stream_id", "Nullable(UUID)"],
        ]),
        managedTable("group_rows", [["group_id", "String"]]),
        managedTable("user_profile__dbt_new_data_60000000_0000_4000_8000_000000001994", [
          ["id", "UUID"],
          ["email", "String"],
        ]),
        managedTable(
          "user_profile",
          [
            ["id", "UUID"],
            ["email", "String"],
          ],
          "postgres_fitness",
        ),
        {
          age_milliseconds: 1_000_000,
          columns: [
            ["user_hash", "FixedString(64)"],
            ["erased_at", "DateTime64(9)"],
          ],
          database: "ingest",
          engine: "ReplacingMergeTree",
          name: "account_erasure_fence",
        },
        {
          age_milliseconds: 1_000_000,
          columns: [
            ["operation_hash", "FixedString(64)"],
            ["erased_at", "DateTime64(9)"],
          ],
          database: "ingest",
          engine: "ReplacingMergeTree",
          name: "account_erasure_operation_fence",
        },
      ],
      capturedIdentifiers,
    );

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        {
          activityIds: [activityId],
          operationIds: [operationId],
          sleepSessionIds: [sleepId],
          userId,
        },
      ),
    ).resolves.toBeUndefined();

    const mutations = command.mock.calls
      .map(([options]) => options.query)
      .filter((queryText) => queryText.includes("ALTER TABLE"));
    expect(mutations).toHaveLength(8);
    expect(mutations.join("\n")).toContain(
      "identifier_value -> lower(hex(SHA256(toString(identifier_value)))",
    );
    expect(mutations.join("\n")).toContain("SHA256(toString(`group_id`))");
    expect(mutations.join("\n")).toContain("SHA256(toString(id))");
    expect(mutations.join("\n")).not.toContain(userId);
    expect(mutations.join("\n")).not.toContain(operationId);
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

  it("skips the schema-verified non-personal heart-rate cutover TinyLog table", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([
      {
        age_milliseconds: 1_000_000,
        columns: [["cutover_at", "DateTime64(9, 'UTC')"]],
        database: "analytics",
        engine: "TinyLog",
        name: "sleep_heart_rate_cutover",
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
      .filter((queryText) => queryText.includes("ALTER TABLE"))
      .join("\n");
    expect(mutations).toContain("`analytics`.`daily_sleep`");
    expect(mutations).not.toContain("sleep_heart_rate_cutover");
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
