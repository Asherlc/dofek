export const OTHER_ACTIVITY_TYPE = "__other__";

// ============================================================
// Canonical activity types
// ============================================================

/**
 * Superset of all valid internal activity types across all providers.
 * Providers map their domain-specific types to one of these canonical values.
 */
export const CANONICAL_ACTIVITY_TYPES = [
  "cycling",
  "running",
  "swimming",
  "walking",
  "hiking",
  "strength",
  "strength_training",
  "functional_strength",
  "yoga",
  "pilates",
  "elliptical",
  "rowing",
  "skiing",
  "skating",
  "climbing",
  "cardio",
  "hiit",
  "cross_training",
  "mountain_biking",
  "trail_running",
  "stair_climbing",
  "stairmaster",
  "cross country skiing",
  "group exercise",
  "stretching",
  "dance",
  "martial arts",
  "tennis",
  "basketball",
  "soccer",
  "golf",
  "ice hockey",
  "snowboarding",
  "rock climbing",
  "surfing",
  "kayaking",
  "functional fitness",
  "bootcamp",
  "boxing",
  "core",
  "aqua fitness",
  "circuit training",
  "triathlon",
  "dancing",
  // Apple Health granular types
  "american_football",
  "archery",
  "australian_football",
  "badminton",
  "baseball",
  "bowling",
  "cricket",
  "curling",
  "equestrian",
  "fencing",
  "fishing",
  "gymnastics",
  "handball",
  "hockey",
  "hunting",
  "lacrosse",
  "mind_and_body",
  "mixed_cardio",
  "paddle_sports",
  "play",
  "preparation_and_recovery",
  "racquetball",
  "rugby",
  "sailing",
  "snow_sports",
  "softball",
  "squash",
  "table_tennis",
  "track_and_field",
  "volleyball",
  "water_fitness",
  "water_polo",
  "water_sports",
  "wrestling",
  "barre",
  "core_training",
  "flexibility",
  "jump_rope",
  "kickboxing",
  "stairs",
  "step_training",
  "wheelchair_walk",
  "wheelchair_run",
  "tai_chi",
  "mixed_metabolic_cardio",
  "hand_cycling",
  "disc_sports",
  "fitness_gaming",
  "cardio_dance",
  "social_dance",
  "paddle_racquet",
  "cooldown",
  "transition",
  "underwater_diving",
  "cross_country_skiing",
  "downhill_skiing",
  "other",
] as const;

// ============================================================
// Endurance activity types
// ============================================================

/**
 * Activity types considered "endurance" for training analysis.
 * Used to filter endurance-tab queries (HR zones, polarization, ramp rate, etc.)
 * so that strength training, yoga, etc. don't skew intensity metrics.
 */
export const ENDURANCE_ACTIVITY_TYPES = [
  "cycling",
  "running",
  "swimming",
  "walking",
  "hiking",
] as const;

// ============================================================
// Activity type mapper factory
// ============================================================

/**
 * Creates a mapping function from provider-specific types to canonical types.
 * Unknown provider types default to "other".
 */
export function createActivityTypeMapper<K extends string | number>(
  providerMappings: Record<K, string>,
): (providerType: K) => string {
  return (providerType: K): string => {
    return providerMappings[providerType] ?? "other";
  };
}

// ============================================================
// Provider-specific mapping constants
// ============================================================

/** Strava sport_type → canonical activity type */
export const STRAVA_ACTIVITY_TYPE_MAP: Record<string, string> = {
  Ride: "cycling",
  VirtualRide: "cycling",
  MountainBikeRide: "cycling",
  GravelRide: "cycling",
  EBikeRide: "cycling",
  Run: "running",
  VirtualRun: "running",
  TrailRun: "running",
  Walk: "walking",
  Hike: "hiking",
  Swim: "swimming",
  WeightTraining: "strength",
  Yoga: "yoga",
  Rowing: "rowing",
  Canoeing: "rowing",
  Kayaking: "rowing",
  Elliptical: "elliptical",
  NordicSki: "skiing",
  AlpineSki: "skiing",
  BackcountrySki: "skiing",
  Snowboard: "skiing",
  IceSkate: "skating",
  RollerSki: "skiing",
  Crossfit: "strength",
  RockClimbing: "climbing",
};

/** Wahoo workout_type_id (numeric) → canonical activity type */
export const WAHOO_WORKOUT_TYPE_MAP: Record<number, string> = {
  0: "cycling",
  1: "running",
  2: "running", // treadmill
  3: "cycling", // indoor cycling
  4: "cycling", // mountain biking
  5: "cycling", // gravel
  6: "swimming",
  7: "yoga",
  8: "walking",
  9: "hiking",
  10: "rowing",
  11: "strength",
  12: "elliptical",
  13: "skiing",
};

/** Polar sport (lowercased) → canonical activity type */
export const POLAR_SPORT_MAP: Record<string, string> = {
  running: "running",
  cycling: "cycling",
  swimming: "swimming",
  walking: "walking",
  hiking: "hiking",
  strength_training: "strength",
  yoga: "yoga",
  pilates: "pilates",
  cross_country_skiing: "cross country skiing",
  rowing: "rowing",
  elliptical: "elliptical",
  mountain_biking: "mountain_biking",
  trail_running: "trail_running",
  cross_training: "cross_training",
  group_exercise: "group exercise",
  stretching: "stretching",
  dance: "dance",
  martial_arts: "martial arts",
  tennis: "tennis",
  basketball: "basketball",
  soccer: "soccer",
  golf: "golf",
  ice_hockey: "ice hockey",
  skiing: "skiing",
  snowboarding: "snowboarding",
  skating: "skating",
  rock_climbing: "rock climbing",
  surfing: "surfing",
  kayaking: "kayaking",
  functional_training: "functional fitness",
  bootcamp: "bootcamp",
  boxing: "boxing",
  core: "core",
  aqua_fitness: "aqua fitness",
  circuit_training: "circuit training",
  triathlon: "triathlon",
  indoor_cycling: "cycling",
  indoor_rowing: "rowing",
  indoor_running: "running",
  indoor_walking: "walking",
  treadmill_running: "running",
  stair_climbing: "stairmaster",
};

/** Garmin activityType → canonical activity type */
export const GARMIN_ACTIVITY_TYPE_MAP: Record<string, string> = {
  // Running
  RUNNING: "running",
  TRAIL_RUNNING: "running",
  TREADMILL_RUNNING: "running",
  TRACK_RUNNING: "running",
  // Cycling
  CYCLING: "cycling",
  MOUNTAIN_BIKING: "cycling",
  ROAD_BIKING: "cycling",
  INDOOR_CYCLING: "cycling",
  GRAVEL_CYCLING: "cycling",
  VIRTUAL_RIDE: "cycling",
  // Swimming
  SWIMMING: "swimming",
  LAP_SWIMMING: "swimming",
  OPEN_WATER_SWIMMING: "swimming",
  // Walking / Hiking
  WALKING: "walking",
  HIKING: "hiking",
  // Strength / Cardio
  STRENGTH_TRAINING: "strength",
  INDOOR_CARDIO: "cardio",
  // Other fitness
  YOGA: "yoga",
  PILATES: "pilates",
  ELLIPTICAL: "elliptical",
  ROWING: "rowing",
};

/** Oura activity (lowercased) → canonical activity type */
export const OURA_ACTIVITY_TYPE_MAP: Record<string, string> = {
  walking: "walking",
  running: "running",
  cycling: "cycling",
  swimming: "swimming",
  hiking: "hiking",
  yoga: "yoga",
  elliptical: "elliptical",
  rowing: "rowing",
  strength_training: "strength",
  weight_training: "strength",
  dancing: "dancing",
  pilates: "pilates",
  indoor_cycling: "cycling",
  stairmaster: "stairmaster",
  other: "other",
};

/** RideWithGPS activity_type → canonical activity type */
export const RIDE_WITH_GPS_ACTIVITY_TYPE_MAP: Record<string, string> = {
  cycling: "cycling",
  mountain_biking: "cycling",
  road_cycling: "cycling",
  gravel_cycling: "cycling",
  cyclocross: "cycling",
  track_cycling: "cycling",
  running: "running",
  trail_running: "running",
  walking: "walking",
  hiking: "hiking",
  swimming: "swimming",
};

/** Apple Health HKWorkoutActivityType → normalized lowercase name */
export const APPLE_HEALTH_WORKOUT_TYPE_MAP: Record<string, string> = {
  HKWorkoutActivityTypeAmericanFootball: "american_football",
  HKWorkoutActivityTypeArchery: "archery",
  HKWorkoutActivityTypeAustralianFootball: "australian_football",
  HKWorkoutActivityTypeBadminton: "badminton",
  HKWorkoutActivityTypeBaseball: "baseball",
  HKWorkoutActivityTypeBasketball: "basketball",
  HKWorkoutActivityTypeBowling: "bowling",
  HKWorkoutActivityTypeBoxing: "boxing",
  HKWorkoutActivityTypeClimbing: "climbing",
  HKWorkoutActivityTypeCricket: "cricket",
  HKWorkoutActivityTypeCrossCountrySkiing: "cross_country_skiing",
  HKWorkoutActivityTypeCrossTraining: "cross_training",
  HKWorkoutActivityTypeCurling: "curling",
  HKWorkoutActivityTypeCycling: "cycling",
  HKWorkoutActivityTypeDance: "dance",
  HKWorkoutActivityTypeDownhillSkiing: "downhill_skiing",
  HKWorkoutActivityTypeElliptical: "elliptical",
  HKWorkoutActivityTypeEquestrianSports: "equestrian",
  HKWorkoutActivityTypeFencing: "fencing",
  HKWorkoutActivityTypeFishing: "fishing",
  HKWorkoutActivityTypeFunctionalStrengthTraining: "functional_strength",
  HKWorkoutActivityTypeGolf: "golf",
  HKWorkoutActivityTypeGymnastics: "gymnastics",
  HKWorkoutActivityTypeHandball: "handball",
  HKWorkoutActivityTypeHiking: "hiking",
  HKWorkoutActivityTypeHockey: "hockey",
  HKWorkoutActivityTypeHunting: "hunting",
  HKWorkoutActivityTypeLacrosse: "lacrosse",
  HKWorkoutActivityTypeMartialArts: "martial_arts",
  HKWorkoutActivityTypeMindAndBody: "mind_and_body",
  HKWorkoutActivityTypeMixedCardio: "mixed_cardio",
  HKWorkoutActivityTypePaddleSports: "paddle_sports",
  HKWorkoutActivityTypePlay: "play",
  HKWorkoutActivityTypePreparationAndRecovery: "preparation_and_recovery",
  HKWorkoutActivityTypeRacquetball: "racquetball",
  HKWorkoutActivityTypeRowing: "rowing",
  HKWorkoutActivityTypeRugby: "rugby",
  HKWorkoutActivityTypeRunning: "running",
  HKWorkoutActivityTypeSailing: "sailing",
  HKWorkoutActivityTypeSkatingSports: "skating",
  HKWorkoutActivityTypeSnowSports: "snow_sports",
  HKWorkoutActivityTypeSoccer: "soccer",
  HKWorkoutActivityTypeSoftball: "softball",
  HKWorkoutActivityTypeSquash: "squash",
  HKWorkoutActivityTypeStairClimbing: "stair_climbing",
  HKWorkoutActivityTypeSurfingSports: "surfing",
  HKWorkoutActivityTypeSwimming: "swimming",
  HKWorkoutActivityTypeTableTennis: "table_tennis",
  HKWorkoutActivityTypeTennis: "tennis",
  HKWorkoutActivityTypeTrackAndField: "track_and_field",
  HKWorkoutActivityTypeTraditionalStrengthTraining: "strength_training",
  HKWorkoutActivityTypeVolleyball: "volleyball",
  HKWorkoutActivityTypeWalking: "walking",
  HKWorkoutActivityTypeWaterFitness: "water_fitness",
  HKWorkoutActivityTypeWaterPolo: "water_polo",
  HKWorkoutActivityTypeWaterSports: "water_sports",
  HKWorkoutActivityTypeWrestling: "wrestling",
  HKWorkoutActivityTypeYoga: "yoga",
  HKWorkoutActivityTypeBarre: "barre",
  HKWorkoutActivityTypeCoreTraining: "core_training",
  HKWorkoutActivityTypeFlexibility: "flexibility",
  HKWorkoutActivityTypeHighIntensityIntervalTraining: "hiit",
  HKWorkoutActivityTypeJumpRope: "jump_rope",
  HKWorkoutActivityTypeKickboxing: "kickboxing",
  HKWorkoutActivityTypePilates: "pilates",
  HKWorkoutActivityTypeSnowboarding: "snowboarding",
  HKWorkoutActivityTypeStairs: "stairs",
  HKWorkoutActivityTypeStepTraining: "step_training",
  HKWorkoutActivityTypeWheelchairWalkPace: "wheelchair_walk",
  HKWorkoutActivityTypeWheelchairRunPace: "wheelchair_run",
  HKWorkoutActivityTypeTaiChi: "tai_chi",
  HKWorkoutActivityTypeMixedMetabolicCardioTraining: "mixed_metabolic_cardio",
  HKWorkoutActivityTypeHandCycling: "hand_cycling",
  HKWorkoutActivityTypeDiscSports: "disc_sports",
  HKWorkoutActivityTypeFitnessGaming: "fitness_gaming",
  HKWorkoutActivityTypeCardioDance: "cardio_dance",
  HKWorkoutActivityTypeSocialDance: "social_dance",
  HKWorkoutActivityTypePickleball: "paddle_racquet",
  HKWorkoutActivityTypeCooldown: "cooldown",
  HKWorkoutActivityTypeSwimBikeRun: "triathlon",
  HKWorkoutActivityTypeTransition: "transition",
  HKWorkoutActivityTypeUnderwaterDiving: "underwater_diving",
  HKWorkoutActivityTypeOther: "other",
};

export interface WeeklyVolumeChartRow {
  week: string;
  activity_type: string;
  count: number;
  hours: number;
}

export interface DailyLoadRow {
  date: string;
  dailyLoad: number;
}

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  cycling: "Cycling",
  running: "Running",
  trail_running: "Trail Running",
  walking: "Walking",
  hiking: "Hiking",
  swimming: "Swimming",
  rowing: "Rowing",
  yoga: "Yoga",
  pilates: "Pilates",
  elliptical: "Elliptical",
  strength: "Strength",
  strength_training: "Strength Training",
  functional_strength: "Functional Strength",
  mountain_biking: "Mountain Biking",
  stair_climbing: "Stair Climbing",
  cross_training: "Cross Training",
  hiit: "HIIT",
  cardio: "Cardio",
  other: "Other",
};

function toTitleCase(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === "hiit") return "HIIT";
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function normalizeActivityType(activityType: string): string {
  const normalized = activityType.trim().toLowerCase();
  if (normalized === OTHER_ACTIVITY_TYPE || normalized === "other") {
    return OTHER_ACTIVITY_TYPE;
  }
  return normalized;
}

export function formatActivityTypeLabel(activityType: string): string {
  const normalized = normalizeActivityType(activityType);
  if (normalized === OTHER_ACTIVITY_TYPE) {
    return "Other";
  }
  return ACTIVITY_TYPE_LABELS[normalized] ?? toTitleCase(normalized);
}

export function collapseWeeklyVolumeActivityTypes(
  rows: WeeklyVolumeChartRow[],
  maxLegendItems = 6,
): WeeklyVolumeChartRow[] {
  if (rows.length === 0) return rows;

  const normalizedRows = rows.map((row) => ({
    ...row,
    activity_type: normalizeActivityType(row.activity_type),
  }));

  const totalsByType = new Map<string, number>();
  for (const row of normalizedRows) {
    totalsByType.set(row.activity_type, (totalsByType.get(row.activity_type) ?? 0) + row.hours);
  }

  const orderedTypes = [...totalsByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type]) => type);

  const shouldCollapse = orderedTypes.length > maxLegendItems;
  const keepTypes = shouldCollapse
    ? new Set(orderedTypes.slice(0, Math.max(0, maxLegendItems - 1)))
    : new Set(orderedTypes);

  const aggregated = new Map<string, WeeklyVolumeChartRow>();
  for (const row of normalizedRows) {
    const groupedType = keepTypes.has(row.activity_type) ? row.activity_type : OTHER_ACTIVITY_TYPE;
    const key = `${row.week}::${groupedType}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += row.count;
      existing.hours += row.hours;
      continue;
    }
    aggregated.set(key, {
      week: row.week,
      activity_type: groupedType,
      count: row.count,
      hours: row.hours,
    });
  }

  return [...aggregated.values()].sort((a, b) => {
    if (a.week !== b.week) return a.week.localeCompare(b.week);
    return a.activity_type.localeCompare(b.activity_type);
  });
}

/**
 * Pick the daily load row to display in "current strain" UI.
 * If the latest day is a rest day (0 load), fall back to the most recent
 * day with positive load so recent training is still represented.
 */
export function selectRecentDailyLoad<T extends DailyLoadRow>(rows: T[]): T | null {
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];
  if (latest == null) return null;
  if (Number.isFinite(latest.dailyLoad) && latest.dailyLoad > 0) return latest;

  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const row = rows[index];
    if (row != null && Number.isFinite(row.dailyLoad) && row.dailyLoad > 0) {
      return row;
    }
  }

  return latest;
}
