import { type WhoopSensorSnapshot, whoopSensorRecordSchema } from "@dofek/providers/whoop-sensors";
import { z } from "zod";
import { dateWindowStartString, type RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { decodeWhoopSensorRecord } from "../services/whoop-sensor-decoder.ts";
import type { ActivitySensorQueryStore } from "./activity-sensor-types.ts";
import { healthSensorSamplesSql } from "./health-sensor-query.ts";

/** dbt decodes R18 frames; replayed measurements count once per device/timestamp. */
export function whoopSkinTemperatureSamplesCte(): string {
  return `whoop_skin_temperature_samples AS (
    SELECT recorded_at AS measured_at, source_name AS device_id, argMin(scalar, id) AS skin_temp_c
    FROM (${healthSensorSamplesSql("skin_temperature")})
    WHERE recorded_at <= now64(3) + INTERVAL 5 MINUTE
    GROUP BY recorded_at, source_name
  )`;
}

export function whoopTemperatureDailyCte(includeWindowStart: boolean): string {
  return `${whoopSkinTemperatureSamplesCte()}, temperature_sample_daily AS (
    SELECT toDate(toTimeZone(measured_at, {timezone:String})) AS date, 'whoop_ble' AS provider_id,
      device_id AS source_name, avg(skin_temp_c) AS skin_temp_c
    FROM whoop_skin_temperature_samples
    WHERE measured_at < toDateTime64(addDays(toDate({spo2EndDate:String}), 1), 3, {timezone:String})
      ${includeWindowStart ? "AND measured_at >= toDateTime64({spo2WindowStart:String}, 3, {timezone:String})" : ""}
    GROUP BY date, device_id
  )`;
}

const retainedRecordSchema = z.object({ deviceId: z.string(), metadata: z.string() });
const latestTemperatureSchema = z.object({
  skinTemperatureC: z.coerce.number(),
  measuredAt: timestampStringSchema,
});
const temperatureDailySchema = z.object({
  date: dateStringSchema,
  provider_id: z.string(),
  source_name: z.string(),
  skin_temp_c: z.coerce.number(),
});

export class WhoopSensorRepository {
  readonly #sensorStore: ActivitySensorQueryStore;
  readonly #userId: string;

  constructor(sensorStore: ActivitySensorQueryStore, userId: string) {
    this.#sensorStore = sensorStore;
    this.#userId = userId;
  }

  async snapshot(): Promise<WhoopSensorSnapshot> {
    const [rows, latest] = await Promise.all([
      this.#sensorStore.query(
        retainedRecordSchema,
        `SELECT device_id AS deviceId, metadata FROM ingest.metric_stream FINAL
         WHERE user_id = {userId:UUID} AND provider_id = 'whoop_ble'
           AND channel = 'sensor_record' AND is_deleted = 0
         ORDER BY recorded_at DESC, id DESC LIMIT 20`,
        { userId: this.#userId },
      ),
      this.#sensorStore.query(
        latestTemperatureSchema,
        `WITH ${whoopSkinTemperatureSamplesCte()}
         SELECT skin_temp_c AS skinTemperatureC,
           concat(replaceOne(toString(measured_at, 'UTC'), ' ', 'T'), 'Z') AS measuredAt
         FROM whoop_skin_temperature_samples ORDER BY measured_at DESC LIMIT 1`,
        { userId: this.#userId },
      ),
    ]);
    const records = rows.map((row) => ({
      ...decodeWhoopSensorRecord(whoopSensorRecordSchema.parse(JSON.parse(row.metadata))),
      deviceId: row.deviceId,
    }));
    return {
      latestReceivedAt: records[0]?.receivedAt ?? null,
      latestMeasuredAt: latest[0]?.measuredAt ?? null,
      skinTemperatureC: latest[0]?.skinTemperatureC ?? null,
      records,
    };
  }

  async dailyTemperatures(input: { days: RangeDays; endDate: string; timezone: string }) {
    return this.#sensorStore.query(
      temperatureDailySchema,
      `WITH ${whoopTemperatureDailyCte(input.days !== null)}
       SELECT toString(date) AS date, provider_id, source_name, skin_temp_c FROM temperature_sample_daily`,
      {
        userId: this.#userId,
        timezone: input.timezone,
        spo2EndDate: input.endDate,
        ...(input.days === null
          ? {}
          : { spo2WindowStart: dateWindowStartString(input.endDate, Math.max(0, input.days - 1)) }),
      },
    );
  }
}
