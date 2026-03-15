/**
 * Garmin Connect activity type key → normalized sport type.
 * Sourced from the activityType.typeKey field in activity search results.
 */
export const GARMIN_CONNECT_SPORT_MAP: Record<string, string> = {
  // Running
  running: "running",
  trail_running: "running",
  treadmill_running: "running",
  track_running: "running",
  ultra_running: "running",
  virtual_run: "running",
  // Cycling
  cycling: "cycling",
  mountain_biking: "cycling",
  road_biking: "cycling",
  indoor_cycling: "cycling",
  gravel_cycling: "cycling",
  virtual_ride: "cycling",
  bmx: "cycling",
  cyclocross: "cycling",
  recumbent_cycling: "cycling",
  e_bike_mountain: "cycling",
  e_bike_fitness: "cycling",
  // Swimming
  lap_swimming: "swimming",
  open_water_swimming: "swimming",
  // Walking / hiking
  walking: "walking",
  hiking: "hiking",
  casual_walking: "walking",
  speed_walking: "walking",
  // Strength / gym
  strength_training: "strength",
  indoor_cardio: "cardio",
  fitness_equipment: "cardio",
  stair_climbing: "cardio",
  // Yoga / flexibility
  yoga: "yoga",
  pilates: "pilates",
  breathwork: "breathwork",
  // Water sports
  rowing: "rowing",
  indoor_rowing: "rowing",
  kayaking: "kayaking",
  stand_up_paddleboarding: "paddleboarding",
  surfing: "surfing",
  whitewater_rafting: "rowing",
  // Winter sports
  resort_skiing_snowboarding_ws: "skiing",
  cross_country_skiing_ws: "skiing",
  backcountry_skiing_snowboarding_ws: "skiing",
  skate_skiing_ws: "skiing",
  snowshoeing_ws: "snowshoeing",
  ice_skating: "skating",
  // Racket sports
  tennis: "tennis",
  table_tennis: "tennis",
  badminton: "badminton",
  pickleball: "pickleball",
  racquetball: "racquetball",
  squash: "squash",
  padel: "padel",
  // Team sports
  soccer: "soccer",
  basketball: "basketball",
  volleyball: "volleyball",
  american_football: "football",
  rugby: "rugby",
  cricket: "cricket",
  hockey: "hockey",
  lacrosse: "lacrosse",
  softball: "softball",
  baseball: "baseball",
  // Climbing
  bouldering: "climbing",
  indoor_climbing: "climbing",
  // Other
  elliptical: "elliptical",
  triathlon: "triathlon",
  multi_sport: "multisport",
  transition: "transition",
  golf: "golf",
  horseback_riding: "horseback_riding",
  hunting: "hunting",
  fishing: "fishing",
  skating: "skating",
  inline_skating: "skating",
  disc_golf: "disc_golf",
  jumpmaster: "skydiving",
  sky_diving: "skydiving",
  wingsuit_flying: "skydiving",
  paragliding: "paragliding",
  hang_gliding: "paragliding",
  diving: "diving",
  snorkeling: "snorkeling",
  navigate: "navigation",
  geocaching: "geocaching",
  other: "other",
};

/**
 * Map a Garmin Connect activityType.typeKey to a normalized sport type.
 */
export function mapGarminConnectSport(typeKey: string): string {
  return GARMIN_CONNECT_SPORT_MAP[typeKey] ?? "other";
}
