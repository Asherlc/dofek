import { averageVo2MaxEstimates, isValidVo2MaxEstimate } from "@dofek/training/derived-cardio";
import type { Database } from "dofek/db";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { fetchRestingHeartRateRows } from "./resting-heart-rate-query.ts";

type DerivedCardioSensorStore = Partial<Pick<ActivitySensorStore, "getVo2MaxEstimates" | "query">>;

export interface DerivedCardioContext {
  userId: string;
  timezone: string;
}

export interface DerivedVo2MaxAverage {
  value: number;
  sampleCount: number;
}

export interface DailyRestingHeartRate {
  date: string;
  restingHr: number;
}

export class DerivedCardioRepository {
  readonly #ctx: DerivedCardioContext;
  readonly #sensorStore?: DerivedCardioSensorStore;

  constructor(
    _db: Pick<Database, "execute">,
    ctx: DerivedCardioContext,
    sensorStore?: DerivedCardioSensorStore,
  ) {
    this.#ctx = ctx;
    this.#sensorStore = sensorStore;
  }

  async getVo2MaxAverage(endDate: string, days: number): Promise<DerivedVo2MaxAverage | null> {
    const sensorStore = this.#requireVo2MaxStore();
    const rows = await sensorStore.getVo2MaxEstimates(
      endDate,
      days,
      this.#ctx.userId,
      this.#ctx.timezone,
    );
    const estimates = rows.map((row) => row.vo2max);
    const value = averageVo2MaxEstimates(estimates);
    const sampleCount = estimates.filter(isValidVo2MaxEstimate).length;
    return value === null ? null : { value, sampleCount };
  }

  async getDailyRestingHeartRates(endDate: string, days: number): Promise<DailyRestingHeartRate[]> {
    const sensorStore = this.#requireQueryStore("resting heart rate");
    const rows = await fetchRestingHeartRateRows({
      sensorStore,
      userId: this.#ctx.userId,
      timezone: this.#ctx.timezone,
      endDate,
      days,
    });
    return rows.map((row) => ({ date: row.date, restingHr: Number(row.resting_hr) }));
  }

  async getAverageRestingHeartRate(endDate: string, days: number): Promise<number | null> {
    const rows = await this.getDailyRestingHeartRates(endDate, days);
    if (rows.length === 0) {
      return null;
    }
    return rows.reduce((sum, row) => sum + row.restingHr, 0) / rows.length;
  }

  #requireVo2MaxStore(): DerivedCardioSensorStore &
    Pick<ActivitySensorStore, "getVo2MaxEstimates"> {
    const getVo2MaxEstimates = this.#sensorStore?.getVo2MaxEstimates;
    if (!getVo2MaxEstimates) {
      throw new Error("VO2 max estimates require an activity sensor store");
    }
    return { ...this.#sensorStore, getVo2MaxEstimates };
  }

  #requireQueryStore(featureName: string): Pick<ActivitySensorStore, "query"> {
    const query = this.#sensorStore?.query;
    if (!query) {
      throw new Error(`ClickHouse activity analytics store is required for ${featureName}`);
    }
    return { query };
  }
}
