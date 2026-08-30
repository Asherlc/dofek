import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../db/clickhouse.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import { eraseClickHouseAccount, fenceClickHouseAccount } from "./clickhouse-erasure.ts";

const userId = "10000000-0000-4000-8000-000000001994";
const operationId = "20000000-0000-4000-8000-000000001994";
type ColumnDefinition = readonly [string, string];

const schemaDriftCases = [
  ["user_id", [["user_id", "String"]], "user_id has type String"],
  ["activity_id", [["activity_id", "String"]], "activity_id has type String"],
  [
    "member_activity_ids",
    [["member_activity_ids", "Array(String)"]],
    "member_activity_ids has type Array(String)",
  ],
  ["group_id", [["group_id", "Array(UUID)"]], "group_id has type Array(UUID)"],
  ["unmapped ownership", [["owner_id", "UUID"]], "owner_id is not mapped"],
  ["strong personal data", [["email", "String"]], "without an ownership relation"],
  [
    "strong personal data mixed with harmless columns",
    [
      ["email", "String"],
      ["id", "String"],
    ],
    "without an ownership relation",
  ],
] satisfies readonly (readonly [string, readonly ColumnDefinition[], string])[];

const stagingSchemaDriftCases = [
  [
    "staging has an extra ownership column",
    [
      ["user_id", "UUID"],
      ["activity_id", "UUID"],
    ],
    [["user_id", "UUID"]],
  ],
  [
    "canonical has an extra ownership column",
    [["user_id", "UUID"]],
    [
      ["user_id", "UUID"],
      ["activity_id", "UUID"],
    ],
  ],
] satisfies readonly (readonly [
  string,
  readonly ColumnDefinition[],
  readonly ColumnDefinition[],
])[];

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

    const captureQueryFor = (tableName: string) =>
      query.mock.calls.find(([options]) =>
        options.query.includes(`FROM \`analytics\`.\`${tableName}\``),
      )?.[0];
    const activityCapture = captureQueryFor("activity");
    expect(activityCapture?.query).toContain("ifNull(toString(id), '')");
    const sleepCapture = captureQueryFor("sleep_session");
    expect(sleepCapture?.query).toContain("id IN {sleep_ids:Array(UUID)}");
    const relationCapture = captureQueryFor("relation_rows");
    expect(relationCapture?.query).toContain("`activity_id` IN {activity_ids:Array(UUID)}");
    expect(relationCapture?.query).toContain("`operation_id` IN {operation_ids:Array(UUID)}");
    expect(relationCapture?.query).toContain("`group_id` IN {string_relation_ids:Array(String)}");
    expect(relationCapture?.query).toContain("`metric_stream_id` IN {record_ids:Array(UUID)}");
    expect(relationCapture?.query).toContain(
      "hasAny(`member_activity_ids`, {activity_ids:Array(UUID)})",
    );
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

  it("uses table identities when activity and sleep rows have no relation columns", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const activityId = "30000000-0000-4000-8000-000000001994";
    const sleepId = "50000000-0000-4000-8000-000000001994";
    const recordId = "40000000-0000-4000-8000-000000001994";
    const query = queryReturningTables(
      [
        managedTable("activity", [
          ["id", "UUID"],
          ["user_id", "Nullable(UUID)"],
        ]),
        managedTable("sleep_session", [
          ["id", "UUID"],
          ["user_id", "Nullable(UUID)"],
        ]),
        managedTable("record_rows", [
          ["id", "UUID"],
          ["user_id", "Nullable(UUID)"],
        ]),
      ],
      [
        {
          activity_ids: [activityId],
          operation_ids: [],
          record_ids: [recordId],
          sleep_ids: [sleepId],
          string_relation_ids: [],
        },
      ],
    );

    await eraseClickHouseAccount(
      { command, insert, query },
      {
        activityIds: [activityId],
        operationIds: [],
        sleepSessionIds: [sleepId],
        userId,
      },
    );

    const mutationFor = (tableName: string) =>
      command.mock.calls.find(([options]) =>
        options.query.includes(`ALTER TABLE \`analytics\`.\`${tableName}\``),
      )?.[0];
    expect(mutationFor("activity")?.query).toContain("activity_ids_hashes");
    expect(mutationFor("sleep_session")?.query).toContain("sleep_ids_hashes");
    expect(mutationFor("record_rows")?.query).toContain("record_ids_hashes");
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

  it.each(schemaDriftCases)(
    "rejects schema drift in %s before deleting rows",
    async (_label, columns, message) => {
      const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
      const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
      const query = queryReturningTables([managedTable("schema_drift", columns)]);

      await expect(
        eraseClickHouseAccount(
          { command, insert, query },
          { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
        ),
      ).rejects.toThrow(message);
      expect(command.mock.calls.some(([options]) => options.query.includes("ALTER TABLE"))).toBe(
        false,
      );
    },
  );

  it.each([ACCOUNT_ERASURE_FENCE_TABLE, ACCOUNT_ERASURE_OPERATION_FENCE_TABLE])(
    "does not validate the protected %s table as application data",
    async (tableKey) => {
      const [database, name] = tableKey.split(".");
      const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
      const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
      const query = queryReturningTables([
        {
          age_milliseconds: 1_000_000,
          columns: [["user_id", "String"]],
          database,
          engine: "ReplacingMergeTree",
          name,
        },
      ]);

      await expect(
        eraseClickHouseAccount(
          { command, insert, query },
          { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each([ACCOUNT_ERASURE_FENCE_TABLE, ACCOUNT_ERASURE_OPERATION_FENCE_TABLE])(
    "does not erase protected %s rows even when they look personal",
    async (tableKey) => {
      const [database, name] = tableKey.split(".");
      const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
      const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
      const query = queryReturningTables([
        {
          age_milliseconds: 1_000_000,
          columns: [["user_id", "UUID"]],
          database,
          engine: "ReplacingMergeTree",
          name,
        },
      ]);

      await eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      );

      expect(command.mock.calls.some(([options]) => options.query.includes("ALTER TABLE"))).toBe(
        false,
      );
    },
  );

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

  it("does not erase an unowned record table", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const recordId = "40000000-0000-4000-8000-000000001994";
    const query = queryReturningTables(
      [
        managedTable("record_owner", [["user_id", "UUID"]]),
        managedTable("unowned_record_rows", [["id", "UUID"]]),
      ],
      [
        {
          activity_ids: [],
          operation_ids: [],
          record_ids: [recordId],
          sleep_ids: [],
          string_relation_ids: [],
        },
      ],
    );

    await eraseClickHouseAccount(
      { command, insert, query },
      { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
    );

    const mutations = command.mock.calls
      .map(([options]) => options.query)
      .filter((queryText) => queryText.includes("ALTER TABLE"))
      .join("\n");
    expect(mutations).toContain("`analytics`.`record_owner`");
    expect(mutations).not.toContain("unowned_record_rows");
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

  it("fails closed when a dbt staging marker appears at the start of a table name", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([
      managedTable("__dbt_new_data_60000000_0000_4000_8000_000000001994", [["user_id", "UUID"]]),
    ]);

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("dbt staging table name");
  });

  it("requires a UUID id before treating a user profile table as personal data", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([
      managedTable("user_profile", [
        ["id", "String"],
        ["email", "String"],
      ]),
    ]);

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("without an ownership relation");
  });

  it("fails closed for an orphaned or mismatched dbt staging table", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const stagingName = "daily_sleep__dbt_new_data_60000000_0000_4000_8000_000000001994";
    const query = queryReturningTables([managedTable(stagingName, [["user_id", "UUID"]])]);

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("without a canonical match");

    const mismatchQuery = queryReturningTables([
      managedTable("daily_sleep", [["user_id", "UUID"]]),
      managedTable(stagingName, [["user_id", "Nullable(UUID)"]]),
    ]);
    await expect(
      eraseClickHouseAccount(
        { command, insert, query: mismatchQuery },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("schema mismatch");
  });

  it("rejects a young dbt staging table even when no active query is running", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const stagingName = "daily_sleep__dbt_new_data_60000000_0000_4000_8000_000000001994";
    const query = vi.fn(async (options: QueryOptions) => {
      if (options.query.includes("FROM system.tables")) {
        return {
          json: async () => [
            managedTable("daily_sleep", [["user_id", "UUID"]]),
            { ...managedTable(stagingName, [["user_id", "UUID"]]), age_milliseconds: 1_000 },
          ],
        };
      }
      if (options.query.includes("FROM system.processes"))
        return { json: async () => [{ count: "0" }] };
      return { json: async () => [{ count: "0" }] };
    });

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("active dbt staging table");
  });

  it.each(stagingSchemaDriftCases)(
    "rejects dbt ownership schema drift when %s",
    async (_label, stagingColumns, canonicalColumns) => {
      const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
      const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
      const stagingName = "daily_sleep__dbt_new_data_60000000_0000_4000_8000_000000001994";
      const query = queryReturningTables([
        managedTable("daily_sleep", canonicalColumns),
        managedTable(stagingName, stagingColumns),
      ]);

      await expect(
        eraseClickHouseAccount(
          { command, insert, query },
          { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
        ),
      ).rejects.toThrow("schema mismatch");
    },
  );

  it("rejects active and malformed ownership schemas before mutation", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const stagingName = "daily_sleep__dbt_new_data_60000000_0000_4000_8000_000000001994";
    const activeQuery = vi.fn(async (options: QueryOptions) => {
      if (options.query.includes("FROM system.tables")) {
        return {
          json: async () => [
            managedTable("daily_sleep", [["user_id", "UUID"]]),
            managedTable(stagingName, [["user_id", "UUID"]]),
          ],
        };
      }
      if (options.query.includes("FROM system.processes")) {
        return { json: async () => [{ count: "1" }] };
      }
      return { json: async () => [{ count: "0" }] };
    });
    await expect(
      eraseClickHouseAccount(
        { command, insert, query: activeQuery },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("active dbt staging table");

    const activeTableQuery = activeQuery.mock.calls.find(([options]) =>
      options.query.includes("FROM system.processes"),
    );
    expect(activeTableQuery?.[0].query_params).toEqual({
      plain_name: `analytics.${stagingName}`,
      quoted_name: `\`analytics\`.\`${stagingName}\``,
    });
    expect(activeTableQuery?.[0].clickhouse_settings).toEqual({ log_queries: 0 });

    const badRelationQuery = queryReturningTables([
      managedTable("bad_relation", [["activity_id", "String"]]),
    ]);
    await expect(
      eraseClickHouseAccount(
        { command, insert, query: badRelationQuery },
        {
          activityIds: ["30000000-0000-4000-8000-000000001994"],
          operationIds: [],
          sleepSessionIds: [],
          userId,
        },
      ),
    ).rejects.toThrow("has type String");
  });

  it("does not treat a near-match cutover table as safe", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([
      {
        age_milliseconds: 1_000_000,
        columns: [["cutover_at", "DateTime"]],
        database: "analytics",
        engine: "TinyLog",
        name: "sleep_heart_rate_cutover",
      },
    ]);

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("Unsupported ClickHouse physical storage engine");
  });

  it.each([
    ["wrong database", { database: "ingest" }],
    ["wrong name", { name: "other_cutover" }],
    ["wrong engine", { engine: "Memory" }],
    [
      "extra column",
      {
        columns: [
          ["cutover_at", "DateTime64(9, 'UTC')"],
          ["id", "String"],
        ],
      },
    ],
    ["wrong column name", { columns: [["not_cutover_at", "DateTime64(9, 'UTC')"]] }],
    ["wrong column type", { columns: [["cutover_at", "DateTime"]] }],
    ["missing columns", { columns: [] }],
  ] as const)("requires every cutover-table identity field: %s", async (_label, overrides) => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([
      {
        ...managedTable("sleep_heart_rate_cutover", [["cutover_at", "DateTime64(9, 'UTC')"]]),
        engine: "TinyLog",
        ...overrides,
      },
    ]);

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("Unsupported ClickHouse physical storage engine");
  });

  it("fences an operation directly and requires insert support", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);

    await expect(
      fenceClickHouseAccount({ command, query: queryReturningTables([]) }, userId, [operationId]),
    ).rejects.toThrow("requires insert support");
    expect(command).toHaveBeenCalledOnce();
  });

  it("fences newly discovered operations and fails when fence insertion is unavailable", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const discoveredOperationId = "60000000-0000-4000-8000-000000001994";
    const query = queryReturningTables(
      [managedTable("daily_sleep", [["user_id", "UUID"]])],
      [
        {
          activity_ids: [],
          operation_ids: [discoveredOperationId],
          record_ids: [],
          sleep_ids: [],
          string_relation_ids: [],
        },
      ],
    );

    await eraseClickHouseAccount(
      { command, insert, query },
      { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [
          { operation_hash: createHash("sha256").update(discoveredOperationId).digest("hex") },
        ],
      }),
    );

    await expect(
      eraseClickHouseAccount(
        { command: vi.fn(async () => undefined), query },
        { activityIds: [], operationIds: [operationId], sleepSessionIds: [], userId },
      ),
    ).rejects.toThrow("requires insert support");
  });

  it("fails when identifier expansion does not converge within its configured bound", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables(
      [managedTable("daily_sleep", [["user_id", "UUID"]])],
      [
        {
          activity_ids: ["30000000-0000-4000-8000-000000001994"],
          operation_ids: [],
          record_ids: [],
          sleep_ids: [],
          string_relation_ids: [],
        },
      ],
    );

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
        { identifierExpansionMaximumPasses: 1 },
      ),
    ).rejects.toThrow("identifier expansion did not converge");
  });

  it("captures empty relation families without creating a physical target", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([managedTable("activity_only", [["activity_id", "UUID"]])]);

    await expect(
      eraseClickHouseAccount(
        { command, insert, query },
        { activityIds: [], operationIds: [], sleepSessionIds: [], userId },
      ),
    ).resolves.toBeUndefined();
    expect(command.mock.calls.some(([options]) => options.query.includes("ALTER TABLE"))).toBe(
      false,
    );
  });

  it("retains nullable user rows related through scalar and array identifiers", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    const query = queryReturningTables([
      managedTable("relation_rows", [
        ["user_id", "Nullable(UUID)"],
        ["activity_id", "UUID"],
        ["member_activity_ids", "Array(Nullable(UUID))"],
      ]),
    ]);

    await eraseClickHouseAccount(
      { command, insert, query },
      {
        activityIds: ["30000000-0000-4000-8000-000000001994"],
        operationIds: [],
        sleepSessionIds: [],
        userId,
      },
    );

    const mutation = command.mock.calls.find(([options]) => options.query.includes("ALTER TABLE"));
    expect(mutation?.[0].query).toContain("user_id IS NULL");
    expect(mutation?.[0].query).toContain("arrayMap(identifier_value");
    expect(mutation?.[0].query_params).toEqual(
      expect.objectContaining({
        activity_ids_hashes: expect.any(Array),
        user_hash: expect.any(String),
      }),
    );
  });
});
