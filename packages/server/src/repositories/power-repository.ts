import {
  type CriticalPowerModel,
  computeNormalizedPower,
  computePowerCurve,
  DURATION_LABELS,
  fitCriticalPower,
} from "@dofek/training/power-analysis";
import type { ActivitySensorStore } from "./activity-repository.ts";

// ── Repository ───────────────────────────────────────────────

export class PowerRepository {
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore: ActivitySensorStore;

  constructor(userId: string, timezone: string, sensorStore: ActivitySensorStore) {
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  /**
   * Power Duration Curve: best average power for standard durations.
   * Fetches raw samples then computes via prefix sums in app code.
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
    const normalizedPowerSamples = await this.#sensorStore.getNormalizedPowerSamples(
      days,
      this.#userId,
      this.#timezone,
    );

    const normalizedPowerResults = computeNormalizedPower(normalizedPowerSamples);

    const trend = normalizedPowerResults.map((result) => ({
      date: result.activityDate,
      eftp: Math.round(result.normalizedPower * 0.95),
      activityName: result.activityName,
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
}
