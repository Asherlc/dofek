import { estimateThreshold } from "@dofek/cycling-power/threshold";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { cyclingPowerSuggestionPolicy } from "dofek/analytics/cycling-power-policy";
import { z } from "zod";
import {
  type AccessWindow,
  clickHouseAccessParams,
  clickHouseAccessPredicate,
} from "../billing/entitlement.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { clickHouseActivityLocalDate } from "./activity-local-date.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const effortRowSchema = z.object({
  activity_id: z.string().uuid(),
  activity_date: dateStringSchema,
  duration_seconds: z.coerce.number().positive(),
  best_power: z.coerce.number().nonnegative(),
  activity_name: z.string().nullable(),
});

interface SuggestionEvidence {
  activity_id: string;
  activity_name: string | null;
  date: string;
  duration_seconds: number;
  power_watts: number;
}

export interface CyclingFtpSuggestionMethod {
  method: "reference_curves" | "95_percent_best_20_minute";
  suggested_ftp: number | null;
  evidence: SuggestionEvidence | null;
  limitations: string;
  unavailable_reason: string | null;
}

export interface CyclingFtpSuggestions {
  start_date: string;
  end_date: string;
  methods: CyclingFtpSuggestionMethod[];
}

const REFERENCE_LIMITATIONS =
  "A reference-curve estimate from recorded sustained power; easy or nonmaximal riding can underestimate FTP. This is not an exact Intervals.icu reproduction or an individually validated test.";
const TWENTY_MINUTE_LIMITATIONS =
  "95% of best 20-minute power is a training heuristic that requires a sufficiently hard, maximal effort; easy or nonmaximal riding can underestimate FTP.";
const NO_REFERENCE_EVIDENCE =
  "No in-range cycling power effort fits the retained reference-curve policy.";
const NO_TWENTY_MINUTE_EVIDENCE =
  "No in-range cycling power-duration observation is available at 20 minutes.";

/** Reads only bounded, precomputed activity power curves; it never writes settings. */
export class CyclingFtpSuggestionsRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #accessWindow: AccessWindow | undefined;

  constructor(
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
    accessWindow?: AccessWindow,
  ) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#accessWindow = accessWindow;
  }

  async getSuggestions(startDate: string, endDate: string): Promise<CyclingFtpSuggestions> {
    const activityDate = clickHouseActivityLocalDate("activity");
    const rows = await this.#store.query(
      effortRowSchema,
      `SELECT toString(power_curve.activity_id) AS activity_id,
        toString(${activityDate}) AS activity_date,
        power_curve.duration_seconds AS duration_seconds,
        power_curve.best_power AS best_power,
        nullIf(activity_summary.name, '') AS activity_name
      FROM analytics.activity_power_curve AS power_curve FINAL
      INNER JOIN analytics.deduped_activities AS activity FINAL
        ON activity.activity_id = power_curve.activity_id AND activity.user_id = power_curve.user_id
       AND activity.is_deleted = 0
      INNER JOIN analytics.activity_summary AS activity_summary
        ON activity_summary.activity_id = power_curve.activity_id
       AND activity_summary.user_id = power_curve.user_id
      WHERE power_curve.user_id = {userId:UUID}
        AND power_curve.is_deleted = 0
        AND lower(hex(SHA256(toString(power_curve.user_id)))) NOT IN (
          SELECT user_hash FROM ingest.account_erasure_fence FINAL
        )
        AND has({activityTypes:Array(String)}, activity_summary.canonical_type)
        AND ${activityDate} BETWEEN toDate({startDate:String}) AND toDate({endDate:String})
        AND power_curve.duration_seconds BETWEEN {minimumDuration:UInt32} AND {maximumDuration:UInt32}
        ${clickHouseAccessPredicate(this.#accessWindow, "power_curve.started_at")}
      ORDER BY power_curve.activity_id, power_curve.duration_seconds, power_curve.best_power DESC`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        startDate,
        endDate,
        minimumDuration: cyclingPowerSuggestionPolicy.thresholdPolicy.minimumDurationSeconds,
        maximumDuration: cyclingPowerSuggestionPolicy.thresholdPolicy.maximumDurationSeconds,
        activityTypes: [...CYCLING_ACTIVITY_TYPES],
        ...clickHouseAccessParams(this.#accessWindow, this.#timezone),
      },
    );

    const referenceCandidate = estimateThreshold(
      rows.map((row) => ({ durationSeconds: row.duration_seconds, watts: row.best_power })),
      cyclingPowerSuggestionPolicy.referenceCurves,
      cyclingPowerSuggestionPolicy.thresholdPolicy,
    );
    const referenceWatts = referenceCandidate ? Math.round(referenceCandidate.watts) : null;
    const referenceEffort = referenceCandidate
      ? rows.find(
          (row) =>
            row.duration_seconds === referenceCandidate.effort.durationSeconds &&
            row.best_power === referenceCandidate.effort.watts,
        )
      : undefined;
    const twentyMinuteEffort = rows
      .filter((row) => row.duration_seconds === 1200 && row.best_power > 0)
      .sort(
        (left, right) =>
          right.best_power - left.best_power || left.activity_id.localeCompare(right.activity_id),
      )[0];
    const twentyMinuteWatts = twentyMinuteEffort
      ? Math.round(twentyMinuteEffort.best_power * 0.95)
      : null;
    const usableReference = referenceWatts != null && referenceWatts > 0;
    const usableTwentyMinute = twentyMinuteWatts != null && twentyMinuteWatts > 0;
    return {
      start_date: startDate,
      end_date: endDate,
      methods: [
        {
          method: "reference_curves",
          suggested_ftp: usableReference ? referenceWatts : null,
          evidence: usableReference && referenceEffort ? toEvidence(referenceEffort) : null,
          limitations: REFERENCE_LIMITATIONS,
          unavailable_reason: usableReference ? null : NO_REFERENCE_EVIDENCE,
        },
        {
          method: "95_percent_best_20_minute",
          suggested_ftp: usableTwentyMinute ? twentyMinuteWatts : null,
          evidence:
            usableTwentyMinute && twentyMinuteEffort ? toEvidence(twentyMinuteEffort) : null,
          limitations: TWENTY_MINUTE_LIMITATIONS,
          unavailable_reason: usableTwentyMinute ? null : NO_TWENTY_MINUTE_EVIDENCE,
        },
      ],
    };
  }
}

function toEvidence(row: z.infer<typeof effortRowSchema>): SuggestionEvidence {
  return {
    activity_id: row.activity_id,
    activity_name: row.activity_name,
    date: row.activity_date,
    duration_seconds: row.duration_seconds,
    power_watts: row.best_power,
  };
}
