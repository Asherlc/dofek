import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectClickHouseAccountErasureCoverage } from "./clickhouse-erasure-coverage.ts";

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

function client(tables: readonly object[]) {
  let calls = 0;
  return {
    query: async () => ({
      json: async () => (++calls === 1 ? [{ tables: tables.length, bytes: 1024 }] : tables),
    }),
  };
}
function table(name: string, columns: readonly ColumnDefinition[]) {
  return {
    database: "analytics",
    name,
    uuid: randomUUID(),
    age_milliseconds: 1000000,
    engine: "MergeTree",
    columns,
  };
}
describe("ClickHouse erasure ownership coverage", () => {
  it("rejects a target without a physical UUID binding", async () => {
    await expect(
      inspectClickHouseAccountErasureCoverage(
        client([
          { ...table("rows", [["user_id", "UUID"]]), uuid: "00000000-0000-0000-0000-000000000000" },
        ]),
      ),
    ).rejects.toThrow("physical UUID");
  });
  it.each(schemaDriftCases)("rejects unsupported ownership %s", async (_label, columns, error) => {
    await expect(
      inspectClickHouseAccountErasureCoverage(client([table("rows", columns)])),
    ).rejects.toThrow(error);
  });
  it.each(stagingSchemaDriftCases)(
    "rejects mismatched staging ownership: %s",
    async (_label, canonical, staging) => {
      await expect(
        inspectClickHouseAccountErasureCoverage(
          client([
            table("rows", canonical),
            table(`rows__dbt_new_data_${randomUUID().replaceAll("-", "_")}`, staging),
          ]),
        ),
      ).rejects.toThrow("staging schema mismatch");
    },
  );
  it.each(["input_queue", "account_erasure_user_fence", "sleep_heart_rate_cutover"])(
    "rejects personal columns on a shared name: %s",
    async (name) => {
      await expect(
        inspectClickHouseAccountErasureCoverage(client([table(name, [["email", "String"]])])),
      ).rejects.toThrow();
    },
  );
});
