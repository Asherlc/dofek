import {
  type CriticalPowerModel,
  computeNormalizedPower,
  computePowerCurve,
  DURATION_LABELS,
  fitCriticalPower,
  STANDARD_DURATIONS,
} from "@dofek/training/power-analysis";
import { CYCLING_ACTIVITY_TYPES } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { z } from "zod";
import { ChartRange } from "../lib/chart-range.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";

const CYCLING_TYPES: string[] = [...CYCLING_ACTIVITY_TYPES];

// ── Zod schemas ──────────────────────────────────────────────

const normalizedPowerRowSchema = z.object({
  activity_id: z.string(),
  activity_date: dateStringSchema,
  activity_name: z.string().nullable(),
  normalized_power: z.coerce.number(),
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
   * Reads from the pre-computed activity_power_curve read model when available,
   * falling back to raw sample fetch + client-side computation.
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
        model: fitCriticalPower(points),
      };
    }

    // Fall back to raw sample fetch + client-side computation
    const samples = await this.#sensorStore.getPowerCurveSamples(
      range.days,
      this.#userId,
      this.#timezone,
      CYCLING_TYPES,
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
  async getEftpTrend(range: ChartRange): Promise<{
    trend: { date: string; eftp: number; activityName: string | null }[];
    currentEftp: number | null;
    model: CriticalPowerModel | null;
  }> {
    if ((await this.#loadRawActivityCount(range)) === 0) {
      return { trend: [], currentEftp: null, model: null };
    }

    const rows = await this.#sensorStore.query(
      normalizedPowerRowSchema,
      `SELECT
        toString(activity_id) AS activity_id,
        toString(toDate(toTimeZone(started_at, {timezone:String}))) AS activity_date,
        name AS activity_name,
        round(normalized_power, 1) AS normalized_power
      FROM analytics.activity_summary
      WHERE user_id = {userId:UUID}
        ${range.clickHouseTimestampAfter("started_at")}
        AND normalized_power IS NOT NULL
        AND has({activityTypes:Array(String)}, canonical_type)
      ORDER BY started_at`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...range.clickHouseParams(),
        activityTypes: CYCLING_TYPES,
      },
    );

    const normalizedPowerRows =
      rows.length > 0
        ? rows.map((row) => ({
            activityDate: row.activity_date,
            activityName: row.activity_name,
            normalizedPower: row.normalized_power,
          }))
        : computeNormalizedPower(
            await this.#sensorStore.getNormalizedPowerSamples(
              range.days,
              this.#userId,
              this.#timezone,
              CYCLING_TYPES,
            ),
          );

    const trend = normalizedPowerRows.map((row) => ({
      date: row.activityDate,
      eftp: Math.round(row.normalizedPower * 0.95),
      activityName: row.activityName,
    }));

    // Compute current eFTP via CP model from last 90 days' power curve
    const { model } = await this.getPowerCurve(ChartRange.fromDays(90));

    // Fall back to 95% of best recent 20-min power if CP model can't fit
    let currentEftp: number | null = model?.cp ?? null;
    if (currentEftp == null) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90);
      const cutoffDate = cutoff.toISOString().slice(0, 10);
      const recent = trend.filter((entry) => entry.date >= cutoffDate);
      currentEftp = recent.length > 0 ? Math.max(...recent.map((entry) => entry.eftp)) : null;
    }

    return { trend, currentEftp, model };
  }

  async #loadRawActivityCount(range: ChartRange): Promise<number> {
    if (!this.#db) return 1;
    return activityRepositoryFor(this.#db, this.#userId).countVisibleInWindow({
      days: range.days,
      activityTypes: CYCLING_TYPES,
    });
  }
}
