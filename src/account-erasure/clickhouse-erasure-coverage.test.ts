import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  ACCOUNT_ERASURE_OPERATION_FENCE_TABLE,
} from "../metric-stream/clickhouse-table.ts";
import type { PhysicalTable } from "./clickhouse-erasure-coverage.ts";

let coverage: typeof import("./clickhouse-erasure-coverage.ts");
beforeEach(async () => {
  vi.resetModules();
  coverage = await import("./clickhouse-erasure-coverage.ts");
});

type ColumnDefinition = readonly [string, string];

const peerDbColumnDefinitions = [
  ["_peerdb_synced_at", "DateTime64(9)"],
  ["_peerdb_is_deleted", "Int8"],
  ["_peerdb_version", "Int64"],
] as const satisfies readonly ColumnDefinition[];

const schemaDriftCases = [
  ["user_id", [["user_id", "String"]], "user_id has type String"],
  ["activity_id", [["activity_id", "String"]], "activity_id has type String"],
  [
    "member_activity_ids",
    [["member_activity_ids", "Array(String)"]],
    "member_activity_ids has type Array(String)",
  ],
  ["group_id", [["group_id", "Array(UUID)"]], "group_id has type Array(UUID)"],
  ["string group array", [["group_id", "Array(String)"]], "group_id has type Array(String)"],
  ["numeric group", [["group_id", "UInt64"]], "group_id has type UInt64"],
  [
    "source activity string",
    [["source_activity_id", "String"]],
    "source_activity_id has type String",
  ],
  [
    "source activity array",
    [["source_activity_id", "Array(UUID)"]],
    "source_activity_id has type Array(UUID)",
  ],
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
    "staging omits record identity",
    [["user_id", "UUID"]],
    [
      ["user_id", "UUID"],
      ["id", "UUID"],
    ],
  ],
  [
    "canonical omits record identity",
    [
      ["user_id", "UUID"],
      ["id", "UUID"],
    ],
    [["user_id", "UUID"]],
  ],
  [
    "staging changes record identity type",
    [
      ["user_id", "UUID"],
      ["id", "String"],
    ],
    [
      ["user_id", "UUID"],
      ["id", "UUID"],
    ],
  ],
  [
    "staging omits measurement reference",
    [["user_id", "UUID"]],
    [
      ["user_id", "UUID"],
      ["measurement_id", "UUID"],
    ],
  ],
  [
    "canonical omits measurement reference",
    [
      ["user_id", "UUID"],
      ["measurement_id", "UUID"],
    ],
    [["user_id", "UUID"]],
  ],
  [
    "staging changes nullable measurement reference",
    [
      ["user_id", "UUID"],
      ["measurement_id", "UUID"],
    ],
    [
      ["user_id", "UUID"],
      ["measurement_id", "Nullable(UUID)"],
    ],
  ],
  ["group ownership family changes", [["group_id", "UUID"]], [["group_id", "String"]]],
  [
    "staging omits source activity",
    [["user_id", "UUID"]],
    [
      ["user_id", "UUID"],
      ["source_activity_id", "Nullable(UUID)"],
    ],
  ],
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

function client(tables: readonly object[], budget?: { tables: number; bytes: number }) {
  let calls = 0;
  return {
    query: async () => ({
      json: async () =>
        ++calls === 1 ? [budget ?? { tables: tables.length, bytes: 1024 }] : tables,
    }),
  };
}

function physicalTable(
  database: string,
  name: string,
  columns: readonly ColumnDefinition[],
  options: Partial<Pick<PhysicalTable, "uuid" | "engine">> = {},
): PhysicalTable {
  return {
    database,
    name,
    uuid: options.uuid ?? randomUUID(),
    age_milliseconds: 1_000_000,
    engine: options.engine ?? "MergeTree",
    columns: columns.map((column): [string, string] => [column[0], column[1]]),
  };
}

function table(name: string, columns: readonly ColumnDefinition[]) {
  return physicalTable("analytics", name, columns);
}

function splitQualifiedTable(qualified: string): { database: string; name: string } {
  const [database, name] = qualified.split(".");
  if (!database || !name) {
    throw new Error(`Expected qualified table database.name, received ${qualified}`);
  }
  return { database, name };
}

function sharedSystemTable(qualified: string, columns: readonly ColumnDefinition[]) {
  const { database, name } = splitQualifiedTable(qualified);
  return physicalTable(database, name, columns);
}

function dbtStagingName(canonicalName: string): string {
  return `${canonicalName}__dbt_new_data_${randomUUID().replaceAll("-", "_")}`;
}

const providerPriorityColumns = [
  ["provider_id", "String"],
  ["priority", "Int32"],
  ["sleep_priority", "Nullable(Int32)"],
  ["body_priority", "Nullable(Int32)"],
  ["recovery_priority", "Nullable(Int32)"],
  ["daily_activity_priority", "Nullable(Int32)"],
  ...peerDbColumnDefinitions,
] as const satisfies readonly ColumnDefinition[];

describe("ClickHouse erasure exported helpers", () => {
  it("formats qualified table names with backticks", () => {
    expect(coverage.qualifiedTable("analytics", "daily_recovery")).toBe(
      "`analytics`.`daily_recovery`",
    );
  });

  it("exposes production managed databases", () => {
    expect(coverage.PRODUCTION_MANAGED_DATABASES).toEqual([
      "analytics",
      "ingest",
      "postgres_fitness",
    ]);
  });

  it("parses identifier names for managed database options", () => {
    expect(coverage.identifierNameSchema.parse("postgres_fitness")).toBe("postgres_fitness");
    expect(coverage.identifierNameSchema.parse("a1_b2")).toBe("a1_b2");
    expect(coverage.identifierNameSchema.parse("a")).toBe("a");
    expect(() => coverage.identifierNameSchema.parse("bad-name")).toThrow();
    expect(() => coverage.identifierNameSchema.parse("1starts_with_number")).toThrow();
    expect(() => coverage.identifierNameSchema.parse("")).toThrow();
    expect(() => coverage.identifierNameSchema.parse("has.period")).toThrow();
    expect(() => coverage.identifierNameSchema.parse("valid_name!")).toThrow();
    expect(() => coverage.identifierNameSchema.parse("space inside")).toThrow();
    expect(() => coverage.identifierNameSchema.parse("123")).toThrow();
    expect(() => coverage.identifierNameSchema.parse("9abc")).toThrow();
  });

  it("derives canonical base table names from dbt staging suffixes", () => {
    const invocation = randomUUID().replaceAll("-", "_");
    const staging = physicalTable("analytics", `rows__dbt_new_data_${invocation}`, [
      ["user_id", "UUID"],
    ]);
    expect(coverage.baseTableName(staging)).toBe("rows");
    expect(coverage.baseTableName(table("plain_name", [["user_id", "UUID"]]))).toBe("plain_name");
    expect(
      coverage.baseTableName(
        physicalTable("analytics", `__dbt_new_data_${invocation}`, [["user_id", "UUID"]]),
      ),
    ).toBe(`__dbt_new_data_${invocation}`);
  });

  it("maps column metadata and UUID scalar detection", () => {
    const profile = physicalTable("postgres_fitness", "user_profile", [
      ["id", "UUID"],
      ["user_id", "Nullable(UUID)"],
    ]);
    const types = coverage.columnTypes(profile);
    expect(types.get("id")).toBe("UUID");
    expect(coverage.hasUuidScalarColumn(profile, "id")).toBe(true);
    expect(coverage.hasUuidScalarColumn(profile, "user_id")).toBe(true);
    expect(coverage.hasUuidScalarColumn(profile, "missing")).toBe(false);
    expect(coverage.isUserProfileTable(profile)).toBe(true);
    expect(coverage.isUserProfileTable(table("activity", [["user_id", "UUID"]]))).toBe(false);
  });

  it("sorts table metadata lexicographically inside digests", () => {
    const alpha = physicalTable("analytics", "aaa_table", [["user_id", "UUID"]], {
      uuid: "00000000-0000-0000-0000-000000000001",
    });
    const beta = physicalTable("analytics", "zzz_table", [["user_id", "UUID"]], {
      uuid: "00000000-0000-0000-0000-000000000002",
    });
    expect(coverage.clickHouseErasureSchemaDigest([alpha, beta])).toBe(
      coverage.clickHouseErasureSchemaDigest([beta, alpha]),
    );
  });

  it("uses strict lexicographic ordering for duplicate column names in digests", () => {
    const tableUuid = "00000000-0000-0000-0000-000000000011";
    const duplicateColumns = physicalTable(
      "analytics",
      "duplicate_column_names",
      [
        ["same_name", "UUID"],
        ["same_name", "String"],
      ],
      { uuid: tableUuid },
    );
    expect(coverage.clickHouseErasureSchemaDigest([duplicateColumns])).toBe(
      "73da7fa1dd792cfe686cb8d0a67f45fa23191cefd52889bbfb32eae18c9b7505",
    );
  });

  it("sorts column metadata lexicographically inside digests", () => {
    const tableUuid = "00000000-0000-0000-0000-000000000003";
    const zThenA = physicalTable(
      "analytics",
      "digest_order",
      [
        ["z_column", "UUID"],
        ["a_column", "UUID"],
      ],
      { uuid: tableUuid },
    );
    const aThenZ = physicalTable(
      "analytics",
      "digest_order",
      [
        ["a_column", "UUID"],
        ["z_column", "UUID"],
      ],
      { uuid: tableUuid },
    );
    expect(coverage.clickHouseErasureSchemaDigest([zThenA])).toBe(
      coverage.clickHouseErasureSchemaDigest([aThenZ]),
    );
  });

  it("hashes physical schemas deterministically", () => {
    const tableUuid = randomUUID();
    const left = physicalTable(
      "analytics",
      "rows",
      [
        ["user_id", "UUID"],
        ["activity_id", "UUID"],
      ],
      { uuid: tableUuid },
    );
    const right = physicalTable(
      "analytics",
      "rows",
      [
        ["activity_id", "UUID"],
        ["user_id", "UUID"],
      ],
      { uuid: tableUuid },
    );
    const sibling = physicalTable("analytics", "other_rows", [["user_id", "UUID"]]);
    expect(coverage.clickHouseErasureSchemaDigest([left])).toHaveLength(64);
    expect(coverage.clickHouseErasureSchemaDigest([left])).toBe(
      coverage.clickHouseErasureSchemaDigest([right]),
    );
    expect(coverage.clickHouseErasureSchemaDigest([left, sibling])).toBe(
      coverage.clickHouseErasureSchemaDigest([sibling, left]),
    );
    expect(coverage.clickHouseErasureSchemaDigest([left, sibling])).not.toBe(
      coverage.clickHouseErasureSchemaDigest([left]),
    );
  });
});

describe("ClickHouse erasure identifier column families", () => {
  it("maps representative identifier columns to their families", () => {
    const rows = physicalTable("analytics", "activity_summary", [
      ["user_id", "UUID"],
      ["activity_id", "UUID"],
      ["member_activity_ids", "Array(UUID)"],
      ["group_id", "UUID"],
      ["sleep_id", "UUID"],
      ["operation_id", "UUID"],
    ]);
    expect(coverage.identifierColumns(rows)).toEqual([
      ["activity_id", { cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
      ["member_activity_ids", { cardinality: "array", family: "activityIds", valueType: "uuid" }],
      ["group_id", { cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
      ["sleep_id", { cardinality: "scalar", family: "sleepIds", valueType: "uuid" }],
      ["operation_id", { cardinality: "scalar", family: "operationIds", valueType: "uuid" }],
    ]);
  });

  it("selects the string relation family for string group identifiers", () => {
    const rows = physicalTable("analytics", "activity_groups", [
      ["user_id", "UUID"],
      ["group_id", "String"],
    ]);
    expect(coverage.identifierColumns(rows)).toEqual([
      ["group_id", { cardinality: "scalar", family: "stringRelationIds", valueType: "string" }],
    ]);
  });
});

describe("ClickHouse erasure ownership coverage", () => {
  it.each(["source_owner_record_id", "source_owner_r_id"])(
    "rejects an unmapped compound ownership column %s even with a direct owner",
    async (columnName) => {
      await expect(
        coverage.inspectClickHouseAccountErasureCoverage(
          client([
            table("personal_rows", [
              ["user_id", "UUID"],
              [columnName, "String"],
            ]),
          ]),
        ),
      ).rejects.toThrow(`${columnName} is not mapped`);
    },
  );

  it("does not impose the PostgreSQL provider contract on analytics provider rows", async () => {
    const rows = table("provider", [
      ["user_id", "UUID"],
      ["value", "String"],
    ]);
    await expect(coverage.inspectClickHouseAccountErasureCoverage(client([rows]))).resolves.toEqual(
      [rows],
    );
  });

  it("accepts nullable record references with a direct UUID owner", async () => {
    const rows = table("measurements", [
      ["user_id", "UUID"],
      ["measurement_id", "Nullable(UUID)"],
    ]);
    await expect(coverage.inspectClickHouseAccountErasureCoverage(client([rows]))).resolves.toEqual(
      [rows],
    );
  });

  it("allows staging payload changes when ownership columns match", async () => {
    const canonical = table("activity_rows", [
      ["user_id", "UUID"],
      ["value", "String"],
    ]);
    const staging = table(`activity_rows__dbt_new_data_${randomUUID().replaceAll("-", "_")}`, [
      ["user_id", "UUID"],
      ["value", "UInt32"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([canonical, staging])),
    ).resolves.toEqual([canonical, staging]);
  });

  it("classifies deletion acknowledgements as structural metadata", async () => {
    const canonical = {
      ...table("metric_stream_delete_acknowledgement", [
        ["event_id", "UUID"],
        ["applied_at", "DateTime64(9)"],
      ]),
      database: "ingest",
    };
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([canonical])),
    ).resolves.toEqual([]);
  });

  it("rejects deletion acknowledgements outside the ingest database", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          table("metric_stream_delete_acknowledgement", [
            ["event_id", "UUID"],
            ["applied_at", "DateTime64(9)"],
          ]),
        ]),
      ),
    ).rejects.toThrow("Unclassified ClickHouse physical ownership domain");
  });

  it("rejects a target without a physical UUID binding", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          { ...table("rows", [["user_id", "UUID"]]), uuid: "00000000-0000-0000-0000-000000000000" },
        ]),
      ),
    ).rejects.toThrow("physical UUID");
  });

  it("returns personal tables with direct user ownership", async () => {
    const owned = table("rows", [["user_id", "UUID"]]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([owned])),
    ).resolves.toEqual([owned]);
  });

  it("returns ingest merge-tree tables as personal erasure targets", async () => {
    const metricStream = physicalTable("ingest", "metric_stream", [
      ["user_id", "UUID"],
      ["activity_id", "UUID"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([metricStream])),
    ).resolves.toEqual([metricStream]);
  });

  it.each(schemaDriftCases)("rejects unsupported ownership %s", async (_label, columns, error) => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([table("rows", columns)])),
    ).rejects.toThrow(error);
  });

  it.each(stagingSchemaDriftCases)(
    "rejects mismatched staging ownership: %s",
    async (_label, canonical, staging) => {
      await expect(
        coverage.inspectClickHouseAccountErasureCoverage(
          client([
            table("rows", canonical),
            table(`rows__dbt_new_data_${randomUUID().replaceAll("-", "_")}`, staging),
          ]),
        ),
      ).rejects.toThrow("staging schema mismatch");
    },
  );

  it("accepts matching dbt staging tables when canonical ownership columns align", async () => {
    const columns = [
      ["user_id", "UUID"],
      ["activity_id", "UUID"],
    ] as const satisfies readonly ColumnDefinition[];
    const canonical = table("rows", columns);
    const staging = table(dbtStagingName("rows"), columns);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([canonical, staging])),
    ).resolves.toEqual([canonical, staging]);
  });

  it("rejects staging tables when record-reference column types diverge", async () => {
    const columns = [
      ["user_id", "UUID"],
      ["metric_stream_id", "UUID"],
    ] as const satisfies readonly ColumnDefinition[];
    const canonical = table("metric_stream", columns);
    const staging = table(dbtStagingName("metric_stream"), [
      ["user_id", "UUID"],
      ["metric_stream_id", "Nullable(UUID)"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([canonical, staging])),
    ).rejects.toThrow("staging schema mismatch");
  });

  it("rejects staging tables when user_id nullability diverges from canonical", async () => {
    const canonical = table("rows", [["user_id", "UUID"]]);
    const staging = table(dbtStagingName("rows"), [["user_id", "Nullable(UUID)"]]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([canonical, staging])),
    ).rejects.toThrow("staging schema mismatch");
  });

  it("rejects staging tables when processing flow marker id types diverge", async () => {
    const canonical = physicalTable("postgres_fitness", "processing_flow_marker", [
      ["id", "UUID"],
      ["operation_id", "UUID"],
    ]);
    const staging = physicalTable("postgres_fitness", dbtStagingName("processing_flow_marker"), [
      ["id", "String"],
      ["operation_id", "UUID"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([canonical, staging])),
    ).rejects.toThrow("staging schema mismatch");
  });

  it("rejects staging tables when canonical id ownership columns are missing", async () => {
    const canonical = physicalTable("postgres_fitness", "processing_flow_marker", [
      ["id", "UUID"],
      ["operation_id", "UUID"],
    ]);
    const staging = physicalTable("postgres_fitness", dbtStagingName("processing_flow_marker"), [
      ["operation_id", "UUID"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([canonical, staging])),
    ).rejects.toThrow("staging schema mismatch");
  });

  it("rejects user profile staging tables when profile id types diverge", async () => {
    const canonical = physicalTable("postgres_fitness", "user_profile", [
      ["id", "UUID"],
      ["name", "String"],
    ]);
    const staging = physicalTable("postgres_fitness", dbtStagingName("user_profile"), [
      ["id", "String"],
      ["name", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([canonical, staging])),
    ).rejects.toThrow("staging schema mismatch");
  });

  it("rejects unsafe dbt staging table names without a canonical UUID suffix", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table("rows__dbt_new_data_not_a_valid_uuid", [["user_id", "UUID"]])]),
      ),
    ).rejects.toThrow("Unsafe ClickHouse dbt staging table name");
  });

  it("rejects orphan dbt staging tables without a canonical match", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table(dbtStagingName("missing_canonical"), [["user_id", "UUID"]])]),
      ),
    ).rejects.toThrow("orphan ClickHouse dbt staging table");
  });

  it("rejects catalog metadata that exceeds the managed-table budget", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table("rows", [["user_id", "UUID"]])], { tables: 501, bytes: 1024 }),
      ),
    ).rejects.toThrow("metadata budget");
  });

  it("rejects unsupported storage engines except known non-personal cutover tables", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable("analytics", "unknown_storage_engine", [["value", "String"]], {
            engine: "TinyLog",
          }),
        ]),
      ),
    ).rejects.toThrow("Unsupported ClickHouse physical storage engine");
  });
});

describe("ClickHouse erasure shared system contracts", () => {
  it("accepts analytics schema migrations with whitespace-normalized DateTime types", async () => {
    const migrations = sharedSystemTable("analytics.schema_migrations", [
      ["id", "String"],
      ["applied_at", "DateTime"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([migrations])),
    ).resolves.toEqual([]);
  });

  it("rejects drift in analytics schema migrations", async () => {
    const migrations = sharedSystemTable("analytics.schema_migrations", [
      ["id", "String"],
      ["applied_at", "DateTime64(9)"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([migrations])),
    ).rejects.toThrow("column contract");
  });

  it("accepts sleep heart rate cutover TinyLog tables as known non-personal metadata", async () => {
    const cutover = physicalTable(
      "analytics",
      "sleep_heart_rate_cutover",
      [["cutover_at", "DateTime64(9, 'UTC')"]],
      { engine: "TinyLog" },
    );
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([cutover])),
    ).resolves.toEqual([]);
  });

  it("rejects unknown TinyLog tables that are not the sleep heart rate cutover metadata table", async () => {
    const unknownTinyLog = physicalTable("analytics", "legacy_metadata", [["value", "String"]], {
      engine: "TinyLog",
    });
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([unknownTinyLog])),
    ).rejects.toThrow("Unsupported ClickHouse physical storage engine");
  });

  it("rejects analytics TinyLog tables that are not the sleep heart rate cutover metadata table", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable(
            "analytics",
            "legacy_engine_metadata",
            [["cutover_at", "DateTime64(9, 'UTC')"]],
            { engine: "TinyLog" },
          ),
        ]),
      ),
    ).rejects.toThrow("Unsupported ClickHouse physical storage engine");
  });

  it("rejects sleep heart rate cutover tables on unsupported non-TinyLog engines", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable(
            "analytics",
            "sleep_heart_rate_cutover",
            [["cutover_at", "DateTime64(9, 'UTC')"]],
            { engine: "Memory" },
          ),
        ]),
      ),
    ).rejects.toThrow("Unsupported ClickHouse physical storage engine");
  });

  it.each([
    [
      "wrong database",
      physicalTable(
        "ingest",
        "sleep_heart_rate_cutover",
        [["cutover_at", "DateTime64(9, 'UTC')"]],
        {
          engine: "TinyLog",
        },
      ),
      "Unsupported ClickHouse physical storage engine",
    ],
    [
      "wrong table name",
      physicalTable(
        "analytics",
        "sleep_heart_rate_cutover_backup",
        [["cutover_at", "DateTime64(9, 'UTC')"]],
        {
          engine: "TinyLog",
        },
      ),
      "Unsupported ClickHouse physical storage engine",
    ],
    [
      "wrong column name",
      physicalTable(
        "analytics",
        "sleep_heart_rate_cutover",
        [["cutover_at_at", "DateTime64(9, 'UTC')"]],
        { engine: "TinyLog" },
      ),
      "Unsupported ClickHouse physical storage engine",
    ],
    [
      "extra column",
      physicalTable(
        "analytics",
        "sleep_heart_rate_cutover",
        [
          ["cutover_at", "DateTime64(9, 'UTC')"],
          ["note", "String"],
        ],
        { engine: "TinyLog" },
      ),
      "Unsupported ClickHouse physical storage engine",
    ],
    [
      "wrong column type",
      physicalTable("analytics", "sleep_heart_rate_cutover", [["cutover_at", "DateTime"]], {
        engine: "TinyLog",
      }),
      "Unsupported ClickHouse physical storage engine",
    ],
  ] as const)(
    "rejects sleep heart rate cutover tables with %s",
    async (_label, cutover, message) => {
      await expect(
        coverage.inspectClickHouseAccountErasureCoverage(client([cutover])),
      ).rejects.toThrow(message);
    },
  );

  it("accepts analytics sleep heart rate cutover contracts with whitespace-normalized types", async () => {
    const cutover = sharedSystemTable("analytics.sleep_heart_rate_cutover", [
      ["cutover_at", "DateTime64(9,  \n'UTC')"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([cutover])),
    ).resolves.toEqual([]);
  });

  it("accepts postgres_fitness provider priority mirrors with peerdb metadata columns", async () => {
    const priority = sharedSystemTable(
      "postgres_fitness.provider_priority",
      providerPriorityColumns,
    );
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([priority])),
    ).resolves.toEqual([]);
  });

  it("normalizes whitespace when validating nullable provider priority columns", async () => {
    const priority = sharedSystemTable("postgres_fitness.provider_priority", [
      ["provider_id", "String"],
      ["priority", "Int32"],
      ["sleep_priority", "Nullable(  Int32  )"],
      ["body_priority", "Nullable(Int32)"],
      ["recovery_priority", "Nullable(Int32)"],
      ["daily_activity_priority", "Nullable(Int32)"],
      ["_peerdb_synced_at", "DateTime64(9)"],
      ["_peerdb_is_deleted", "Int8"],
      ["_peerdb_version", "Int64"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([priority])),
    ).resolves.toEqual([]);
  });

  it("accepts postgres_fitness provider field priority mirrors", async () => {
    const fieldPriority = sharedSystemTable("postgres_fitness.provider_field_priority", [
      ["provider_id", "String"],
      ["field_key", "String"],
      ["priority", "Int64"],
      ...peerDbColumnDefinitions,
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([fieldPriority])),
    ).resolves.toEqual([]);
  });

  it("accepts postgres_fitness device priority mirrors", async () => {
    const devicePriority = sharedSystemTable("postgres_fitness.device_priority", [
      ["provider_id", "String"],
      ["source_name_pattern", "String"],
      ["priority", "Nullable(Int32)"],
      ["sleep_priority", "Nullable(Int32)"],
      ["body_priority", "Nullable(Int32)"],
      ["recovery_priority", "Nullable(Int32)"],
      ["daily_activity_priority", "Nullable(Int32)"],
      ...peerDbColumnDefinitions,
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([devicePriority])),
    ).resolves.toEqual([]);
  });

  it("accepts postgres_fitness sensor provider and device priority mirrors", async () => {
    const sensorProviderPriority = sharedSystemTable("postgres_fitness.sensor_provider_priority", [
      ["provider_id", "String"],
      ["channel", "String"],
      ["priority", "Int32"],
      ...peerDbColumnDefinitions,
    ]);
    const sensorDevicePriority = sharedSystemTable("postgres_fitness.sensor_device_priority", [
      ["provider_id", "String"],
      ["source_name_pattern", "String"],
      ["channel", "String"],
      ["priority", "Int32"],
      ...peerDbColumnDefinitions,
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([sensorProviderPriority, sensorDevicePriority]),
      ),
    ).resolves.toEqual([]);
  });

  it.each([
    ["analytics.schema_migrations", [["applied_at", "DateTime"]], "id"],
    ["analytics.sleep_heart_rate_cutover", [], "cutover_at"],
    [ACCOUNT_ERASURE_FENCE_TABLE, [["erased_at", "DateTime64(9)"]], "user_hash"],
    [ACCOUNT_ERASURE_OPERATION_FENCE_TABLE, [["erased_at", "DateTime64(9)"]], "operation_hash"],
    [
      "postgres_fitness.provider_priority",
      providerPriorityColumns.filter(([name]) => name !== "provider_id"),
      "provider_id",
    ],
    [
      "postgres_fitness.provider_field_priority",
      [["field_key", "String"], ["priority", "Int64"], ...peerDbColumnDefinitions],
      "provider_id",
    ],
    [
      "postgres_fitness.device_priority",
      [
        ["source_name_pattern", "String"],
        ["priority", "Nullable(Int32)"],
        ["sleep_priority", "Nullable(Int32)"],
        ["body_priority", "Nullable(Int32)"],
        ["recovery_priority", "Nullable(Int32)"],
        ["daily_activity_priority", "Nullable(Int32)"],
        ...peerDbColumnDefinitions,
      ],
      "provider_id",
    ],
    [
      "postgres_fitness.sensor_provider_priority",
      [["channel", "String"], ["priority", "Int32"], ...peerDbColumnDefinitions],
      "provider_id",
    ],
    [
      "postgres_fitness.sensor_device_priority",
      [
        ["source_name_pattern", "String"],
        ["channel", "String"],
        ["priority", "Int32"],
        ...peerDbColumnDefinitions,
      ],
      "provider_id",
    ],
  ] as const)(
    "rejects shared system table %s when required column %s is missing",
    async (qualified, columns, missingColumn) => {
      await expect(
        coverage.inspectClickHouseAccountErasureCoverage(
          client([sharedSystemTable(qualified, columns)]),
        ),
      ).rejects.toThrow(`${missingColumn} violates its column contract`);
    },
  );

  it("accepts postgres_fitness provider catalog tables with nullable user ownership", async () => {
    const providerCatalog = sharedSystemTable("postgres_fitness.provider", [
      ["id", "String"],
      ["name", "String"],
      ["api_base_url", "Nullable(String)"],
      ["user_id", "Nullable(UUID)"],
      ["created_at", "DateTime64(6, 'UTC')"],
      ...peerDbColumnDefinitions,
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([providerCatalog])),
    ).resolves.toEqual([providerCatalog]);
  });
});

describe("ClickHouse erasure fence tables", () => {
  it("accepts exact ingest account erasure fence contracts without classifying them as personal data", async () => {
    const userFence = sharedSystemTable(ACCOUNT_ERASURE_FENCE_TABLE, [
      ["user_hash", "FixedString(64)"],
      ["erased_at", "DateTime64(9)"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([userFence])),
    ).resolves.toEqual([]);
  });

  it("accepts exact ingest operation fence contracts without classifying them as personal data", async () => {
    const operationFence = sharedSystemTable(ACCOUNT_ERASURE_OPERATION_FENCE_TABLE, [
      ["operation_hash", "FixedString(64)"],
      ["erased_at", "DateTime64(9)"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([operationFence])),
    ).resolves.toEqual([]);
  });

  it("rejects personal columns added to account erasure fence tables", async () => {
    const userFence = sharedSystemTable(ACCOUNT_ERASURE_FENCE_TABLE, [
      ["user_hash", "FixedString(64)"],
      ["erased_at", "DateTime64(9)"],
      ["email", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([userFence])),
    ).rejects.toThrow("column contract");
  });

  it("rejects personal columns added to operation fence tables", async () => {
    const operationFence = sharedSystemTable(ACCOUNT_ERASURE_OPERATION_FENCE_TABLE, [
      ["operation_hash", "FixedString(64)"],
      ["erased_at", "DateTime64(9)"],
      ["notes", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([operationFence])),
    ).rejects.toThrow("column contract");
  });

  it.each(["sleep_heart_rate_cutover", "schema_migrations", "input_queue"])(
    "rejects personal columns on shared system table name: %s",
    async (name) => {
      await expect(
        coverage.inspectClickHouseAccountErasureCoverage(
          client([table(name, [["email", "String"]])]),
        ),
      ).rejects.toThrow();
    },
  );
});

describe("ClickHouse erasure domain ownership patterns", () => {
  it("classifies sleep stage rows by session identifiers", async () => {
    const sleepStage = physicalTable("postgres_fitness", "sleep_stage", [
      ["id", "UUID"],
      ["session_id", "UUID"],
      ["value", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([sleepStage])),
    ).resolves.toEqual([sleepStage]);
  });

  it("rejects processing flow markers that omit the parent operation identifier", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable("postgres_fitness", "processing_flow_marker", [
            ["id", "UUID"],
            ["batch_key", "String"],
          ]),
        ]),
      ),
    ).rejects.toThrow("Unclassified ClickHouse UUID identity ownership domain");
  });

  it("classifies processing flow markers by operation identifiers", async () => {
    const marker = physicalTable("postgres_fitness", "processing_flow_marker", [
      ["id", "UUID"],
      ["operation_id", "UUID"],
      ["batch_key", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([marker])),
    ).resolves.toEqual([marker]);
  });

  it("requires UUID record-reference columns to sit on direct user-owned tables", async () => {
    const invalidReference = physicalTable("analytics", "metric_stream_panel", [
      ["panel_id", "UUID"],
      ["value", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([invalidReference])),
    ).rejects.toThrow("Unsupported ClickHouse record ownership relation");
  });

  it("accepts UUID record-reference columns on direct user-owned tables", async () => {
    const metricStream = physicalTable("analytics", "metric_stream", [
      ["user_id", "UUID"],
      ["metric_stream_id", "UUID"],
      ["value", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([metricStream])),
    ).resolves.toEqual([metricStream]);
  });

  it("rejects non-UUID record-reference columns even on direct user-owned tables", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable("analytics", "metric_stream", [
            ["user_id", "UUID"],
            ["panel_id", "String"],
            ["value", "String"],
          ]),
        ]),
      ),
    ).rejects.toThrow("Unsupported ClickHouse record ownership relation");
  });

  it("classifies user profile tables by profile id even without user_id", async () => {
    const profile = physicalTable("postgres_fitness", "user_profile", [
      ["id", "UUID"],
      ["name", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([profile])),
    ).resolves.toEqual([profile]);
  });

  it("rejects user profile tables whose profile id is not a UUID", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable("postgres_fitness", "user_profile", [
            ["id", "String"],
            ["name", "String"],
          ]),
        ]),
      ),
    ).rejects.toThrow("Unclassified ClickHouse physical ownership domain");
  });

  it("rejects processing flow markers whose id is not a non-null UUID", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable("postgres_fitness", "processing_flow_marker", [
            ["id", "Nullable(UUID)"],
            ["operation_id", "UUID"],
            ["batch_key", "String"],
          ]),
        ]),
      ),
    ).rejects.toThrow("Unclassified ClickHouse UUID identity ownership domain");
  });

  it("classifies processing flow marker inventory tables by operation identifiers", async () => {
    const inventory = physicalTable(
      "postgres_fitness",
      "processing_flow_marker_provider_inventory",
      [
        ["id", "UUID"],
        ["operation_id", "UUID"],
        ["provider_id", "String"],
      ],
    );
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([inventory])),
    ).resolves.toEqual([inventory]);
  });

  it("classifies processing flow marker sensor priority tables by operation identifiers", async () => {
    const sensorPriority = physicalTable(
      "postgres_fitness",
      "processing_flow_marker_sensor_priority",
      [
        ["id", "UUID"],
        ["operation_id", "UUID"],
        ["channel", "String"],
      ],
    );
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([sensorPriority])),
    ).resolves.toEqual([sensorPriority]);
  });

  it("rejects sleep stage tables that omit the parent session identifier", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable("postgres_fitness", "sleep_stage", [
            ["id", "UUID"],
            ["value", "String"],
          ]),
        ]),
      ),
    ).rejects.toThrow("Unclassified ClickHouse UUID identity ownership domain");
  });

  it("rejects sleep stage tables whose parent session identifier is not a UUID", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable("postgres_fitness", "sleep_stage", [
            ["id", "UUID"],
            ["session_id", "String"],
          ]),
        ]),
      ),
    ).rejects.toThrow("session_id has type String");
  });

  it("allows harmless identifier-shaped columns on user-owned tables", async () => {
    const catalog = table("food_catalog", [
      ["user_id", "UUID"],
      ["provider_id", "String"],
      ["provider_food_id", "String"],
      ["external_id", "String"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([catalog])),
    ).resolves.toEqual([catalog]);
  });
});

const identifierCatalogCases = [
  ["activity_id", "UUID", "activityIds"],
  ["canonical_id", "UUID", "activityIds"],
  ["canonical_activity_id", "UUID", "activityIds"],
  ["canonical_activity_id", "Nullable(UUID)", "activityIds"],
  ["evidence_activity_id", "UUID", "activityIds"],
  ["evidence_activity_id", "Nullable(UUID)", "activityIds"],
  ["connected_activity_id", "UUID", "activityIds"],
  ["duplicate_activity_id", "UUID", "activityIds"],
  ["linked_activity_id", "UUID", "activityIds"],
  ["member_activity_id", "UUID", "activityIds"],
  ["member_activity_ids", "Array(UUID)", "activityIds"],
  ["primary_activity_id", "UUID", "activityIds"],
  ["representative_activity_id", "UUID", "activityIds"],
  ["origin_candidate_member_ids", "Array(UUID)", "activityIds"],
  ["source_activity_id", "UUID", "activityIds"],
  ["operation_id", "UUID", "operationIds"],
  ["selected_session_id", "UUID", "sleepIds"],
  ["session_id", "UUID", "sleepIds"],
  ["sleep_id", "UUID", "sleepIds"],
  ["sleep_session_id", "UUID", "sleepIds"],
  ["group_id", "UUID", "activityIds"],
  ["group_id", "String", "stringRelationIds"],
] as const satisfies readonly (readonly [string, string, string])[];

describe("ClickHouse erasure identifier catalog", () => {
  it.each(identifierCatalogCases)(
    "classifies relation-only tables by %s",
    async (columnName, columnType) => {
      const relationOnly = physicalTable("analytics", `${columnName}_rows`, [
        [columnName, columnType],
      ]);
      await expect(
        coverage.inspectClickHouseAccountErasureCoverage(client([relationOnly])),
      ).resolves.toEqual([relationOnly]);
    },
  );

  it.each(identifierCatalogCases)("maps %s to the %s family", (columnName, columnType, family) => {
    const rows = physicalTable("analytics", "ownership_rows", [
      ["user_id", "UUID"],
      [columnName, columnType],
    ]);
    expect(coverage.identifierColumns(rows)).toEqual([
      [
        columnName,
        {
          cardinality: columnType.startsWith("Array(") ? "array" : "scalar",
          family,
          valueType: columnType.includes("String") ? "string" : "uuid",
        },
      ],
    ]);
  });

  it("accepts nullable uuid scalars and low-cardinality string group identifiers", async () => {
    const rows = physicalTable("analytics", "activity_groups", [
      ["user_id", "UUID"],
      ["activity_id", "Nullable(UUID)"],
      ["group_id", "LowCardinality(String)"],
      ["member_activity_ids", "Array(Nullable(UUID))"],
    ]);
    expect(coverage.identifierColumns(rows)).toEqual([
      ["activity_id", { cardinality: "scalar", family: "activityIds", valueType: "uuid" }],
      ["group_id", { cardinality: "scalar", family: "stringRelationIds", valueType: "string" }],
      ["member_activity_ids", { cardinality: "array", family: "activityIds", valueType: "uuid" }],
    ]);
    await expect(coverage.inspectClickHouseAccountErasureCoverage(client([rows]))).resolves.toEqual(
      [rows],
    );
  });
});

describe("ClickHouse erasure ownership heuristics", () => {
  it.each([
    ["account_id", "UUID"],
    ["account_ids", "Array(UUID)"],
    ["session_ids", "Array(UUID)"],
    ["processing_operation_id", "UUID"],
    ["person_id", "UUID"],
    ["foo_metric_stream_id", "UUID"],
    ["activity_group_id", "UUID"],
    ["batch_session_ids", "Array(UUID)"],
    ["measurement_panel_id", "UUID"],
    ["legacy_account_id", "UUID"],
  ] as const)("rejects unmapped ownership column %s", async (columnName, columnType) => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table("rows", [[columnName, columnType]])]),
      ),
    ).rejects.toThrow("not mapped to an ownership relation");
  });

  it("does not treat non-ownership identifier suffixes as probable ownership columns", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table("rows", [["account_id_suffix", "String"]])]),
      ),
    ).rejects.toThrow("Unclassified ClickHouse physical ownership domain");
  });

  it.each([
    "address",
    "birth_date",
    "lat",
    "latitude",
    "lng",
    "longitude",
    "metadata",
    "notes",
    "phone",
    "point",
    "raw",
  ] as const)("rejects strong personal column %s without ownership", async (columnName) => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table("rows", [[columnName, "String"]])]),
      ),
    ).rejects.toThrow("without an ownership relation");
  });

  it("rejects unclassified tables that only expose a bare UUID id", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table("mystery_identity", [["id", "UUID"]])]),
      ),
    ).rejects.toThrow("Unclassified ClickHouse UUID identity ownership domain");
  });

  it("rejects tables with no ownership signals at all", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table("reference_only", [["provider_id", "String"]])]),
      ),
    ).rejects.toThrow("Unclassified ClickHouse physical ownership domain");
  });
});

describe("ClickHouse erasure inspection guards", () => {
  it("rejects invalid managed database names in inspection options", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([]), {
        managedDatabases: ["not-a-valid-database"],
      }),
    ).rejects.toThrow();
  });

  it("requires direct UUID ownership for record-reference columns", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([
          physicalTable("analytics", "metric_stream", [
            ["user_id", "Nullable(UUID)"],
            ["metric_stream_id", "UUID"],
          ]),
        ]),
      ),
    ).rejects.toThrow("Unsupported ClickHouse record ownership relation");
  });

  it("rejects catalog metadata that exceeds the byte budget", async () => {
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([table("rows", [["user_id", "UUID"]])], {
          tables: 1,
          bytes: 1024 * 1024 + 1,
        }),
      ),
    ).rejects.toThrow("metadata budget");
  });

  it("skips non-storage engines while inspecting merge-tree tables", async () => {
    const owned = table("owned", [["user_id", "UUID"]]);
    const view = physicalTable("analytics", "owned_view", [["user_id", "UUID"]], {
      engine: "MaterializedView",
    });
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([owned, view])),
    ).resolves.toEqual([owned]);
  });

  it("rejects shared system tables that omit required contract columns", async () => {
    const migrations = sharedSystemTable("analytics.schema_migrations", [["id", "String"]]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([migrations])),
    ).rejects.toThrow("column contract");
  });

  it("rejects fence tables whose hash columns drift from the contract", async () => {
    const userFence = sharedSystemTable(ACCOUNT_ERASURE_FENCE_TABLE, [
      ["user_hash", "FixedString(32)"],
      ["erased_at", "DateTime64(9)"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([userFence])),
    ).rejects.toThrow("column contract");
  });

  it("rejects provider priority mirrors with drifted peerdb metadata types", async () => {
    const priority = sharedSystemTable("postgres_fitness.provider_priority", [
      ...providerPriorityColumns.slice(0, -3),
      ["_peerdb_synced_at", "DateTime"],
      ["_peerdb_is_deleted", "Int8"],
      ["_peerdb_version", "Int64"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([priority])),
    ).rejects.toThrow("column contract");
  });

  it("rejects catalog rows that fail physical table schema validation", async () => {
    let calls = 0;
    const malformedClient = {
      query: async () => ({
        json: async () => {
          calls += 1;
          if (calls === 1) return [{ tables: 1, bytes: 1024 }];
          return [{ database: "analytics", name: "rows", engine: "MergeTree", uuid: "not-a-uuid" }];
        },
      }),
    };
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(malformedClient),
    ).rejects.toThrow();
  });

  it("does not treat fence tables on non-ingest databases as protected metadata", async () => {
    const fenceShaped = physicalTable("analytics", "account_erasure_fence", [
      ["user_hash", "FixedString(64)"],
      ["erased_at", "DateTime64(9)"],
    ]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(client([fenceShaped])),
    ).rejects.toThrow("Unclassified ClickHouse physical ownership domain");
  });

  it("accepts the inclusive 500-table / 1 MiB catalog budget and rejects only overage", async () => {
    const owned = table("owned_rows", [["user_id", "UUID"]]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([owned], { tables: 500, bytes: 1024 * 1024 }),
      ),
    ).resolves.toEqual([owned]);
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([owned], { tables: 501, bytes: 1024 }),
      ),
    ).rejects.toThrow("500-table/1 MiB metadata budget");
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(
        client([owned], { tables: 1, bytes: 1024 * 1024 + 1 }),
      ),
    ).rejects.toThrow("500-table/1 MiB metadata budget");
  });

  it("binds managed database names and disables query logging for catalog reads", async () => {
    const owned = table("owned_rows", [["user_id", "UUID"]]);
    const observed: Array<{
      query_params?: Record<string, unknown>;
      clickhouse_settings?: Record<string, unknown>;
    }> = [];
    let calls = 0;
    const observingClient = {
      query: async (options: {
        query_params?: Record<string, unknown>;
        clickhouse_settings?: Record<string, unknown>;
      }) => {
        observed.push(options);
        return {
          json: async () => (++calls === 1 ? [{ tables: 1, bytes: 1024 }] : [owned]),
        };
      },
    };
    await expect(
      coverage.inspectClickHouseAccountErasureCoverage(observingClient),
    ).resolves.toEqual([owned]);
    expect(observed).toHaveLength(2);
    expect(observed).toEqual([
      expect.objectContaining({
        query_params: { managed_databases: [...coverage.PRODUCTION_MANAGED_DATABASES] },
        clickhouse_settings: { log_queries: 0 },
      }),
      expect.objectContaining({
        query_params: { managed_databases: [...coverage.PRODUCTION_MANAGED_DATABASES] },
        clickhouse_settings: { log_queries: 0 },
      }),
    ]);
  });
});
