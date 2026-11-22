import { ACTIVITY_MODALITIES } from "@dofek/training/activity-types";
import { summarizeCyclingDecoupling } from "@dofek/training/cycling-decoupling";
import { resampleCyclingStream } from "@dofek/training/cycling-workout-metrics";
import { cyclingPowerCoveragePolicy } from "dofek/analytics/cycling-power-policy";
import { z } from "zod";
import {
  type AccessWindow,
  clickHouseAccessParams,
  clickHouseAccessPredicate,
} from "../billing/entitlement.ts";
import type { ChartRange } from "../lib/chart-range.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import { clickHouseActivityLocalDate } from "./activity-local-date.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const candidateSchema = z.object({
  activityId: z.string(),
  name: z.string().nullable(),
  modality: z.enum(ACTIVITY_MODALITIES).nullable(),
  date: dateStringSchema,
  startedAt: z.string(),
  endedAt: z.string(),
  elapsedSeconds: z.number(),
  identities: z.array(z.tuple([z.string(), z.string()])),
  memberIds: z.array(z.string()),
});

const sampleSchema = z.object({
  activityId: z.string(),
  elapsedSeconds: z.number(),
  channel: z.enum(["power", "heart_rate"]),
  scalar: z.number().nullable(),
  measurementKind: z.string(),
  providerId: z.string().nullable(),
  memberId: z.string().nullable(),
});

const halfSchema = z.object({
  pairedSeconds: z.number(),
  meanWatts: z.number().nullable(),
  meanBpm: z.number().nullable(),
  coveragePct: z.number(),
});

const measurementKindSchema = z.enum(["direct", "unknown"]);
const rideSchema = candidateSchema
  .pick({
    activityId: true,
    name: true,
    date: true,
    elapsedSeconds: true,
    modality: true,
  })
  .extend({
    percent: z.number(),
    firstHalf: halfSchema,
    secondHalf: halfSchema,
    method: z.literal("equal_elapsed_time_halves_power_to_heart_rate"),
    powerMeasurementKind: measurementKindSchema,
    heartRateMeasurementKind: measurementKindSchema,
  });

export const cyclingDecouplingOutputSchema = z.object({
  workoutName: z.string().nullable(),
  rides: z.array(rideSchema),
});

type Ride = z.infer<typeof rideSchema>;
type Sample = z.infer<typeof sampleSchema>;

function calculateRide(
  { activityId, name, date, elapsedSeconds, modality }: z.infer<typeof candidateSchema>,
  samples: Sample[],
  estimatedMembers: Set<string>,
): Ride | null {
  if (
    samples.some(
      (sample) =>
        sample.measurementKind === "estimated" ||
        (sample.channel === "power" &&
          sample.providerId === "strava" &&
          sample.memberId !== null &&
          estimatedMembers.has(sample.memberId)),
    )
  )
    return null;
  const resample = (channel: Sample["channel"]) =>
    resampleCyclingStream(
      samples.filter((sample) => sample.channel === channel),
      elapsedSeconds,
      (sample) => (channel === "heart_rate" && sample.scalar === 0 ? null : sample.scalar),
      cyclingPowerCoveragePolicy,
    ).values;
  const { percent, firstHalf, secondHalf, method } = summarizeCyclingDecoupling(
    resample("power"),
    resample("heart_rate"),
  );
  if (percent === null) return null;
  const measurementKind = (channel: Sample["channel"]) =>
    samples.some((sample) => sample.channel === channel && sample.measurementKind !== "direct")
      ? "unknown"
      : "direct";

  return rideSchema.parse({
    activityId,
    name,
    date,
    elapsedSeconds,
    modality,
    percent,
    firstHalf,
    secondHalf,
    method,
    powerMeasurementKind: measurementKind("power"),
    heartRateMeasurementKind: measurementKind("heart_rate"),
  });
}

export class CyclingDecouplingRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #accessWindow: AccessWindow | undefined;

  constructor(
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
    accessWindow?: AccessWindow,
  ) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#accessWindow = accessWindow;
  }

  async getTrend(range: ChartRange): Promise<z.infer<typeof cyclingDecouplingOutputSchema>> {
    const date = clickHouseActivityLocalDate("a");
    const candidates = await this.#store.query(
      candidateSchema,
      `
      WITH activities AS (
        SELECT a.activity_id, a.started_at, a.ended_at, a.name, a.modality, a.member_activity_ids,
          ${date} AS local_date
        FROM analytics.deduped_activities AS a FINAL
        WHERE a.user_id = {userId:UUID} AND a.is_deleted = 0 AND a.canonical_type = 'cycling'
          AND a.ended_at >= addSeconds(a.started_at, 1200)
          AND ${date} <= toDate(now(), {timezone:String})
          ${range.clickHouseDateAfterEndDate({ expression: date, endDateExpression: "toDate(now(), {timezone:String})" })}
          ${clickHouseAccessPredicate(this.#accessWindow, "a.started_at")}
      ),
      identities AS (
        SELECT DISTINCT canonical_activity_id, namespace, value
        FROM analytics.activity_effort_identity AS i FINAL
        WHERE user_id = {userId:UUID} AND is_deleted = 0
          AND kind = 'provider_workout' AND strength = 'exact'
          AND namespace != '' AND value != ''
          AND (canonical_activity_id, source_activity_id) IN (
            SELECT activity_id, arrayJoin(member_activity_ids) FROM activities
          )
      ),
      repeated AS (
        SELECT namespace, value
        FROM identities
        GROUP BY namespace, value
        HAVING count() >= 2
      ),
      matched AS (
        SELECT canonical_activity_id, arraySort(groupArray((namespace, value))) AS identities
        FROM identities
        WHERE (namespace, value) IN (SELECT namespace, value FROM repeated)
        GROUP BY canonical_activity_id
      )
      SELECT toString(a.activity_id) AS activityId, a.name AS name, a.modality AS modality,
        toString(a.local_date) AS date, toString(a.started_at, 'UTC') AS startedAt,
        toString(a.ended_at, 'UTC') AS endedAt,
        toInt32(intDiv(dateDiff('microsecond', a.started_at, a.ended_at), 1000000)) AS elapsedSeconds,
        matched.identities AS identities, a.member_activity_ids AS memberIds
      FROM activities AS a
      INNER JOIN matched ON matched.canonical_activity_id = a.activity_id
      ORDER BY a.started_at DESC, a.activity_id DESC
      LIMIT 25`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        ...range.clickHouseParams(),
        ...clickHouseAccessParams(this.#accessWindow, this.#timezone),
      },
      { priority: "dashboard" },
    );
    const empty = { workoutName: null, rides: [] };
    if (candidates.length < 2) return empty;

    const estimatedMembers = await this.#store.query(
      z.object({ id: z.string() }),
      `
      SELECT toString(activity_id) AS id
      FROM analytics.activity_source_records FINAL
      WHERE user_id = {userId:UUID} AND is_deleted = 0 AND provider_id = 'strava'
        AND activity_id IN {memberIds:Array(UUID)}
        AND JSONExtractRaw(coalesce(raw, ''), 'device_watts') = 'false'`,
      {
        userId: this.#userId,
        memberIds: [...new Set(candidates.flatMap((ride) => ride.memberIds))],
      },
      { priority: "dashboard" },
    );
    const excludedMembers = new Set(estimatedMembers.map(({ id }) => id));

    const samples = await this.#store.query(
      sampleSchema,
      `
      WITH indexOf({activityIds:Array(UUID)}, activity_id) AS candidateIndex,
        parseDateTime64BestEffort({starts:Array(String)}[candidateIndex], 6, 'UTC') AS activityStart,
        parseDateTime64BestEffort({ends:Array(String)}[candidateIndex], 6, 'UTC') AS activityEnd
      SELECT toString(activity_id) AS activityId,
        dateDiff('microsecond', activityStart, recorded_at) / 1000000 AS elapsedSeconds,
        channel, toFloat64(scalar) AS scalar, measurement_kind AS measurementKind,
        provider_id AS providerId, toString(member_activity_id) AS memberId
      FROM analytics.activity_sensor_sample FINAL
      WHERE user_id = {userId:UUID} AND activity_id IN {activityIds:Array(UUID)} AND is_deleted = 0
        AND channel IN ('power', 'heart_rate')
        AND recorded_at >= activityStart AND recorded_at < activityEnd`,
      {
        userId: this.#userId,
        activityIds: candidates.map((ride) => ride.activityId),
        starts: candidates.map((ride) => ride.startedAt),
        ends: candidates.map((ride) => ride.endedAt),
      },
      { priority: "dashboard" },
    );
    const samplesByRide = new Map<string, Sample[]>(
      candidates.map(({ activityId }) => [activityId, []]),
    );
    for (const sample of samples) samplesByRide.get(sample.activityId)?.push(sample);
    const series = new Map<string, Ride[]>();
    for (const candidate of candidates) {
      const ride = calculateRide(
        candidate,
        samplesByRide.get(candidate.activityId) ?? [],
        excludedMembers,
      );
      if (!ride) continue;
      for (const identity of candidate.identities) {
        const key = JSON.stringify(identity);
        const rides = series.get(key) ?? [];
        rides.push(ride);
        series.set(key, rides);
      }
    }
    for (const rides of series.values()) {
      const newest = rides[0];
      if (newest && rides.length >= 2) {
        return { workoutName: newest.name?.trim() || "Repeated workout", rides: rides.reverse() };
      }
    }
    return empty;
  }
}
