export type {
  WhoopAuthToken,
  WhoopCycle,
  WhoopExerciseDetails,
  WhoopHrValue,
  WhoopRecoveryRecord,
  WhoopRecoveryScore,
  WhoopSignInResult,
  WhoopSleepRecord,
  WhoopSleepScore,
  WhoopSleepStageSummary,
  WhoopWeightliftingExercise,
  WhoopWeightliftingGroup,
  WhoopWeightliftingSet,
  WhoopWeightliftingWorkoutResponse,
  WhoopWorkoutRecord,
  WhoopWorkoutScore,
  WhoopZoneDuration,
} from "whoop-whoop";
// Re-export whoop-whoop types and client for dofek consumers
export { parseDuringRange, WhoopClient, WhoopRateLimitError } from "whoop-whoop";
