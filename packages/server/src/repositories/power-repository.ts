import { ENDURANCE_ACTIVITY_TYPES } from "@dofek/training/endurance-types";
import {
  type CriticalPowerModel,
  computePowerCurve,
  DURATION_LABELS,
  fitCriticalPower,
  STANDARD_DURATIONS,
} from "@dofek/training/power-analysis";
import type { Database } from "dofek/db";
import { z } from "zod";
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";

// ── Zod schemas ──────────────────────────────────────────────

const npRowSchema = z.object({
  activity_id: z.string(),
  activity_date: z.string(),
  activity_name: z.string().nullable(),
  np: z.coerce.number(),
});

const powerCurvePointRowSchema = z.object({
  duration_seconds: z.coerce.number(),
  best_power: z.coerce.number(),
  activity_date: z.string(),
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
   * Reads from the pre-computed activity_power_curve read model when available,
   * falling back to raw sample fetch + client-side computation.
   */
  async getPowerCurve(days: number): Promise<{
    points: {
      durationSeconds: number;
      label: string;
      bestPower: number;
      activityDate: string;
    }[];
    model: CriticalPowerModel | null;
  }> {
    if ((await this.#loadRawActivityCount(days)) === 0) {
      return { points: [], model: null };
    }

    // Try pre-computed read model first (avoids expensive deduped_sensor scan)
    const readModelRows = await this.#sensorStore.query(
      powerCurvePointRowSchema,
      `SELECT
        duration_seconds,
        best_power,
        activity_date
      FROM analytics.activity_power_curve FINAL
      WHERE user_id = {userId:UUID}
        AND is_deleted = 0
        AND started_at > now() - INTERVAL {days:Int32} DAY
      ORDER BY duration_seconds`,
      {
        userId: this.#userId,
        days,
      },
    );

    if (readModelRows.length > 0) {
      // Aggregate across activities: for each duration, find max best_power
      const byDuration = new Map<number, { bestPower: number; activityDate: string }>();
      for (const row of readModelRows) {
        const d = Number(row.duration_seconds);
        const p = Number(row.best_power);
        const prev = byDuration.get(d);
        if (!prev || p > prev.bestPower) {
          byDuration.set(d, { bestPower: p, activityDate: String(row.activity_date) });
        }
      }

      const points = STANDARD_DURATIONS.flatMap((d) => {
        const best = byDuration.get(d);
        if (!best) return [];
        return [{
          durationSeconds: d,
          label: DURATION_LABELS[d] ?? `${d}s`,
          bestPower: best.bestPower,
          activityDate: best.activityDate,
        }];
      });

      return {
        points,
        model: fitCriticalPower(points),
      };
    }

    // Fall back to raw sample fetch + client-side computation
    const samples = await this.#sensorStore.getPowerCurveSamples(
      days,
      this.#userId,
      this.#timezone,
    );

    const results = computePowerCurve(samples);

    return {
      points: results.map((result) => ({
        durationSeconds: result.durationSeconds,
        label: DURATION_LABELS[result.durationSeconds] ?? `${result.durationSeconds}s`,
        bestPower: result.bestPower,
        activityDate: result.activityDate,
      })),
      model: fitCriticalPower(results),
    };
  }

  /**
   * eFTP trend: estimated Functional Threshold Power over time.
   * Uses per-activity Normalized Power (NP) x 0.95.
   */
  async getEftpTrend(days: number): Promise<{
    trend: { date: string; eftp: number; activityName: string | null }[];
    currentEftp: number | null;
    model: CriticalPowerModel | null;
  }> {
    if ((await this.#loadRawActivityCount(days)) === 0) {
      return { trend: [], currentEftp: null, model: null };
    }

    const rows = await this.#sensorStore.query(
      npRowSchema,
      `SELECT
        toString(activity_id) AS activity_id,
        toString(toDate(toTimeZone(started_at, {timezone:String}))) AS activity_date,
        name AS activity_name,
        round(normalized_power, 1) AS np
      FROM analytics.activity_summary
      WHERE user_id = {userId:UUID}
        AND started_at > now() - INTERVAL {days:Int32} DAY
        AND normalized_power IS NOT NULL
        AND has({enduranceTypes:Array(String)}, activity_type)
      ORDER BY started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        days,
        enduranceTypes: [...ENDURANCE_ACTIVITY_TYPES],
      },
    );

    const trend = rows.map((row) => ({
      date: row.activity_date,
      eftp: Math.round(row.np * 0.95),
      activityName: row.activity_name,
    }));

    // Compute current eFTP via CP model from last 90 days' power curve
    const powerCurveSamples = await this.#sensorStore.getPowerCurveSamples(
      90,
      this.#userId,
      this.#timezone,
    );

    const powerCurveResults = computePowerCurve(powerCurveSamples);
    const model = fitCriticalPower(powerCurveResults);

    // Fall back to 95% of best recent 20-min power if CP model can't fit
    let currentEftp: number | null = model?.cp ?? null;
    if (currentEftp == null) {
      const recent = trend.filter((entry) => {
        const date = new Date(entry.date);
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        return date >= cutoff;
      });
      currentEftp = recent.length > 0 ? Math.max(...recent.map((entry) => entry.eftp)) : null;
    }

    return { trend, currentEftp, model };
  }

  async #loadRawActivityCount(days: number): Promise<number> {
    if (!this.#db) return 1;
    return activityRepositoryFor(this.#db, this.#userId).countVisibleInWindow({ days });
  }
}
