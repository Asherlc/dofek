/** An event parsed from an incoming provider webhook payload. */
export interface WebhookEvent {
  /** Provider-specific owner/user ID (e.g., Strava athlete_id, Fitbit user_id). */
  ownerExternalId: string;
  /** What happened. */
  eventType: "create" | "update" | "delete";
  /** What kind of object changed (activity, sleep, body, etc.). */
  objectType: string;
  /** External ID of the changed object (if available). */
  objectId?: string;
  /**
   * Provider-specific metadata carried through to syncWebhookEvent().
   * Can include the full payload (Wahoo, Concept2, Suunto), a date (Fitbit),
   * a time range (Withings), or any other context needed for targeted sync.
   */
  metadata?: Record<string, unknown>;
}
