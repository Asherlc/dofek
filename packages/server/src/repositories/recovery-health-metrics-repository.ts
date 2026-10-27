import type { ActivitySensorStore } from "./activity-repository.ts";
import type { DailyMetricsRepository } from "./daily-metrics-repository.ts";
import { fetchRestingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

function inclusiveDays(startDate: string, endDate: string): number {
  return (
    Math.round(
      (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1
  );
}

/** Daily health metrics with resting HR calculated from canonical deduplicated samples. */
export class RecoveryHealthMetricsRepository {
  readonly #dailyMetrics: Pick<DailyMetricsRepository, "listRange">;
  readonly #sensorStore: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(
    dailyMetrics: Pick<DailyMetricsRepository, "listRange">,
    sensorStore: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
  ) {
    this.#dailyMetrics = dailyMetrics;
    this.#sensorStore = sensorStore;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async listRange(startDate: string, endDate: string) {
    const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
      sensorStore: this.#sensorStore,
      userId: this.#userId,
      timezone: this.#timezone,
      endDate,
      days: inclusiveDays(startDate, endDate),
    });
    return this.#dailyMetrics.listRange(startDate, endDate, restingHeartRateCte);
  }
}
