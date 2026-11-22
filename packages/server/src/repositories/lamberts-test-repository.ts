import type { Database } from "dofek/db";
import { lambertsFitDurationSeconds, lambertsFitSegments } from "dofek/fit/lamberts-workout";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import {
  lambertsTestProtocol,
  type lambertsTestResultSchema,
} from "../mcp/cycling-training-metrics-output.ts";
import type { ActivitySensorQueryStore } from "./activity-sensor-types.ts";
import type { CyclingEffortSample } from "./cycling-effort-metrics.ts";
import { calculateLambertsTestResults } from "./lamberts-test-results.ts";

const testRowSchema = z.object({
  activity_id: z.uuid(),
  source_activity_id: z.uuid(),
  source_provider: z.string(),
  source_name: z.string().nullable(),
  date: dateStringSchema,
  started_at: timestampStringSchema,
  modality: z.string().nullable(),
  source_providers: z.array(z.string()),
  configured_maximum: z.number().positive().nullable().catch(null),
});

const sensorRowSchema = z.object({
  activity_id: z.uuid(),
  elapsed_seconds: z.number(),
  channel: z.enum(["power", "heart_rate", "cadence", "speed"]),
  scalar: z.number().nullable(),
  provider_id: z.string().nullable(),
  device_id: z.string().nullable(),
  measurement_kind: z.enum(["direct", "estimated", "unknown"]),
});

type TestRow = z.infer<typeof testRowSchema>;
type SensorRow = z.infer<typeof sensorRowSchema>;
type RangeResult = z.infer<typeof lambertsTestResultSchema>;
type TestResult = RangeResult["tests"][number];

interface RangeInput {
  startDate: string;
  endDate: string;
  modalities: string[];
  providers: string[];
  cursor: string | null;
  limit: number;
}

const channelField = {
  power: "powerWatts",
  heart_rate: "heartRateBpm",
  cadence: "cadenceRpm",
  speed: "speedMetersPerSecond",
} as const;

function describeTest(row: TestRow, sensorRows: SensorRow[]): TestResult {
  const samples = sensorRows.map<CyclingEffortSample>((sample) => ({
    elapsedSeconds: sample.elapsed_seconds,
    [channelField[sample.channel]]: sample.scalar,
  }));
  return {
    activity_id: row.activity_id,
    source_activity_id: row.source_activity_id,
    source_provider: row.source_provider,
    source_name: row.source_name,
    date: row.date,
    started_at: row.started_at,
    modality: row.modality,
    source_providers: row.source_providers,
    source_devices: [...new Set(sensorRows.flatMap(({ device_id }) => device_id || []))].sort(),
    sample_source_providers: [
      ...new Set(sensorRows.flatMap(({ provider_id }) => provider_id || [])),
    ].sort(),
    power_measurement_kinds: [
      ...new Set(
        sensorRows.flatMap(({ channel, measurement_kind, scalar }) =>
          channel === "power" && scalar !== null ? [measurement_kind] : [],
        ),
      ),
    ].sort(),
    heart_rate_maximum: {
      configured_bpm: row.configured_maximum,
      measurement_method: "unknown",
    },
    ...calculateLambertsTestResults(samples),
  };
}

function comparisonAnchor(test: TestResult) {
  return {
    activity_id: test.activity_id,
    date: test.date,
    started_at: test.started_at,
    stage_2_mean_power_watts: test.stages[1]?.mean_power_watts ?? null,
    stage_3_mean_power_watts: test.stages[2]?.mean_power_watts ?? null,
  };
}

function wattsChange(first: number | null, last: number | null): number | null {
  return first === null || last === null ? null : last - first;
}

/** Read recorded test identity from Postgres and bounded canonical sensor windows from ClickHouse. */
export class LambertsTestRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #store: ActivitySensorQueryStore;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(
    db: Pick<Database, "execute">,
    store: ActivitySensorQueryStore,
    userId: string,
    timezone: string,
  ) {
    this.#db = db;
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async #eligibleTests(input: RangeInput): Promise<TestRow[]> {
    const modalities = sql.param(input.modalities);
    const providers = sql.param(input.providers);
    const segments = sql.param(lambertsFitSegments);
    return executeWithSchema(
      this.#db,
      testRowSchema,
      sql`
        WITH matched_members AS (
          SELECT
            g.id AS activity_id,
            member.id AS source_activity_id,
            member.provider_id AS source_provider,
            member.source_name,
            g.modality,
            g.source_providers,
            min(segment.started_at) FILTER (WHERE segment.segment_type = 'lsct_stage_1') AS started_at,
            (array_agg(segment.raw ORDER BY segment.interval_index))[1]
              -> 'fitZonesTarget' -> 'max_heart_rate' AS configured_maximum
          FROM fitness.v_activity_group AS g
          INNER JOIN fitness.activity AS member
            ON member.id = ANY(g.member_activity_ids) AND member.user_id = g.user_id
          INNER JOIN fitness.activity_interval AS segment
            ON segment.activity_id = member.id AND segment.source_activity_id = member.id
            AND segment.source_provider = member.provider_id
          WHERE g.user_id = ${this.#userId}::uuid
            AND g.canonical_type = 'cycling'
            AND member.provider_absent_at IS NULL AND member.deleted_at IS NULL
            AND segment.source_kind = 'provider_recorded'
            AND segment.segment_type = ANY(${segments}::text[])
            AND (cardinality(${modalities}::text[]) = 0 OR g.modality::text = ANY(${modalities}::text[]))
            AND (cardinality(${providers}::text[]) = 0 OR g.source_providers && ${providers}::text[])
          GROUP BY g.id, member.id, g.modality, g.source_providers
          HAVING array_agg(segment.segment_type ORDER BY segment.interval_index) = ${segments}::text[]
            AND bool_or(segment.segment_type = 'lsct_stage_1'
                AND jsonb_typeof(segment.raw -> 'fitWorkout' -> 'wkt_name') = 'string')
        ), one_per_group AS (
          SELECT DISTINCT ON (activity_id) *
          FROM matched_members
          WHERE activity_id NOT IN (
            SELECT activity_id FROM matched_members
            GROUP BY activity_id HAVING min(started_at) <> max(started_at)
          )
          ORDER BY activity_id, source_activity_id
        )
        SELECT activity_id, source_activity_id, source_provider, source_name, started_at,
          to_char(started_at AT TIME ZONE ${this.#timezone}::text, 'YYYY-MM-DD') AS date,
          modality, source_providers, configured_maximum
        FROM one_per_group
        WHERE (started_at AT TIME ZONE ${this.#timezone}::text)::date
          BETWEEN ${input.startDate}::date AND ${input.endDate}::date
        ORDER BY started_at DESC, activity_id ASC
      `,
    );
  }

  async #sensorWindows(rows: TestRow[]): Promise<Map<string, SensorRow[]>> {
    const sensorWindows = new Map<string, SensorRow[]>();
    if (rows.length === 0) return sensorWindows;
    const activityIds = rows.map((row) => row.activity_id);
    const sensors = await this.#store.query(
      sensorRowSchema,
      `SELECT
          toString(sensor.activity_id) AS activity_id,
          dateDiff('millisecond', windows.started_at, sensor.recorded_at) / 1000 AS elapsed_seconds,
          sensor.channel, sensor.scalar, sensor.provider_id, sensor.device_id, sensor.measurement_kind
        FROM analytics.activity_sensor_sample AS sensor FINAL
        INNER JOIN (
          SELECT pair.1 AS activity_id, parseDateTime64BestEffort(pair.2, 6, 'UTC') AS started_at
          FROM (
            SELECT arrayJoin(arrayZip({activityIds:Array(UUID)}, {testStarts:Array(String)})) AS pair
          )
        ) AS windows ON sensor.activity_id = windows.activity_id
        WHERE sensor.user_id = {userId:UUID}
          AND sensor.activity_id IN {activityIds:Array(UUID)}
          AND sensor.is_deleted = 0
          AND sensor.channel IN ('power', 'heart_rate', 'cadence', 'speed')
          AND sensor.recorded_at >= windows.started_at
          AND sensor.recorded_at < windows.started_at + toIntervalSecond({duration:UInt16})`,
      {
        activityIds,
        testStarts: rows.map((row) => row.started_at),
        userId: this.#userId,
        duration: lambertsFitDurationSeconds,
      },
    );
    for (const sensor of sensors) {
      const window = sensorWindows.get(sensor.activity_id) ?? [];
      window.push(sensor);
      sensorWindows.set(sensor.activity_id, window);
    }
    return sensorWindows;
  }

  async listRange(input: RangeInput): Promise<RangeResult> {
    const eligible = await this.#eligibleTests(input);
    const cursorIndex = eligible.findIndex((test) => test.activity_id === input.cursor);
    if (input.cursor !== null && cursorIndex === -1)
      throw new Error("Invalid Lamberts test cursor");
    const start = cursorIndex + 1;
    const page = eligible.slice(start, start + input.limit);
    const latest = eligible[0];
    const earliest = eligible.at(-1);
    const anchors = earliest && latest && earliest !== latest ? [earliest, latest] : [];
    const selected = [...new Set([...page, ...anchors])];
    const sensors = await this.#sensorWindows(selected);
    const results = selected.map((row) => describeTest(row, sensors.get(row.activity_id) ?? []));
    const first = results.find((test) => test.activity_id === anchors[0]?.activity_id);
    const last = results.find((test) => test.activity_id === anchors[1]?.activity_id);
    let comparison: RangeResult["comparison"] = null;
    if (first && last) {
      const earliest = comparisonAnchor(first);
      const latest = comparisonAnchor(last);
      comparison = {
        earliest,
        latest,
        stage_2_mean_watts_change: wattsChange(
          earliest.stage_2_mean_power_watts,
          latest.stage_2_mean_power_watts,
        ),
        stage_3_mean_watts_change: wattsChange(
          earliest.stage_3_mean_power_watts,
          latest.stage_3_mean_power_watts,
        ),
      };
    }
    return {
      protocol: lambertsTestProtocol,
      range: { start_date: input.startDate, end_date: input.endDate, timezone: this.#timezone },
      total_tests: eligible.length,
      tests: results.slice(0, page.length),
      next_cursor:
        start + page.length < eligible.length ? (page.at(-1)?.activity_id ?? null) : null,
      comparison,
    };
  }
}
