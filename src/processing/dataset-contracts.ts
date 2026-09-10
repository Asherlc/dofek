export const PRODUCTION_DBT_MODELS = [
  "sensor_scalar_sample",
  "deduped_sensor",
  "activity_source_records",
  "activity_duplicate_matches",
  "activity_duplicate_groups",
  "deduped_activities",
  "deduped_activity_members",
  "activity_sensor_sample",
  "activity_location_sample",
  "activity_sensor_summary_rows",
  "activity_location_summary_rows",
  "activity_stream_points",
  "activity_heart_rate_zones",
  "activity_summary_rows",
  "hiking_activity",
  "body_measurement",
  "activity_vo2max_estimate",
  "activity_aerobic_efficiency",
  "activity_polarization_zones",
  "activity_power_curve",
  "cycling_activity",
  "daily_cycling",
  "provider_metric_stream_daily",
  "provider_change_watermark",
  "provider_stats",
  "sleep_heart_rate_window",
  "sleep_heart_rate_sample",
  "resting_heart_rate_sleep_window",
  "daily_sleep",
  "daily_recovery_inputs",
  "daily_recovery",
  "daily_endurance_load",
  "weekly_endurance_ramp_rate",
  "weekly_training_monotony",
  "daily_activity_load",
  "daily_strain",
  "daily_body_measurement",
  "healthspan_activity_zone_minutes",
  "weekly_healthspan",
] as const;

export type ProductionDbtModel = (typeof PRODUCTION_DBT_MODELS)[number];

export const PROCESSING_DATASET_KEYS = [
  "activity",
  "hiking",
  "cycling",
  "sleep",
  "recovery",
  "training",
  "body",
  "nutrition",
  "providers",
] as const;

export type ProcessingDatasetKey = (typeof PROCESSING_DATASET_KEYS)[number];

export const PROCESSING_OUTPUT_PATHS = ["relational", "metric_stream"] as const;

export type ProcessingOutputPath = (typeof PROCESSING_OUTPUT_PATHS)[number];

export type CdcEvidenceDependency =
  | { kind: "peerdb_marker"; flowName: string }
  | { kind: "clickhouse_sink_ack"; sinkName: string };

export interface DatasetOutputPathContract {
  path: ProcessingOutputPath;
  sources: readonly string[];
  cdcEvidence: readonly CdcEvidenceDependency[];
}

export interface DatasetContract {
  key: ProcessingDatasetKey;
  label: string;
  outputPaths: readonly DatasetOutputPathContract[];
  analyticsModels: readonly string[];
  cacheQueryFamilies: readonly string[];
  providerIds: readonly string[];
  dataTypes: readonly string[];
  freshnessTargetMs: number;
  webConsumers: readonly string[];
  mobileConsumers: readonly string[];
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1_000;

export const DATASET_CONTRACTS = [
  {
    key: "activity",
    label: "Activities",
    outputPaths: [
      {
        path: "relational",
        sources: ["activity"],
        cdcEvidence: [{ kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" }],
      },
      {
        path: "metric_stream",
        sources: ["metric_stream"],
        cdcEvidence: [{ kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" }],
      },
    ],
    analyticsModels: [
      "sensor_scalar_sample",
      "deduped_sensor",
      "activity_source_records",
      "activity_duplicate_matches",
      "activity_duplicate_groups",
      "deduped_activities",
      "deduped_activity_members",
      "activity_sensor_sample",
      "activity_location_sample",
      "activity_sensor_summary_rows",
      "activity_location_summary_rows",
      "activity_stream_points",
      "activity_heart_rate_zones",
      "activity_summary_rows",
      "activity_vo2max_estimate",
      "activity_aerobic_efficiency",
      "activity_polarization_zones",
      "activity_power_curve",
      "daily_activity_load",
    ],
    cacheQueryFamilies: ["activity", "dashboard", "providerDetail"],
    providerIds: ["*"],
    dataTypes: ["activity", "climbing", "metric_stream"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["activity", "dashboard", "provider-detail"],
    mobileConsumers: ["activity", "dashboard", "provider-detail"],
  },
  {
    key: "hiking",
    label: "Hiking",
    outputPaths: [
      {
        path: "relational",
        sources: ["activity"],
        cdcEvidence: [{ kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" }],
      },
      {
        path: "metric_stream",
        sources: ["metric_stream"],
        cdcEvidence: [{ kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" }],
      },
    ],
    analyticsModels: ["hiking_activity"],
    cacheQueryFamilies: ["hiking"],
    providerIds: ["*"],
    dataTypes: ["activity", "climbing", "hiking"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["hiking"],
    mobileConsumers: ["hiking"],
  },
  {
    key: "cycling",
    label: "Cycling",
    outputPaths: [
      {
        path: "relational",
        sources: ["activity"],
        cdcEvidence: [{ kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" }],
      },
      {
        path: "metric_stream",
        sources: ["metric_stream"],
        cdcEvidence: [{ kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" }],
      },
    ],
    analyticsModels: ["cycling_activity", "daily_cycling"],
    cacheQueryFamilies: ["cycling", "cyclingAdvanced"],
    providerIds: ["*"],
    dataTypes: ["cycling"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["cycling"],
    mobileConsumers: ["cycling"],
  },
  {
    key: "sleep",
    label: "Sleep",
    outputPaths: [
      {
        path: "relational",
        sources: ["sleep_session", "sleep_stage"],
        cdcEvidence: [{ kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" }],
      },
      {
        path: "metric_stream",
        sources: ["metric_stream"],
        cdcEvidence: [{ kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" }],
      },
    ],
    analyticsModels: [
      "sleep_heart_rate_window",
      "sleep_heart_rate_sample",
      "resting_heart_rate_sleep_window",
      "daily_sleep",
    ],
    cacheQueryFamilies: ["sleep", "sleepNeed", "dashboard"],
    providerIds: ["*"],
    dataTypes: ["sleep"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["sleep", "dashboard"],
    mobileConsumers: ["sleep", "dashboard"],
  },
  {
    key: "recovery",
    label: "Recovery",
    outputPaths: [
      {
        path: "relational",
        sources: ["daily_metrics", "sleep_session", "activity"],
        cdcEvidence: [{ kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" }],
      },
      {
        path: "metric_stream",
        sources: ["metric_stream"],
        cdcEvidence: [{ kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" }],
      },
    ],
    analyticsModels: ["daily_recovery_inputs", "daily_recovery", "daily_strain"],
    cacheQueryFamilies: ["recovery", "stress", "dashboard"],
    providerIds: ["*"],
    dataTypes: ["activity", "daily_metrics", "sleep"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["recovery", "dashboard"],
    mobileConsumers: ["recovery", "dashboard"],
  },
  {
    key: "training",
    label: "Training",
    outputPaths: [
      {
        path: "relational",
        sources: ["activity", "daily_metrics"],
        cdcEvidence: [{ kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" }],
      },
      {
        path: "metric_stream",
        sources: ["metric_stream"],
        cdcEvidence: [{ kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" }],
      },
    ],
    analyticsModels: [
      "daily_endurance_load",
      "weekly_endurance_ramp_rate",
      "weekly_training_monotony",
      "healthspan_activity_zone_minutes",
      "weekly_healthspan",
    ],
    cacheQueryFamilies: ["training", "healthspan", "weeklyReport"],
    providerIds: ["*"],
    dataTypes: ["activity", "daily_metrics"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["training", "healthspan"],
    mobileConsumers: ["training", "healthspan"],
  },
  {
    key: "body",
    label: "Body",
    outputPaths: [
      {
        path: "metric_stream",
        sources: ["metric_stream"],
        cdcEvidence: [{ kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" }],
      },
    ],
    analyticsModels: ["body_measurement", "daily_body_measurement"],
    cacheQueryFamilies: ["body", "bodyAnalytics"],
    providerIds: ["*"],
    dataTypes: ["body", "body_measurement"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["body"],
    mobileConsumers: ["body"],
  },
  {
    key: "nutrition",
    label: "Nutrition",
    outputPaths: [
      {
        path: "relational",
        sources: [
          "food_entry",
          "food_entry_nutrient",
          "supplement_definition",
          "supplement_definition_nutrient",
          "supplement_dose_event",
        ],
        cdcEvidence: [],
      },
    ],
    analyticsModels: [],
    cacheQueryFamilies: ["food", "nutrition", "nutritionAnalytics"],
    providerIds: ["cronometer", "fatsecret"],
    dataTypes: ["nutrition"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["nutrition"],
    mobileConsumers: ["nutrition"],
  },
  {
    key: "providers",
    label: "Data sources",
    outputPaths: [
      {
        path: "relational",
        sources: [
          "provider",
          "provider_connection",
          "activity",
          "daily_metrics",
          "sleep_session",
          "food_entry",
          "health_event",
          "clinical_record",
          "journal_entry",
        ],
        cdcEvidence: [
          { kind: "peerdb_marker", flowName: "dofek_fitness_raw_analytics" },
          { kind: "peerdb_marker", flowName: "dofek_provider_inventory_raw_analytics" },
        ],
      },
      {
        path: "metric_stream",
        sources: ["metric_stream"],
        cdcEvidence: [{ kind: "clickhouse_sink_ack", sinkName: "metric_stream_clickhouse_sink" }],
      },
    ],
    analyticsModels: [
      "provider_metric_stream_daily",
      "provider_change_watermark",
      "provider_stats",
    ],
    cacheQueryFamilies: ["sync.providers", "providerDetail"],
    providerIds: ["*"],
    dataTypes: ["provider_inventory"],
    freshnessTargetMs: FIFTEEN_MINUTES_MS,
    webConsumers: ["providers", "provider-detail"],
    mobileConsumers: ["providers", "provider-detail"],
  },
] as const satisfies readonly DatasetContract[];

export function validateDatasetContracts(
  contracts: readonly DatasetContract[],
  productionModels: readonly string[],
): void {
  const assignmentCounts = new Map<string, number>();
  for (const contract of contracts) {
    const outputPaths = contract.outputPaths.map((outputPath) => outputPath.path);
    if (new Set(outputPaths).size !== outputPaths.length) {
      throw new Error(`Dataset ${contract.key} defines a duplicate output path`);
    }
    for (const model of contract.analyticsModels) {
      assignmentCounts.set(model, (assignmentCounts.get(model) ?? 0) + 1);
    }
  }

  const productionModelSet = new Set(productionModels);
  const missing = productionModels.filter((model) => !assignmentCounts.has(model));
  const unknown = [...assignmentCounts.keys()].filter((model) => !productionModelSet.has(model));
  const duplicate = [...assignmentCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([model]) => model);

  if (missing.length > 0 || unknown.length > 0 || duplicate.length > 0) {
    throw new Error(
      `Invalid dataset contracts: missing=[${missing.join(", ")}], unknown=[${unknown.join(", ")}], duplicate=[${duplicate.join(", ")}]`,
    );
  }
}

export function requiredCdcEvidence(
  contract: DatasetContract,
  emittedOutputPaths: readonly ProcessingOutputPath[],
): CdcEvidenceDependency[] {
  const emitted = new Set(emittedOutputPaths);
  return contract.outputPaths
    .filter((outputPath) => emitted.has(outputPath.path))
    .flatMap((outputPath) => outputPath.cdcEvidence);
}

export function datasetsForProvider(
  providerId: string,
  dataTypes: readonly string[],
): readonly DatasetContract[] {
  const emittedDataTypes = new Set(dataTypes);
  return DATASET_CONTRACTS.filter((contract) => {
    const providerIds = new Set<string>(contract.providerIds);
    return (
      (providerIds.has("*") || providerIds.has(providerId)) &&
      contract.dataTypes.some((dataType) => emittedDataTypes.has(dataType))
    );
  });
}

const PROVIDER_DATASET_CAPABILITIES: Readonly<Record<string, readonly ProcessingDatasetKey[]>> = {
  "amazfit-zepp": [
    "activity",
    "hiking",
    "cycling",
    "sleep",
    "recovery",
    "training",
    "body",
    "providers",
  ],
  "apple-health": [
    "activity",
    "hiking",
    "cycling",
    "sleep",
    "recovery",
    "training",
    "body",
    "nutrition",
    "providers",
  ],
  "auto-supplements": ["nutrition", "providers"],
  bodyspec: ["body", "providers"],
  concept2: ["activity", "training", "recovery", "providers"],
  coros: ["activity", "hiking", "cycling", "sleep", "recovery", "training", "body", "providers"],
  "cycling-analytics": ["cycling", "training", "providers"],
  decathlon: ["activity", "hiking", "cycling", "recovery", "training", "providers"],
  "eight-sleep": ["sleep", "recovery", "training", "providers"],
  fatsecret: ["nutrition", "providers"],
  fitbit: ["activity", "hiking", "cycling", "sleep", "recovery", "training", "body", "providers"],
  garmin: ["activity", "hiking", "cycling", "sleep", "recovery", "training", "body", "providers"],
  komoot: ["activity", "hiking", "cycling", "recovery", "training", "providers"],
  mapmyfitness: ["activity", "hiking", "cycling", "recovery", "training", "providers"],
  oura: ["activity", "sleep", "recovery", "training", "providers"],
  peloton: ["activity", "cycling", "recovery", "training", "providers"],
  polar: ["activity", "hiking", "cycling", "sleep", "recovery", "training", "providers"],
  "ride-with-gps": ["activity", "hiking", "cycling", "recovery", "training", "providers"],
  strava: ["activity", "hiking", "cycling", "recovery", "training", "providers"],
  suunto: ["activity", "hiking", "cycling", "sleep", "recovery", "training", "providers"],
  trainerroad: ["activity", "cycling", "recovery", "training", "providers"],
  ultrahuman: ["activity", "sleep", "recovery", "training", "providers"],
  velohero: ["activity", "cycling", "recovery", "training", "providers"],
  wahoo: ["activity", "hiking", "cycling", "recovery", "training", "providers"],
  wger: ["activity", "training", "providers"],
  whoop: ["activity", "sleep", "recovery", "training", "providers"],
  withings: ["activity", "sleep", "recovery", "training", "body", "providers"],
  xert: ["activity", "cycling", "recovery", "training", "providers"],
  zwift: ["activity", "cycling", "recovery", "training", "providers"],
};

export function processingDatasetKeysForProvider(
  providerId: string,
  declaredDatasetKeys?: readonly ProcessingDatasetKey[],
): readonly ProcessingDatasetKey[] {
  if (declaredDatasetKeys && declaredDatasetKeys.length > 0) {
    return declaredDatasetKeys;
  }
  return PROVIDER_DATASET_CAPABILITIES[providerId] ?? ["providers"];
}

const IMPORT_DATASET_CAPABILITIES: Readonly<Record<string, readonly ProcessingDatasetKey[]>> = {
  "apple-health": [
    "activity",
    "hiking",
    "cycling",
    "sleep",
    "recovery",
    "training",
    "body",
    "nutrition",
    "providers",
  ],
  "strong-csv": ["activity", "recovery", "training", "providers"],
  "cronometer-csv": ["nutrition", "providers"],
  "kaya-export": ["activity", "hiking", "recovery", "training", "providers"],
  "zos-app": ["activity", "recovery", "training", "providers"],
  "garmin-dump": [
    "activity",
    "hiking",
    "cycling",
    "sleep",
    "recovery",
    "training",
    "body",
    "providers",
  ],
  "fit-file": ["activity", "hiking", "cycling", "recovery", "training", "body", "providers"],
};

export function processingDatasetKeysForImport(
  importType: string,
): readonly ProcessingDatasetKey[] {
  return IMPORT_DATASET_CAPABILITIES[importType] ?? ["providers"];
}

export function processingDatasetKeysForOutputPath(
  datasetKeys: readonly ProcessingDatasetKey[],
  outputPath: ProcessingOutputPath,
): ProcessingDatasetKey[] {
  return datasetKeys.filter((datasetKey) =>
    DATASET_CONTRACTS.some(
      (contract) =>
        contract.key === datasetKey &&
        contract.outputPaths.some((candidate) => candidate.path === outputPath),
    ),
  );
}

validateDatasetContracts(DATASET_CONTRACTS, PRODUCTION_DBT_MODELS);
