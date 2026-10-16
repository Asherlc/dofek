import { ACTIVITY_MODALITIES, CANONICAL_ACTIVITY_TYPES } from "@dofek/training/activity-types";
import { GRADE_SYSTEMS } from "@dofek/training/climbing-grades";
import {
  ATTEMPT_SCOPES,
  CLIMB_KINDS,
  CLIMB_SETTINGS,
  CLIMBING_DISCIPLINES,
  PROTECTION_STYLES,
  ROPE_METHODS,
} from "@dofek/training/climbing-log";
import { fitness } from "./core.ts";

// ============================================================
// Enums
// ============================================================

export const mealEnum = fitness.enum("meal", ["breakfast", "lunch", "dinner", "snack", "other"]);

export const nutritionEntryGrainEnum = fitness.enum("nutrition_entry_grain", [
  "itemized",
  "meal_aggregate",
  "daily_aggregate",
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

export const setTypeEnum = fitness.enum("set_type", [
  "working",
  "warmup",
  "dropset",
  "failure",
  "rest",
]);

export const climbKindEnum = fitness.enum("climb_kind", CLIMB_KINDS);
export const climbSettingEnum = fitness.enum("climb_setting", CLIMB_SETTINGS);
export const climbingDisciplineEnum = fitness.enum("climbing_discipline", CLIMBING_DISCIPLINES);
export const ropeMethodEnum = fitness.enum("rope_method", ROPE_METHODS);
export const protectionStyleEnum = fitness.enum("protection_style", PROTECTION_STYLES);
export const attemptScopeEnum = fitness.enum("attempt_scope", ATTEMPT_SCOPES);
export const gradeSystemEnum = fitness.enum("grade_system", GRADE_SYSTEMS);

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
