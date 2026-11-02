import { type CriticalPowerModel, fitCriticalPower } from "@dofek/cycling-power/critical-power";
import { DURATION_LABELS, STANDARD_DURATIONS } from "@dofek/training/power-analysis";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import { cyclingCriticalPowerPolicy } from "dofek/analytics/cycling-power-policy";
import type { Database } from "dofek/db";
import { z } from "zod";
import {
  type AccessWindow,
  clickHouseAccessParams,
  clickHouseAccessPredicate,
} from "../billing/entitlement.ts";
import type { ChartRange } from "../lib/chart-range.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

const CYCLING_TYPES: string[] = [...CYCLING_ACTIVITY_TYPES];

// ── Zod schemas ──────────────────────────────────────────────

const trendRowSchema = z.object({
  date: dateStringSchema,
  eftp: z.coerce.number(),
  activityName: z.string().nullable(),
});

const powerCurvePointRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  best_power: z.coerce.number(),
  activity_date: dateStringSchema,
});

// ── Repository ───────────────────────────────────────────────

export class PowerRepository {
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: ActivitySensorStore;
  readonly #db: Pick<Database, "execute"> | undefined;

  constructor(
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
    db?: Pick<Database, "execute">,
  ) {
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
    this.#db = db;
  }

  /**
   * Power Duration Curve: best average power for standard durations.
   * Reads canonical elapsed-time evidence from activity_power_curve.
   */
  async getPowerCurve(range: ChartRange): Promise<{
    points: {
      durationSeconds: number;
      label: string;
      bestPower: number;
      activityDate: string;
    }[];
    model: CriticalPowerModel | null;
  }> {
    if ((await this.#loadRawActivityCount(range)) === 0) {
      return { points: [], model: null };
    }

    // Try pre-computed read model first (avoids expensive deduped_sensor scan)
    // Convert started_at to the user's timezone so the date matches what the
    // fallback (live) path returns — the stored activity_date is UTC-only.
    const readModelRows = await this.#sensorStore.query(
      powerCurvePointRowSchema,
      `SELECT
        power_curve.duration_seconds AS duration_seconds,
        power_curve.best_power AS best_power,
        toString(toDate(toTimeZone(power_curve.started_at, {timezone:String}))) AS activity_date
      FROM analytics.activity_power_curve AS power_curve FINAL
      INNER JOIN analytics.activity_summary AS activity_summary
        ON activity_summary.activity_id = power_curve.activity_id
       AND activity_summary.user_id = power_curve.user_id
      WHERE power_curve.user_id = {userId:UUID}
        AND power_curve.is_deleted = 0
        AND has({activityTypes:Array(String)}, activity_summary.canonical_type)
        ${range.clickHouseTimestampAfter("power_curve.started_at")}
      ORDER BY power_curve.duration_seconds`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...range.clickHouseParams(),
        activityTypes: CYCLING_TYPES,
      },
    );

    if (readModelRows.length > 0) {
      // Aggregate across activities: for each duration, find max best_power
      const byDuration = new Map<number, { bestPower: number; activityDate: string }>();
      for (const row of readModelRows) {
        const durationSeconds = Number(row.duration_seconds);
        const bestPower = Number(row.best_power);
        const prev = byDuration.get(durationSeconds);
        if (!prev || bestPower > prev.bestPower) {
          byDuration.set(durationSeconds, { bestPower, activityDate: String(row.activity_date) });
        }
      }

      const points = STANDARD_DURATIONS.flatMap((durationSeconds) => {
        const best = byDuration.get(durationSeconds);
        if (!best) return [];
        return [
          {
            durationSeconds,
            label: DURATION_LABELS[durationSeconds] ?? `${durationSeconds}s`,
            bestPower: best.bestPower,
            activityDate: best.activityDate,
          },
        ];
      });

      return {
        points,
        model: fitCriticalPower(points, cyclingCriticalPowerPolicy),
      };
    }

    return { points: [], model: null };
  }

  /** The displayed slice of ongoing history never changes the current threshold. */
  async getEftpTrend(range: ChartRange, accessWindow?: AccessWindow) {
    const [trend, currentEvidence] = await Promise.all([
      this.#sensorStore.query(
        trendRowSchema,
        `SELECT
        toString(toDate(toTimeZone(history.event_at, {timezone:String}))) AS date,
        history.eftp AS eftp, nullIf(activity.name, '') AS activityName
        FROM analytics.cycling_threshold_history AS history
        LEFT JOIN analytics.activity_summary AS activity
          ON activity.user_id = history.user_id AND activity.activity_id = history.activity_id
        WHERE history.user_id = {userId:UUID} AND history.eftp IS NOT NULL
          AND history.event_at <= now64(6)
          ${clickHouseAccessPredicate(accessWindow, "history.event_at")}
          ${range.clickHouseTimestampAfter("history.event_at")}
        ORDER BY history.event_at, ifNull(toString(history.activity_id), '')`,
        {
          userId: this.#userId,
          timezone: this.#timezone,
          ...range.clickHouseParams(),
          ...clickHouseAccessParams(accessWindow, this.#timezone),
        },
      ),
      new CyclingThresholdRepository(
        this.#sensorStore,
        this.#userId,
        this.#timezone,
        accessWindow,
      ).getCurrent(),
    ]);
    return { trend, currentEftp: currentEvidence.value, currentEvidence, model: null };
  }

  async #loadRawActivityCount(range: ChartRange): Promise<number> {
    if (!this.#db) return 1;
    return activityRepositoryFor(this.#db, this.#userId).countVisibleInWindow({
      days: range.days,
      activityTypes: CYCLING_TYPES,
    });
  }
}
