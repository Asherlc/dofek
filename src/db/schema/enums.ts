import { ACTIVITY_MODALITIES, CANONICAL_ACTIVITY_TYPES } from "@dofek/training/activity-types";
import { fitness } from "./core.ts";

// ============================================================
// Enums
// ============================================================

export const mealEnum = fitness.enum("meal", ["breakfast", "lunch", "dinner", "snack", "other"]);

export const nutritionEntryGrainEnum = fitness.enum("nutrition_entry_grain", [
  "itemized",
  "daily_aggregate",
]);

export const supplementDoseStatusEnum = fitness.enum("supplement_dose_status", [
  "planned",
  "taken",
  "skipped",
  "unknown",
]);

export const foodCategoryEnum = fitness.enum("food_category", [
  // FatSecret standard categories
  "beans_and_legumes",
  "beverages",
  "breads_and_cereals",
  "cheese_milk_and_dairy",
  "eggs",
  "fast_food",
  "fish_and_seafood",
  "fruit",
  "meat",
  "nuts_and_seeds",
  "pasta_rice_and_noodles",
  "salads",
  "sauces_spices_and_spreads",
  "snacks",
  "soups",
  "sweets_candy_and_desserts",
  "vegetables",
  // Custom categories
  "supplement",
  "other",
]);

export const setTypeEnum = fitness.enum("set_type", ["working", "warmup", "dropset", "failure"]);

export const climbingClimbTypeEnum = fitness.enum("climbing_climb_type", ["boulder", "route"]);

export const climbingGradeSystemEnum = fitness.enum("climbing_grade_system", [
  "v_scale",
  "font",
  "yds",
  "french",
  "uiaa",
  "ewbank",
  "saxon",
  "norwegian",
  "brazilian_crux",
]);

export const fingerLoadingExerciseEnum = fitness.enum("finger_loading_exercise", [
  "max_hang",
  "repeater",
  "min_edge",
  "one_arm",
  "campus",
  "no_hang",
]);

export const fingerLoadingGripPositionEnum = fitness.enum("finger_loading_grip_position", [
  "half_crimp",
  "full_crimp",
  "open_hand",
  "three_finger_drag",
  "two_finger_pocket",
]);

export const fingerLoadingLateralityEnum = fitness.enum("finger_loading_laterality", [
  "both",
  "left",
  "right",
]);

export const climbingHoldTypeEnum = fitness.enum("climbing_hold_type", [
  "crimp",
  "sloper",
  "pinch",
  "pocket",
  "jug",
]);

export const climbingAttemptOutcomeEnum = fitness.enum("climbing_attempt_outcome", [
  "sent",
  "failed",
]);

export const climbingFailureReasonEnum = fitness.enum("climbing_failure_reason", [
  "fell",
  "pumped",
  "skin",
  "technique",
  "fear",
]);

export const sleepStageNameEnum = fitness.enum("sleep_stage_name", [
  "deep",
  "light",
  "rem",
  "awake",
]);

export const canonicalActivityTypeEnum = fitness.enum(
  "canonical_activity_type",
  CANONICAL_ACTIVITY_TYPES,
);

export const activityModalityEnum = fitness.enum("activity_modality", ACTIVITY_MODALITIES);
