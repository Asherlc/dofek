import { describe, expect, it } from "vitest";
import type { PeerDbMirrorContract } from "./mirror-contracts.ts";
import {
  assertPeerDbMirrorSchemasCompatible,
  inspectPeerDbMirrorSchemas,
} from "./mirror-schema-validator.ts";

const baseContract: PeerDbMirrorContract = {
  destinationDatabase: "destination",
  initialCopyPlaceholder: "TEST_DO_INITIAL_COPY",
  name: "test_mirror",
  processingMarker: undefined,
  tableMappingsPlaceholder: "TEST_TABLE_MAPPINGS",
  tableMappings: [
    {
      destinationTableIdentifier: "daily_metrics",
      exclude: ["ignored_column"],
      sourceTableIdentifier: "fitness.daily_metrics",
    },
  ],
};
const contract = [baseContract] satisfies readonly PeerDbMirrorContract[];

function sourceClient(columns: string[]) {
  return {
    async query() {
      return {
        rows: columns.map((column_name) => ({
          column_name,
          table_name: "daily_metrics",
          table_schema: "fitness",
        })),
      };
    },
  };
}

function clickHouseClient(columns: string[]) {
  return {
    async command() {},
    async query() {
      return {
        async json() {
          return columns.map((name) => ({ database: "destination", name, table: "daily_metrics" }));
        },
      };
    },
  };
}

const metadataColumns = ["_peerdb_is_deleted", "_peerdb_synced_at", "_peerdb_version"];

describe("PeerDB mirror schema validator", () => {
  it("accepts a compatible source projection and PeerDB metadata", async () => {
    await expect(
      inspectPeerDbMirrorSchemas({
        clickHouseClient: clickHouseClient(["id", ...metadataColumns]),
        contracts: contract,
        sourcePostgresClient: sourceClient(["id", "ignored_column"]),
      }),
    ).resolves.toEqual({ issues: [] });
  });

  it("reports projected source columns missing from ClickHouse", async () => {
    await expect(
      inspectPeerDbMirrorSchemas({
        clickHouseClient: clickHouseClient(["id", ...metadataColumns]),
        contracts: contract,
        sourcePostgresClient: sourceClient(["id", "ignored_column", "stress_high_minutes"]),
      }),
    ).resolves.toEqual({
      issues: [
        {
          columns: ["stress_high_minutes"],
          destinationTableIdentifier: "destination.daily_metrics",
          kind: "missing_destination_columns",
          mirrorName: "test_mirror",
          sourceTableIdentifier: "fitness.daily_metrics",
        },
      ],
    });
  });

  it("reports exclusions that no longer name source columns", async () => {
    const report = await inspectPeerDbMirrorSchemas({
      clickHouseClient: clickHouseClient(["id", ...metadataColumns]),
      contracts: contract,
      sourcePostgresClient: sourceClient(["id"]),
    });

    expect(report.issues).toEqual([
      {
        columns: ["ignored_column"],
        destinationTableIdentifier: "destination.daily_metrics",
        kind: "unknown_excluded_source_columns",
        mirrorName: "test_mirror",
        sourceTableIdentifier: "fitness.daily_metrics",
      },
    ]);
  });

  it("accepts an intentionally retired exclusion after the source column is removed", async () => {
    const retiredContract = [
      {
        ...baseContract,
        tableMappings: [
          {
            destinationTableIdentifier: "daily_metrics",
            exclude: ["ignored_column"],
            sourceTableIdentifier: "fitness.daily_metrics",
            allowAbsentExcludedSourceColumns: ["ignored_column"],
          },
        ],
      },
    ];

    await expect(
      inspectPeerDbMirrorSchemas({
        clickHouseClient: clickHouseClient(["id", ...metadataColumns]),
        contracts: retiredContract,
        sourcePostgresClient: sourceClient(["id"]),
      }),
    ).resolves.toEqual({ issues: [] });
  });

  it("reports missing PeerDB-owned destination metadata separately", async () => {
    const report = await inspectPeerDbMirrorSchemas({
      clickHouseClient: clickHouseClient(["id"]),
      contracts: contract,
      sourcePostgresClient: sourceClient(["id", "ignored_column"]),
    });

    expect(report.issues).toEqual([
      {
        columns: metadataColumns,
        destinationTableIdentifier: "destination.daily_metrics",
        kind: "missing_peerdb_metadata_columns",
        mirrorName: "test_mirror",
        sourceTableIdentifier: "fitness.daily_metrics",
      },
    ]);
  });

  it("does not accept an absent source or destination table as an empty schema", async () => {
    await expect(
      inspectPeerDbMirrorSchemas({
        clickHouseClient: clickHouseClient([]),
        contracts: contract,
        sourcePostgresClient: sourceClient([]),
      }),
    ).resolves.toEqual({
      issues: [
        {
          columns: [],
          destinationTableIdentifier: "destination.daily_metrics",
          kind: "missing_source_table",
          mirrorName: "test_mirror",
          sourceTableIdentifier: "fitness.daily_metrics",
        },
        {
          columns: [],
          destinationTableIdentifier: "destination.daily_metrics",
          kind: "missing_destination_table",
          mirrorName: "test_mirror",
          sourceTableIdentifier: "fitness.daily_metrics",
        },
      ],
    });
  });

  it("fails with deterministic identifier-only diagnostics", async () => {
    await expect(
      assertPeerDbMirrorSchemasCompatible({
        clickHouseClient: clickHouseClient(["id", ...metadataColumns]),
        contracts: contract,
        sourcePostgresClient: sourceClient(["id", "ignored_column", "stress_high_minutes"]),
      }),
    ).rejects.toThrow(
      "PeerDB mirror schema contract is incompatible: test_mirror fitness.daily_metrics -> destination.daily_metrics missing_destination_columns=[stress_high_minutes]",
    );
  });
});
