import { describe, expect, it } from "vitest";
import {
  DATASET_CONTRACTS,
  datasetsForProvider,
  PRODUCTION_DBT_MODELS,
  processingDatasetKeysForImport,
  processingDatasetKeysForOutputPath,
  processingDatasetKeysForProvider,
  requiredCdcEvidence,
  validateDatasetContracts,
} from "./dataset-contracts.ts";

describe("dataset contracts", () => {
  it("assigns every production dbt model exactly once", () => {
    expect(PRODUCTION_DBT_MODELS).toHaveLength(35);
    expect(() => validateDatasetContracts(DATASET_CONTRACTS, PRODUCTION_DBT_MODELS)).not.toThrow();

    const assignedModels = DATASET_CONTRACTS.flatMap((contract) => contract.analyticsModels);
    expect(assignedModels.sort()).toEqual([...PRODUCTION_DBT_MODELS].sort());
  });

  it("rejects missing, duplicate, and unknown model assignments", () => {
    const [firstContract, ...remainingContracts] = DATASET_CONTRACTS;
    const firstModel = firstContract.analyticsModels[0];
    const contractsWithInvalidAssignments = [
      {
        ...firstContract,
        analyticsModels: [...firstContract.analyticsModels.slice(1), "not_a_production_model"],
      },
      {
        ...remainingContracts[0],
        analyticsModels: [...remainingContracts[0].analyticsModels, firstModel],
      },
      ...remainingContracts.slice(1),
    ];

    expect(() =>
      validateDatasetContracts(contractsWithInvalidAssignments, PRODUCTION_DBT_MODELS),
    ).toThrowError(/missing.*unknown.*duplicate/i);
  });

  it("selects only datasets applicable to a provider and its emitted data types", () => {
    expect(datasetsForProvider("kaya", ["activity", "climbing"]).map(({ key }) => key)).toEqual([
      "activity",
      "hiking",
      "recovery",
      "training",
    ]);
    expect(datasetsForProvider("cronometer", ["nutrition"]).map(({ key }) => key)).toEqual([
      "nutrition",
    ]);
  });

  it("keeps provider processing scopes limited to datasets they can affect", () => {
    expect(processingDatasetKeysForProvider("bodyspec")).toEqual(["body", "providers"]);
    expect(processingDatasetKeysForProvider("eight-sleep")).toEqual([
      "sleep",
      "recovery",
      "training",
      "providers",
    ]);
    expect(processingDatasetKeysForProvider("unknown-provider")).toEqual(["providers"]);
  });

  it("maps imports to bounded scopes and selects only emitted output paths", () => {
    const cronometerDatasets = processingDatasetKeysForImport("cronometer-csv");
    expect(cronometerDatasets).toEqual(["nutrition", "providers"]);
    expect(processingDatasetKeysForOutputPath(cronometerDatasets, "metric_stream")).toEqual([
      "providers",
    ]);

    const fitDatasets = processingDatasetKeysForImport("fit-file");
    expect(processingDatasetKeysForOutputPath(fitDatasets, "metric_stream")).toEqual([
      "activity",
      "hiking",
      "cycling",
      "recovery",
      "training",
      "body",
      "providers",
    ]);
  });

  it("tracks every independent input used by provider analytics", () => {
    const providers = DATASET_CONTRACTS.find((contract) => contract.key === "providers");
    if (!providers) throw new Error("Missing providers dataset contract");

    expect(requiredCdcEvidence(providers, ["relational"])).toEqual([
      { kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" },
      { kind: "peerdb_marker", flowName: "dofek_provider_inventory_raw_analytics" },
    ]);
    expect(requiredCdcEvidence(providers, ["metric_stream"])).toEqual([
      { kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" },
    ]);
  });

  it("requires evidence only for output paths the operation actually emitted", () => {
    const activity = DATASET_CONTRACTS.find((contract) => contract.key === "activity");
    if (!activity) throw new Error("Missing activity dataset contract");

    expect(requiredCdcEvidence(activity, ["relational"])).toEqual([
      { kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" },
    ]);
    expect(requiredCdcEvidence(activity, ["metric_stream"])).toEqual([
      { kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" },
    ]);
    expect(requiredCdcEvidence(activity, ["relational", "metric_stream"])).toEqual([
      { kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" },
      { kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" },
    ]);
    expect(requiredCdcEvidence(activity, [])).toEqual([]);
  });

  it("does not retain the obsolete metric-stream PeerDB flow", () => {
    expect(JSON.stringify(DATASET_CONTRACTS)).not.toContain("dofek_metric_stream_analytics");
  });
});
