import { trace } from "@opentelemetry/api";
import type { z } from "zod";
import type { RangeDays } from "../lib/date-window.ts";
import { logger } from "../logger.ts";
import type {
  ActivitySensorQueryOptions,
  ActivitySensorStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-repository.ts";

const WEB_CLICKHOUSE_CONCURRENCY = 2;
const DASHBOARD_CLICKHOUSE_CONCURRENCY = 2;

type LimitedOperation<T> = () => Promise<T>;

const tracer = trace.getTracer("dofek-server");

class ClickHouseQueueLimiter {
  readonly #name: string;
  readonly #concurrency: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(name: string, concurrency: number) {
    this.#name = name;
    this.#concurrency = concurrency;
  }

  async run<T>(operation: LimitedOperation<T>): Promise<T> {
    await this.#waitForSlot();
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  async #waitForSlot(): Promise<void> {
    const queuedBeforeAcquire = this.#queue.length;
    const activeBeforeAcquire = this.#active;
    const waitStartedAt = performance.now();
    await tracer.startActiveSpan("clickhouse.queue_wait", async (span) => {
      try {
        span.setAttribute("clickhouse.queue.name", this.#name);
        span.setAttribute("clickhouse.queue.concurrency", this.#concurrency);
        span.setAttribute("clickhouse.queue.active", activeBeforeAcquire);
        span.setAttribute("clickhouse.queue.depth", queuedBeforeAcquire);
        await this.#acquire();
        const waitMs = performance.now() - waitStartedAt;
        span.setAttribute("clickhouse.queue.wait_ms", waitMs);
        logger.info("clickhouse.queue_wait", {
          active: activeBeforeAcquire,
          concurrency: this.#concurrency,
          depth: queuedBeforeAcquire,
          queue: this.#name,
          waitMs,
        });
      } finally {
        span.end();
      }
    });
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

export class LimitedActivitySensorStore implements ActivitySensorStore {
  readonly #delegate: ActivitySensorStore;
  readonly #inFlightQueries = new Map<string, Promise<unknown[]>>();
  readonly #regularLimiter: ClickHouseQueueLimiter;
  readonly #dashboardLimiter: ClickHouseQueueLimiter;

  constructor(
    delegate: ActivitySensorStore,
    concurrency = WEB_CLICKHOUSE_CONCURRENCY,
    dashboardConcurrency = DASHBOARD_CLICKHOUSE_CONCURRENCY,
  ) {
    this.#delegate = delegate;
    this.#regularLimiter = new ClickHouseQueueLimiter("regular", concurrency);
    this.#dashboardLimiter = new ClickHouseQueueLimiter("dashboard", dashboardConcurrency);
  }

  async query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params: Record<string, unknown> = {},
    options: ActivitySensorQueryOptions = {},
  ): Promise<z.infer<TSchema>[]> {
    const key = JSON.stringify([query, params, options.priority ?? null]);
    if (!options.abortSignal) {
      const existing = this.#inFlightQueries.get(key);
      if (existing) {
        const rows = await existing;
        return rows.map((row) => schema.parse(row));
      }
    }

    const limiter =
      options.priority === "dashboard" ? this.#dashboardLimiter : this.#regularLimiter;
    const promise = limiter.run(() => this.#delegate.query(schema, query, params, options));
    if (!options.abortSignal) {
      this.#inFlightQueries.set(key, promise);
    }
    try {
      return await promise;
    } finally {
      if (!options.abortSignal) {
        this.#inFlightQueries.delete(key);
      }
    }
  }

  getActivitySummaries(activityIds: string[]) {
    return this.#regularLimiter.run(() => this.#delegate.getActivitySummaries(activityIds));
  }

  getPowerCurveSamples(
    days: number | null,
    userId: string,
    timezone: string,
    activityTypes: readonly string[],
  ) {
    return this.#regularLimiter.run(() =>
      this.#delegate.getPowerCurveSamples(days, userId, timezone, activityTypes),
    );
  }

  getNormalizedPowerSamples(
    days: number | null,
    userId: string,
    timezone: string,
    activityTypes: readonly string[],
  ) {
    return this.#regularLimiter.run(() =>
      this.#delegate.getNormalizedPowerSamples(days, userId, timezone, activityTypes),
    );
  }

  getVo2MaxEstimates(endDate: string, days: number, userId: string, timezone: string) {
    return this.#regularLimiter.run(() =>
      this.#delegate.getVo2MaxEstimates(endDate, days, userId, timezone),
    );
  }

  getHeartRateCurveRows(days: RangeDays, userId: string, timezone: string) {
    return this.#regularLimiter.run(() =>
      this.#delegate.getHeartRateCurveRows(days, userId, timezone),
    );
  }

  getPaceCurveRows(days: RangeDays, userId: string, timezone: string) {
    return this.#regularLimiter.run(() => this.#delegate.getPaceCurveRows(days, userId, timezone));
  }

  getStream(window: ActivitySensorWindow, maxPoints: number): Promise<StreamPointRow[]> {
    return this.#regularLimiter.run(() => this.#delegate.getStream(window, maxPoints));
  }

  getHeartRateZoneSeconds(window: ActivitySensorWindow) {
    return this.#regularLimiter.run(() => this.#delegate.getHeartRateZoneSeconds(window));
  }

  getPowerZoneSeconds(window: ActivitySensorWindow, ftp: number) {
    return this.#regularLimiter.run(() => this.#delegate.getPowerZoneSeconds(window, ftp));
  }

  refreshBodyMeasurements() {
    return this.#regularLimiter.run(() => this.#delegate.refreshBodyMeasurements());
  }
}
