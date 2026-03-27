/**
 * Maps provider IDs to URL templates for deep-linking to specific activities.
 * The placeholder `{id}` is replaced with the activity's external ID.
 */
const ACTIVITY_URL_TEMPLATES: Record<string, string> = {
  strava: "https://www.strava.com/activities/{id}",
  garmin: "https://connect.garmin.com/modern/activity/{id}",
  wahoo: "https://cloud.wahoo.com/workouts/{id}",
  peloton: "https://members.onepeloton.com/classes/cycling?modal=classDetailsModal&classId={id}",
  polar: "https://flow.polar.com/training/analysis/{id}",
  zwift: "https://www.zwift.com/activity/{id}",
  fitbit: "https://www.fitbit.com/activities/exercise/{id}",
  komoot: "https://www.komoot.com/tour/{id}",
  suunto: "https://www.sports-tracker.com/workout/{id}",
  "ride-with-gps": "https://ridewithgps.com/trips/{id}",
  concept2: "https://log.concept2.com/results/{id}",
  "cycling-analytics": "https://www.cyclinganalytics.com/ride/{id}",
  cycling_analytics: "https://www.cyclinganalytics.com/ride/{id}",
  trainerroad: "https://www.trainerroad.com/app/cycling/rides/{id}",
  decathlon: "https://www.decathlon.com/sports-tracking/activity/{id}",
  "intervals.icu": "https://intervals.icu/activities/{id}",
  xert: "https://www.xertonline.com/activities/{id}",
  velohero: "https://app.velohero.com/workouts/show/{id}",
};

/**
 * Returns a deep link URL to view a specific activity on the provider's
 * website, or null if the provider doesn't support activity deep links
 * or the external ID is missing.
 */
export function activitySourceUrl(
  providerId: string,
  externalId: string | null | undefined,
): string | null {
  if (!externalId) return null;
  const template = ACTIVITY_URL_TEMPLATES[providerId];
  if (!template) return null;
  return template.replace("{id}", externalId);
}
