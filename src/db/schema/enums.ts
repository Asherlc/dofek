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

export const climbingGradeSystemEnum = fitness.enum("climbing_grade_system", ["v_scale", "yds"]);

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

export const labResultStatusEnum = fitness.enum("lab_result_status", [
  "final",
  "preliminary",
  "corrected",
  "cancelled",
]);

export const sleepStageNameEnum = fitness.enum("sleep_stage_name", [
  "deep",
  "light",
  "rem",
  "awake",
]);

export const activityTypeEnum = fitness.enum("activity_type", [
  // Cycling subtypes
  "cycling",
  "road_cycling",
  "mountain_biking",
  "gravel_cycling",
  "indoor_cycling",
  "virtual_cycling",
  "e_bike_cycling",
  "cyclocross",
  "track_cycling",
  "bmx",
  // Endurance
  "running",
  "trail_running",
  "swimming",
  "open_water_swimming",
  "walking",
  "hiking",
  // Strength / gym
  "strength",
  "strength_training",
  "functional_strength",
  "gym",
  // Mind / body
  "yoga",
  "pilates",
  "tai_chi",
  "mind_and_body",
  "meditation",
  "breathwork",
  "stretching",
  "flexibility",
  "barre",
  // Cardio / HIIT
  "elliptical",
  "rowing",
  "cardio",
  "hiit",
  "mixed_cardio",
  "mixed_metabolic_cardio",
  "stair_climbing",
  "stairmaster",
  "stairs",
  "step_training",
  "jump_rope",
  "fitness_gaming",
  // Cross training
  "cross_training",
  "bootcamp",
  "circuit_training",
  "functional_fitness",
  "core",
  "core_training",
  "boxing",
  "kickboxing",
  "martial_arts",
  "group_exercise",
  // Winter sports
  "skiing",
  "cross_country_skiing",
  "downhill_skiing",
  "snowboarding",
  "snow_sports",
  "snowshoeing",
  "skating",
  // Water sports
  "surfing",
  "kayaking",
  "sailing",
  "paddle_sports",
  "paddleboarding",
  "paddling",
  "water_fitness",
  "water_polo",
  "water_sports",
  "aqua_fitness",
  "underwater_diving",
  "diving",
  "snorkeling",
  // Racquet sports
  "tennis",
  "table_tennis",
  "squash",
  "racquetball",
  "badminton",
  "pickleball",
  "padel",
  "paddle_racquet",
  // Team sports
  "basketball",
  "soccer",
  "football",
  "american_football",
  "australian_football",
  "rugby",
  "hockey",
  "ice_hockey",
  "lacrosse",
  "baseball",
  "softball",
  "volleyball",
  "cricket",
  "handball",
  // Other sports
  "golf",
  "disc_golf",
  "climbing",
  "rock_climbing",
  "dance",
  "dancing",
  "cardio_dance",
  "social_dance",
  "triathlon",
  "multisport",
  "hand_cycling",
  "wheelchair_walk",
  "wheelchair_run",
  "disc_sports",
  // Outdoor / recreation
  "equestrian",
  "fencing",
  "fishing",
  "hunting",
  "gymnastics",
  "archery",
  "bowling",
  "curling",
  "wrestling",
  "track_and_field",
  "play",
  "navigation",
  "geocaching",
  // Air sports
  "skydiving",
  "paragliding",
  // Activity lifecycle
  "preparation_and_recovery",
  "cooldown",
  "transition",
  // Catch-all
  "other",
]);
