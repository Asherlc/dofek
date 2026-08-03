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
    expect(PRODUCTION_DBT_MODELS).toHaveLength(39);
    expect(() => validateDatasetContracts(DATASET_CONTRACTS, PRODUCTION_DBT_MODELS)).not.toThrow();

    const assignedModels = DATASET_CONTRACTS.flatMap((contract) => contract.analyticsModels);
    expect(assignedModels.sort()).toEqual([...PRODUCTION_DBT_MODELS].sort());
  });

  it("runs daily provider metric counts before provider stats", () => {
    const dailyIndex = PRODUCTION_DBT_MODELS.indexOf("provider_metric_stream_daily");
    const watermarkIndex = PRODUCTION_DBT_MODELS.indexOf("provider_change_watermark");
    const providerStatsIndex = PRODUCTION_DBT_MODELS.indexOf("provider_stats");

    expect(dailyIndex).toBe(watermarkIndex - 1);
    expect(providerStatsIndex).toBe(watermarkIndex + 1);

    const providers = DATASET_CONTRACTS.find((contract) => contract.key === "providers");
    expect(providers?.analyticsModels).toEqual([
      "provider_metric_stream_daily",
      "provider_change_watermark",
      "provider_stats",
    ]);
  });

  it("rejects a duplicate output path", () => {
    const [firstContract, ...remainingContracts] = DATASET_CONTRACTS;
    const firstOutputPath = firstContract.outputPaths[0];
    const contractsWithDuplicateOutput = [
      {
        ...firstContract,
        outputPaths: [...firstContract.outputPaths, firstOutputPath],
      },
      ...remainingContracts,
    ];

    expect(() =>
      validateDatasetContracts(contractsWithDuplicateOutput, PRODUCTION_DBT_MODELS),
    ).toThrowError(`Dataset ${firstContract.key} defines a duplicate output path`);
  });

  it("reports a missing model assignment", () => {
    const [firstContract, ...remainingContracts] = DATASET_CONTRACTS;
    const missingModel = firstContract.analyticsModels[0];
    const contractsWithMissingModel = [
      {
        ...firstContract,
        analyticsModels: firstContract.analyticsModels.filter((model) => model !== missingModel),
      },
      ...remainingContracts,
    ];

    expect(() =>
      validateDatasetContracts(contractsWithMissingModel, PRODUCTION_DBT_MODELS),
    ).toThrowError(
      `Invalid dataset contracts: missing=[${missingModel}], unknown=[], duplicate=[]`,
    );
  });

  it("reports an unknown model assignment", () => {
    const [firstContract, ...remainingContracts] = DATASET_CONTRACTS;
    const contractsWithUnknownModel = [
      {
        ...firstContract,
        analyticsModels: [...firstContract.analyticsModels, "not_a_production_model"],
      },
      ...remainingContracts,
    ];

    expect(() =>
      validateDatasetContracts(contractsWithUnknownModel, PRODUCTION_DBT_MODELS),
    ).toThrowError(
      "Invalid dataset contracts: missing=[], unknown=[not_a_production_model], duplicate=[]",
    );
  });

  it("reports a duplicate model assignment", () => {
    const [firstContract, secondContract, ...remainingContracts] = DATASET_CONTRACTS;
    const duplicateModel = firstContract.analyticsModels[0];
    const contractsWithDuplicateModel = [
      firstContract,
      {
        ...secondContract,
        analyticsModels: [...secondContract.analyticsModels, duplicateModel],
      },
      ...remainingContracts,
    ];

    expect(() =>
      validateDatasetContracts(contractsWithDuplicateModel, PRODUCTION_DBT_MODELS),
    ).toThrowError(
      `Invalid dataset contracts: missing=[], unknown=[], duplicate=[${duplicateModel}]`,
    );
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
    expect(datasetsForProvider("kaya", ["nutrition"])).toEqual([]);
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
    const declaredDatasetKeys = ["nutrition"] as const;
    expect(processingDatasetKeysForProvider("garmin", declaredDatasetKeys)).toBe(
      declaredDatasetKeys,
    );
    expect(processingDatasetKeysForProvider("bodyspec", [])).toEqual(["body", "providers"]);
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
    expect(processingDatasetKeysForImport("unknown-import")).toEqual(["providers"]);
  });

  it("tracks every independent input used by provider analytics", () => {
    const providers = DATASET_CONTRACTS.find((contract) => contract.key === "providers");
    if (!providers) throw new Error("Missing providers dataset contract");

    expect(
      providers.outputPaths.find((outputPath) => outputPath.path === "relational")?.sources,
    ).toContain("provider_connection");
    expect(requiredCdcEvidence(providers, ["relational"])).toEqual([
      { kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" },
      { kind: "peerdb_marker", flowName: "dofek_provider_inventory_raw_analytics" },
    ]);
    expect(requiredCdcEvidence(providers, ["metric_stream"])).toEqual([
      { kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" },
    ]);
  });

  it("tracks dose events as a nutrition input", () => {
    const nutrition = DATASET_CONTRACTS.find((contract) => contract.key === "nutrition");
    if (!nutrition) throw new Error("Missing nutrition dataset contract");

    expect(
      nutrition.outputPaths.find((outputPath) => outputPath.path === "relational")?.sources,
    ).toContain("supplement_dose_event");
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
});
