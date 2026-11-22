import { z } from "zod";
import {
  type AccessWindow,
  clickHouseAccessParams,
  clickHouseAccessPredicate,
} from "../billing/entitlement.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  type DirectWeightObservation,
  MAX_NEARBY_WEIGHT_DAYS,
  selectNearbyWeight,
  type UnavailableWeightEvidence,
  type WeightEvidence,
} from "./nearby-weight.ts";

const weightRowSchema = z.object({
  date: z.string(),
  recorded_at: z.string(),
  weight_kg: z.coerce.number(),
  provider_id: z.string(),
  external_id: z.string().nullable(),
  record_id: z.uuid().optional(),
});

/** Select body-weight evidence near a local calendar date from canonical measurements. */
export async function loadDirectWeightObservations(
  store: Pick<ActivitySensorStore, "query">,
  userId: string,
  timezone: string,
  startDate: string,
  endDate: string,
  options?: { includeRecordId?: boolean; accessWindow?: AccessWindow },
): Promise<DirectWeightObservation[]> {
  const access = clickHouseAccessPredicate(options?.accessWindow, "body.recorded_at");
  const rows = await store.query(
    weightRowSchema,
    `/* nearby-weight:observations */
      SELECT
        toString(toDate(toTimeZone(body.recorded_at, {timezone:String}))) AS date,
        formatDateTime(body.recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
        body.weight_kg,
        body.provider_id,
        body.external_id${options?.includeRecordId ? ", toString(body.id) AS record_id" : ""}
      FROM analytics.v_body_measurement AS body
      WHERE body.user_id = {userId:UUID}
        AND body.weight_kg IS NOT NULL
        AND body.weight_kg > 0${access ? `\n        ${access}` : ""}
        AND toDate(toTimeZone(body.recorded_at, {timezone:String})) BETWEEN
          addDays(toDate({startDate:String}), -${MAX_NEARBY_WEIGHT_DAYS})
          AND addDays(toDate({endDate:String}), ${MAX_NEARBY_WEIGHT_DAYS})
      ORDER BY body.recorded_at ASC
      SETTINGS prefer_column_name_to_alias = 1`,
    {
      userId,
      timezone,
      startDate,
      endDate,
      ...clickHouseAccessParams(options?.accessWindow, timezone),
    },
  );
  return rows.map((row) => ({
    date: row.date,
    recordedAt: row.recorded_at,
    valueKg: row.weight_kg,
    observationType: "body_weight",
    measurementKind: "direct",
    provider: row.provider_id,
    sourceRecordId: row.external_id,
    ...(row.record_id ? { recordId: row.record_id } : {}),
  }));
}

export class NearbyWeightRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(store: Pick<ActivitySensorStore, "query">, userId: string, timezone: string) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async getForDate(date: string): Promise<WeightEvidence | UnavailableWeightEvidence> {
    const observations = await loadDirectWeightObservations(
      this.#store,
      this.#userId,
      this.#timezone,
      date,
      date,
    );
    return selectNearbyWeight(date, observations);
  }
}
