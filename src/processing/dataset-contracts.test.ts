import { describe, expect, it } from "vitest";
import { buildProcessingAnalyticsEvents } from "./analytics-processing.ts";
import { buildProcessingCacheEvents } from "./cache-processing.ts";
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
import { deriveProcessingState, type ProcessingStageEvent } from "./processing-state.ts";

describe("dataset contracts", () => {
  it("assigns every production dbt model exactly once", () => {
    expect(PRODUCTION_DBT_MODELS).toHaveLength(45);
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
    expect(datasetsForProvider("ziva", ["nutrition"]).map(({ key }) => key)).toEqual(["nutrition"]);
    expect(datasetsForProvider("kaya", ["nutrition"])).toEqual([]);
  });

  it("routes a sensor-only correction through training without changing its freshness target", () => {
    const training = datasetsForProvider("garmin", ["metric_stream"]).find(
      (contract) => contract.key === "training",
    );
    expect(training?.freshnessTargetMs).toBe(15 * 60 * 1000);
    expect(training?.analyticsModels).toContain("activity_pace_curve");
    expect(training?.analyticsModels).toContain("activity_heart_rate_distribution");
  });

  it("keeps training incomplete until exact heart-rate distribution processing finishes", () => {
    const training = DATASET_CONTRACTS.find((contract) => contract.key === "training");
    if (!training) throw new Error("Missing training dataset contract");
    const successfulModels = training.analyticsModels
      .filter((name) => name !== "activity_heart_rate_distribution")
      .map((name) => ({ name, status: "succeeded" as const, errorCode: null, message: null }));
    const events = (complete: boolean) =>
      buildProcessingAnalyticsEvents({
        runId: "heart-rate-processing",
        pendingDatasets: [{ operationId: "heart-rate-operation", datasetKey: "training" }],
        modelResults: complete
          ? [
              ...successfulModels,
              {
                name: "activity_heart_rate_distribution",
                status: "succeeded",
                errorCode: null,
                message: null,
              },
            ]
          : successfulModels,
      });
    expect(events(false).at(-1)).toMatchObject({
      status: "failed",
      errorCode: "required_model_unattempted",
    });
    expect(events(true).at(-1)).toMatchObject({ status: "succeeded" });
  });

  it("keeps training incomplete until the pace model and duration cache finish", () => {
    const training = DATASET_CONTRACTS.find((contract) => contract.key === "training");
    if (!training) throw new Error("Missing training dataset contract");
    const operationId = "pace-operation";
    const otherModels = training.analyticsModels
      .filter((name) => name !== "activity_pace_curve")
      .map((name) => ({ name, status: "succeeded" as const, errorCode: null, message: null }));
    const pending = buildProcessingAnalyticsEvents({
      runId: "pace-pending",
      pendingDatasets: [{ operationId, datasetKey: "training" }],
      modelResults: otherModels,
    });
    expect(pending.at(-1)).toMatchObject({
      status: "failed",
      errorCode: "required_model_unattempted",
    });
    const complete = buildProcessingAnalyticsEvents({
      runId: "pace-ready",
      pendingDatasets: [{ operationId, datasetKey: "training" }],
      modelResults: [
        ...otherModels,
        { name: "activity_pace_curve", status: "succeeded", errorCode: null, message: null },
      ],
    });
    expect(complete.at(-1)).toMatchObject({ status: "succeeded" });
    const cacheEvents = (status: "succeeded" | "failed") =>
      buildProcessingCacheEvents({
        runId: "pace-cache",
        targets: [{ operationId, datasetKey: "training", userId: "pace-user" }],
        outcomes: [
          {
            userId: "pace-user",
            path: "durationCurves.paceCurve",
            status,
            errorMessage: status === "failed" ? "query failed" : null,
          },
        ],
      });
    expect(cacheEvents("failed")[0]).toMatchObject({ status: "failed" });
    expect(cacheEvents("succeeded")[0]).toMatchObject({ status: "succeeded" });
    const now = new Date("2026-09-01T12:00:00Z");
    const prerequisiteStages = [
      "ingest",
      "canonical_commit",
      "cdc",
    ] satisfies ProcessingStageEvent["stage"][];
    const prerequisites: ProcessingStageEvent[] = prerequisiteStages.map((stage, sequence) => ({
      sequence,
      stage,
      status: "succeeded",
      datasetKey: "training",
      occurredAt: now,
      progressPercentage: null,
      outputPath: stage === "ingest" ? null : "metric_stream",
    }));
    const state = (events: ProcessingStageEvent[]) =>
      deriveProcessingState({
        datasetKeys: ["training"],
        outputManifest: { training: ["metric_stream"] },
        events,
        now,
        delayedAfterMs: training.freshnessTargetMs,
      });
    expect(state(prerequisites).datasets[0]).toMatchObject({
      currentStage: "analytics",
      status: "waiting",
    });
    const analyticsReady: ProcessingStageEvent = {
      sequence: 3,
      stage: "analytics",
      status: complete.at(-1)?.status ?? "failed",
      datasetKey: "training",
      outputPath: null,
      occurredAt: now,
      progressPercentage: null,
    };
    expect(state([...prerequisites, analyticsReady]).datasets[0]).toMatchObject({
      currentStage: "cache_refresh",
      status: "waiting",
    });
    expect(
      state([
        ...prerequisites,
        analyticsReady,
        {
          sequence: 4,
          stage: "cache_refresh",
          status: cacheEvents("succeeded")[0]?.status ?? "failed",
          datasetKey: "training",
          outputPath: null,
          occurredAt: now,
          progressPercentage: null,
        },
      ]).overallStatus,
    ).toBe("ready");
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
    expect(processingDatasetKeysForProvider("ziva")).toEqual(["nutrition", "providers"]);
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

  it("tracks food records as a nutrition input", () => {
    const nutrition = DATASET_CONTRACTS.find((contract) => contract.key === "nutrition");
    if (!nutrition) throw new Error("Missing nutrition dataset contract");

    expect(
      nutrition.outputPaths.find((outputPath) => outputPath.path === "relational")?.sources,
    ).toContain("food_entry");
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
