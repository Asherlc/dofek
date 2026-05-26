import type { z } from "zod";
import type {
  ActivitySensorStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-repository.ts";

const WEB_CLICKHOUSE_CONCURRENCY = 1;

type LimitedOperation<T> = () => Promise<T>;

export class LimitedActivitySensorStore implements ActivitySensorStore {
  readonly #delegate: ActivitySensorStore;
  readonly #concurrency: number;
  readonly #inFlightQueries = new Map<string, Promise<unknown[]>>();
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(delegate: ActivitySensorStore, concurrency = WEB_CLICKHOUSE_CONCURRENCY) {
    this.#delegate = delegate;
    this.#concurrency = concurrency;
  }

  async query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params: Record<string, unknown> = {},
  ): Promise<z.infer<TSchema>[]> {
    const key = JSON.stringify([query, params]);
    const existing = this.#inFlightQueries.get(key);
    if (existing) {
      const rows = await existing;
      return rows.map((row) => schema.parse(row));
    }

    const promise = this.#runLimited(() => this.#delegate.query(schema, query, params));
    this.#inFlightQueries.set(
      key,
      promise.then((rows): unknown[] => rows),
    );
    try {
      return await promise;
    } finally {
      this.#inFlightQueries.delete(key);
    }
  }

  getActivitySummaries(activityIds: string[]) {
    return this.#runLimited(() => this.#delegate.getActivitySummaries(activityIds));
  }

  getPowerCurveSamples(days: number, userId: string, timezone: string) {
    return this.#runLimited(() => this.#delegate.getPowerCurveSamples(days, userId, timezone));
  }

  getNormalizedPowerSamples(days: number, userId: string, timezone: string) {
    return this.#runLimited(() => this.#delegate.getNormalizedPowerSamples(days, userId, timezone));
  }

  getVo2MaxEstimates(endDate: string, days: number, userId: string, timezone: string) {
    return this.#runLimited(() =>
      this.#delegate.getVo2MaxEstimates(endDate, days, userId, timezone),
    );
  }

  getHeartRateCurveRows(days: number, userId: string, timezone: string) {
    return this.#runLimited(() => this.#delegate.getHeartRateCurveRows(days, userId, timezone));
  }

  getPaceCurveRows(days: number, userId: string, timezone: string) {
    return this.#runLimited(() => this.#delegate.getPaceCurveRows(days, userId, timezone));
  }

  getStream(window: ActivitySensorWindow, maxPoints: number): Promise<StreamPointRow[]> {
    return this.#runLimited(() => this.#delegate.getStream(window, maxPoints));
  }

  getHeartRateZoneSeconds(window: ActivitySensorWindow, maxHr: number, restingHr: number) {
    return this.#runLimited(() => this.#delegate.getHeartRateZoneSeconds(window, maxHr, restingHr));
  }

  getPowerZoneSeconds(window: ActivitySensorWindow, ftp: number) {
    return this.#runLimited(() => this.#delegate.getPowerZoneSeconds(window, ftp));
  }

  refreshBodyMeasurements() {
    return this.#runLimited(() => this.#delegate.refreshBodyMeasurements());
  }

  async #runLimited<T>(operation: LimitedOperation<T>): Promise<T> {
    await this.#acquire();
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) {
      next();
      return;
    }
    this.#active -= 1;
  }
}
