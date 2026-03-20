// Re-export the full public API so external imports from "./apple-health" keep working.

export { getStringAttrs, parseHealthDate } from "./dates.ts";
export {
  ALL_ROUTED_TYPES,
  aggregateSpO2ToDailyMetrics,
  BODY_MEASUREMENT_TYPES,
  DAILY_METRIC_TYPES,
  linkUnassignedHeartRateToActivities,
  METRIC_STREAM_TYPES,
  NUTRITION_TYPES,
  upsertBodyMeasurementBatch,
  upsertDailyMetricsBatch,
  upsertHealthEventBatch,
  upsertMetricStreamBatch,
  upsertNutritionBatch,
  upsertSleepBatch,
  upsertWorkoutBatch,
} from "./db-insertion.ts";
export {
  buildPanelMap,
  type FhirCodeableConcept,
  type FhirDiagnosticReport,
  type FhirObservation,
  fhirResourceSchema,
  type ParsedLabResult,
  parseFhirObservation,
  VALID_LAB_STATUSES,
} from "./fhir.ts";
export {
  buildSourceNameMap,
  defaultConsoleProgress,
  extractExportXml,
  findLatestExport,
  importAppleHealthFile,
  importClinicalRecords,
  readZipEntries,
  runImport,
} from "./import.ts";
export { AppleHealthProvider } from "./provider.ts";
export {
  type CategoryRecord,
  type HealthRecord,
  parseCategoryRecord,
  parseRecord,
  parseRouteLocation,
  type RouteLocation,
} from "./records.ts";
export {
  parseSleepAnalysis,
  SLEEP_STAGE_MAP,
  type SleepAnalysisRecord,
  type SleepStage,
} from "./sleep.ts";
export { type ProgressInfo, type StreamCallbacks, streamHealthExport } from "./streaming.ts";
export {
  type ActivitySummary,
  enrichWorkoutFromStats,
  type HealthWorkout,
  normalizeDistance,
  normalizeDuration,
  parseActivitySummary,
  parseWorkout,
  parseWorkoutStatistics,
  WORKOUT_TYPE_MAP,
  type WorkoutStatistics,
} from "./workouts.ts";
