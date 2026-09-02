interface ClickHouseJsonResult<TRow> {
  json(): Promise<TRow[]>;
}

export interface ClickHouseQueryClient {
  query<TRow extends object>(options: {
    query: string;
    format: "JSONEachRow";
    query_params: Record<string, unknown>;
    abort_signal?: AbortSignal;
  }): Promise<ClickHouseJsonResult<TRow>>;
}

export interface PowerZoneSecondRow {
  zone: number;
  seconds: number;
}

export interface HeartRateZoneSecondRow {
  zone: number;
  seconds: number;
}

export interface PowerCurveSampleRow {
  activity_id: string;
  activity_date: string;
  power: number;
  interval_s: number;
}

export interface NormalizedPowerSampleRow {
  activity_id: string;
  activity_date: string;
  activity_name: string | null;
  power: number;
  interval_s: number;
}

export interface Vo2MaxEstimateRow {
  activity_id: string;
  activity_date: string;
  method: string;
  vo2max: number;
}
