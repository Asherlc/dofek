import { summarizeIntervalPower } from "@dofek/training/cycling-interval-power";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import {
  type CyclingProgressionInterval,
  type CyclingProgressionRide,
  type TrainingProgressionCycling,
  trainingProgressionCyclingSchema,
} from "../contracts/training-progression-cycling.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { postgresActivityLocalDate } from "./activity-local-date.ts";
import type { ActivityRepository, ActivitySensorStore } from "./activity-repository.ts";
import type { ActivitySensorWindow } from "./activity-sensor-types.ts";
import {
  type CyclingEffortSample,
  loadRecordedIntervalRows,
  type RecordedIntervalEvidence,
  recordedIntervalsForActivity,
  resampleCleanPower,
} from "./cycling-effort-metrics.ts";
import { loadCyclingSampleRows } from "./cycling-sample-rows.ts";
import {
  type ComparisonIdentityRow,
  PerformanceComparisonIdentity,
} from "./performance-comparison-identity.ts";
import { canonicalWindowSeconds } from "./planned-interval-comparison.ts";

const MAXIMUM_CANDIDATES = 8;
const COMPARISON_WINDOW_DAYS = 56;
/** Imported session effort is a 5/10 cutoff, distinct from the comparison tolerance. */
const MAXIMUM_SESSION_EFFORT = 5;
/** Work interval and whole-ride features must agree within five percent. */
const MAXIMUM_MATCH_DIFFERENCE_PCT = 5;
const MINIMUM_COVERAGE_PCT = 90;
/** Reject unclosed or implausibly long canonical windows before loading their samples. */
const MAXIMUM_RIDE_WINDOW_MS = 12 * 60 * 60 * 1000;

const rideRowSchema = z.object({
  id: z.uuid(),
  local_date: dateStringSchema,
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  modality: z.string().nullable(),
  perceived_exertion: z.preprocess(
    (value) => (typeof value === "number" && !Number.isFinite(value) ? null : value),
    z.number().nullable(),
  ),
  member_activity_ids: z.array(z.uuid()),
  effort_consistent: z.boolean(),
});
type RideRow = z.infer<typeof rideRowSchema>;

/** v_activity publishes one effort; disagreeing current members make that value unusable. */
const effortConsistentPredicate = sql`(SELECT COUNT(DISTINCT member.perceived_exertion) <= 1
  FROM fitness.activity AS member
  WHERE member.user_id = a.user_id
    AND member.id = ANY(a.member_activity_ids)
    AND member.perceived_exertion IS NOT NULL
    AND member.provider_absent_at IS NULL
    AND member.deleted_at IS NULL)`;
const effortConsistentColumn = sql`${effortConsistentPredicate} AS effort_consistent`;

/** A row that passed the effort, window-completeness and bounded-duration checks. */
type ValidatedRideRow = RideRow & {
  ended_at: string;
  modality: string;
  perceived_exertion: number;
};

interface MeasuredInterval {
  interval: CyclingProgressionInterval;
}

interface RideEvidence {
  ride: ValidatedRideRow;
  durationSeconds: number;
  intervals: MeasuredInterval[];
  exactWorkoutIdentities: Array<{ provider: string; value: string }>;
  powerProviders: string[];
  powerDevices: string[];
}

type SampleRow = Awaited<ReturnType<typeof loadCyclingSampleRows>>[number];
type IntervalRow = Parameters<typeof recordedIntervalsForActivity>[1][number];
type IntervalClass = "work" | "recovery";

function intervalClass(value: string | null | undefined): IntervalClass | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "work" || normalized === "recovery" ? normalized : null;
}

interface IntervalFields {
  workRecoveryKind: string | null | undefined;
  segmentType: string | null | undefined;
  intervalType: string | null | undefined;
}

/** Same precedence as the recorded-interval classifier: work kind, then segment, then type. */
function effectiveIntervalClass(fields: IntervalFields): IntervalClass | null {
  return intervalClass(fields.workRecoveryKind ?? fields.segmentType ?? fields.intervalType);
}

const rowFields = (row: IntervalRow): IntervalFields => ({
  workRecoveryKind: row.work_recovery_kind,
  segmentType: row.segment_type,
  intervalType: row.interval_type,
});

/**
 * Peers a few hundred milliseconds apart round into one merged group and can disagree across
 * fields without a same-field merge conflict. The retained provenance is the merge output's exact
 * normalized grouping, so an adjacent recovery that only overlaps raw bounds is not pulled in.
 */
function hasOpposingMergedClasses(recorded: RecordedIntervalEvidence[]): boolean {
  return recorded.some(({ interval }) => {
    // Only directly recorded peers are authoritative about the work/recovery class. An inferred
    // detector label merged into the same group cannot veto a provider-recorded work interval.
    const fields: IntervalFields[] = (interval.sourceEvidence ?? [])
      .filter((peer) => peer.source === "provider_recorded")
      .map((peer) => ({
        workRecoveryKind: peer.workRecoveryKind,
        segmentType: peer.segmentType,
        intervalType: peer.intervalType,
      }));
    const kinds = new Set(
      fields.map(effectiveIntervalClass).filter((kind): kind is IntervalClass => kind !== null),
    );
    return kinds.has("work") && kinds.has("recovery");
  });
}

const uniqueSorted = (values: string[]) => [...new Set(values)].sort();
const isModerate = (value: number | null): value is number =>
  value != null && Number.isFinite(value) && value > 0 && value <= MAXIMUM_SESSION_EFFORT;

/** Guards the complete canonical window before any sample rows are loaded or allocated. */
function validatedRideRow(ride: RideRow): ValidatedRideRow | null {
  const { ended_at, effort_consistent, modality, perceived_exertion, started_at } = ride;
  if (!effort_consistent || !isModerate(perceived_exertion) || modality == null || ended_at == null)
    return null;
  const durationMs = Date.parse(ended_at) - Date.parse(started_at);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAXIMUM_RIDE_WINDOW_MS)
    return null;
  return { ...ride, ended_at, modality, perceived_exertion };
}

function compareIdentityLists(
  left: Array<{ provider: string; value: string }>,
  right: Array<{ provider: string; value: string }>,
): boolean {
  return (
    left.length === right.length &&
    left.every((identity, index) => {
      const other = right[index];
      return other?.provider === identity.provider && other.value === identity.value;
    })
  );
}

/** Exact provider workout identities; more than one value in one namespace is ambiguous. */
function exactWorkoutIdentities(rows: ComparisonIdentityRow[]) {
  const byProvider = new Map<string, Set<string>>();
  for (const row of rows) {
    if (
      row.kind !== "provider_workout" ||
      row.strength !== "exact" ||
      !row.namespace ||
      !row.value.trim()
    )
      continue;
    const values = byProvider.get(row.namespace) ?? new Set<string>();
    values.add(row.value);
    byProvider.set(row.namespace, values);
  }
  const result: Array<{ provider: string; value: string }> = [];
  for (const [provider, values] of byProvider) {
    if (values.size !== 1) return null;
    const [value] = values;
    if (value) result.push({ provider, value });
  }
  return result.sort(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.value.localeCompare(right.value),
  );
}

function prepareRide(
  ride: ValidatedRideRow,
  intervalRows: IntervalRow[],
  sampleRows: SampleRow[],
  identityRows: ComparisonIdentityRow[],
): RideEvidence | null {
  const memberRows = intervalRows.filter((row) =>
    ride.member_activity_ids.includes(row.member_activity_id),
  );
  const recorded = recordedIntervalsForActivity(
    {
      activity_id: ride.id,
      member_activity_ids: ride.member_activity_ids,
      started_at: ride.started_at,
    },
    memberRows,
    { retainSourceEvidence: true },
  );
  if (
    recorded.length === 0 ||
    recorded.some(
      ({ interval }) =>
        interval.source !== "provider_recorded" || (interval.conflicts?.length ?? 0) > 0,
    ) ||
    hasOpposingMergedClasses(recorded)
  )
    return null;
  const work = recorded
    .filter(({ input }) => input.type === "work")
    .sort(
      (left, right) =>
        left.input.startOffsetSeconds - right.input.startOffsetSeconds ||
        left.input.index - right.input.index,
    );
  if (work.length === 0) return null;
  // Overlapping work windows double count power and make positional comparison ambiguous.
  for (let index = 1; index < work.length; index++) {
    const previous = work[index - 1];
    const current = work[index];
    if (!previous || !current || current.input.startOffsetSeconds < previous.input.endOffsetSeconds)
      return null;
  }

  const directRows: SampleRow[] = [];
  const samples: CyclingEffortSample[] = [];
  for (const row of sampleRows) {
    if (row.activity_id !== ride.id || row.power_measurement_kinds.length === 0) continue;
    const direct = row.power_measurement_kinds.every((kind) => kind === "direct");
    if (direct) directRows.push(row);
    // Explicit gaps stop a measured value from carrying across non-direct observations.
    samples.push({ elapsedSeconds: row.elapsed_seconds, powerWatts: direct ? row.power : null });
  }
  if (directRows.length === 0) return null;
  const durationSeconds = canonicalWindowSeconds(ride.started_at, ride.ended_at, recorded);
  const power = resampleCleanPower(samples, durationSeconds);
  const intervals: MeasuredInterval[] = [];
  for (const evidence of work) {
    const exactDuration = evidence.input.endOffsetSeconds - evidence.input.startOffsetSeconds;
    const { startOffsetSeconds, endOffsetSeconds, meanPowerWatts } = summarizeIntervalPower(
      power.values,
      evidence.input,
    );
    if (
      !(exactDuration > 0) ||
      meanPowerWatts == null ||
      !Number.isFinite(meanPowerWatts) ||
      meanPowerWatts <= 0
    )
      return null;
    const covered = power.values
      .slice(startOffsetSeconds, endOffsetSeconds)
      .filter((watts) => watts != null && Number.isFinite(watts)).length;
    const coveragePct = (covered / exactDuration) * 100;
    if (!Number.isFinite(coveragePct) || coveragePct < MINIMUM_COVERAGE_PCT) return null;
    intervals.push({
      interval: {
        index: evidence.input.index + 1,
        workDurationSeconds: exactDuration,
        // Keep the unrounded mean for the tolerance comparison; clients round it for display.
        meanPowerWatts,
        powerCoveragePct: Math.min(100, Math.round(coveragePct)),
        sourceProvider: evidence.interval.sourceProvider,
        sourceActivityId: evidence.interval.sourceActivityId,
        sourceMemberActivityIds: evidence.interval.sourceMemberActivityIds,
      },
    });
  }

  const identities = exactWorkoutIdentities(identityRows);
  if (identities === null) return null;
  return {
    ride,
    durationSeconds,
    intervals,
    exactWorkoutIdentities: identities,
    powerProviders: uniqueSorted(directRows.flatMap((row) => row.source_providers)),
    powerDevices: uniqueSorted(directRows.flatMap((row) => row.source_devices)),
  };
}

function compareEvidence(baseline: RideEvidence, candidate: RideEvidence) {
  if (baseline.intervals.length !== candidate.intervals.length) return null;
  // Imported session effort describes the whole ride, so whole-ride duration must match too.
  const totalDurationDifferencePct =
    (Math.abs(candidate.durationSeconds - baseline.durationSeconds) / baseline.durationSeconds) *
    100;
  if (
    !Number.isFinite(totalDurationDifferencePct) ||
    totalDurationDifferencePct > MAXIMUM_MATCH_DIFFERENCE_PCT
  )
    return null;
  const bothIdentified =
    baseline.exactWorkoutIdentities.length > 0 && candidate.exactWorkoutIdentities.length > 0;
  if (
    bothIdentified &&
    !compareIdentityLists(baseline.exactWorkoutIdentities, candidate.exactWorkoutIdentities)
  )
    return null;
  let largestDurationDifferencePct = 0;
  let largestMeanPowerDifferencePct = 0;
  for (let index = 0; index < baseline.intervals.length; index++) {
    const reference = baseline.intervals[index];
    const compared = candidate.intervals[index];
    if (!reference || !compared) return null;
    const durationDifferencePct =
      (Math.abs(compared.interval.workDurationSeconds - reference.interval.workDurationSeconds) /
        reference.interval.workDurationSeconds) *
      100;
    const powerDifferencePct =
      (Math.abs(compared.interval.meanPowerWatts - reference.interval.meanPowerWatts) /
        reference.interval.meanPowerWatts) *
      100;
    if (
      !Number.isFinite(durationDifferencePct) ||
      !Number.isFinite(powerDifferencePct) ||
      durationDifferencePct > MAXIMUM_MATCH_DIFFERENCE_PCT ||
      powerDifferencePct > MAXIMUM_MATCH_DIFFERENCE_PCT
    )
      return null;
    largestDurationDifferencePct = Math.max(largestDurationDifferencePct, durationDifferencePct);
    largestMeanPowerDifferencePct = Math.max(largestMeanPowerDifferencePct, powerDifferencePct);
  }
  return {
    basis: bothIdentified
      ? ("exact_workout_identity" as const)
      : ("recorded_work_protocol" as const),
    largestDurationDifferencePct,
    largestMeanPowerDifferencePct,
  };
}

function toRide(evidence: RideEvidence, role: "selected" | "comparison"): CyclingProgressionRide {
  return {
    role,
    activityId: evidence.ride.id,
    date: evidence.ride.local_date,
    sessionEffort: evidence.ride.perceived_exertion,
    modality: evidence.ride.modality,
    exactWorkoutIdentities: evidence.exactWorkoutIdentities,
    intervalCount: evidence.intervals.length,
    intervals: evidence.intervals.map(({ interval }) => interval),
    powerProvenance: {
      measurementKind: "direct",
      providers: evidence.powerProviders,
      devices: evidence.powerDevices,
    },
  };
}

/** Bounded, read-only comparison of two recorded cycling rides on Activity Detail. */
export class CyclingProgressionRepository extends BaseRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #activities: Pick<ActivityRepository, "findSensorWindow">;

  constructor(
    db: Pick<Database, "execute">,
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
    accessWindow: AccessWindow,
    activities: Pick<ActivityRepository, "findSensorWindow">,
  ) {
    super(db, userId, timezone, accessWindow);
    this.#store = store;
    this.#activities = activities;
  }

  async getCyclingProgression(activityId: string): Promise<TrainingProgressionCycling> {
    const window: ActivitySensorWindow | null = await this.#activities.findSensorWindow(activityId);
    if (!window) return null;
    const selectedRow = await this.#readSelected(window.activityId);
    const selected = selectedRow ? validatedRideRow(selectedRow) : null;
    if (!selected) return null;

    // The work gate and first candidate page are both Postgres-only reads. Running them together
    // keeps a ride with no candidates from paying for the ClickHouse power load below.
    const [selectedIntervalRows, firstCandidatePage] = await Promise.all([
      loadRecordedIntervalRows(this.db, uniqueSorted(selected.member_activity_ids)),
      this.#readCandidates(selected, null),
    ]);
    const selectedHasWork = selectedIntervalRows.some(
      (row) =>
        selected.member_activity_ids.includes(row.member_activity_id) &&
        row.source_kind === "provider_recorded" &&
        effectiveIntervalClass(rowFields(row)) === "work",
    );
    if (!selectedHasWork) return null;
    if (firstCandidatePage.length === 0) return null;
    // The selected ride's preparation is reused unchanged for every candidate batch.
    const baseline = (await this.#prepareRides([selected], selectedIntervalRows))[0];
    if (!baseline) return null;

    // Scan the whole 56-day history in newest-first keyset batches, stopping at the first eligible
    // comparison. Progress follows the last raw row, so a full page whose rows all fail validation
    // still advances the scan; a short or empty page ends it without another fetch. Only one batch
    // of intervals and power is loaded at a time, and a repeated cursor ends the loop defensively.
    const seenCursors = new Set<string>();
    let rawPage: RideRow[] = firstCandidatePage;
    while (rawPage.length > 0) {
      const oldestRaw: RideRow | undefined = rawPage.at(-1);
      if (!oldestRaw) break;
      const cursor = `${oldestRaw.started_at}|${oldestRaw.id}`;
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);

      const batch: ValidatedRideRow[] = rawPage
        .flatMap((row) => {
          const validated = validatedRideRow(row);
          return validated ? [validated] : [];
        })
        .filter(
          (ride) =>
            ride.modality === selected.modality &&
            ride.local_date < selected.local_date &&
            ride.started_at < selected.started_at &&
            Date.parse(ride.local_date) >=
              Date.parse(selected.local_date) - COMPARISON_WINDOW_DAYS * 86_400_000,
        );
      if (batch.length > 0) {
        for (const candidate of await this.#prepareRides(batch)) {
          const comparison = compareEvidence(baseline, candidate);
          if (!comparison) continue;
          return trainingProgressionCyclingSchema.parse({
            status: "ready",
            basis: comparison.basis,
            comparison: {
              intervalCount: baseline.intervals.length,
              largestDurationDifferencePct: comparison.largestDurationDifferencePct,
              largestMeanPowerDifferencePct: comparison.largestMeanPowerDifferencePct,
            },
            rides: [toRide(baseline, "selected"), toRide(candidate, "comparison")],
          });
        }
      }
      if (rawPage.length < MAXIMUM_CANDIDATES) break;
      rawPage = await this.#readCandidates(selected, {
        startedAt: oldestRaw.started_at,
        id: oldestRaw.id,
      });
    }
    return null;
  }

  async #prepareRides(
    rides: ValidatedRideRow[],
    preloadedIntervalRows?: IntervalRow[],
  ): Promise<RideEvidence[]> {
    const intervalRows =
      preloadedIntervalRows ??
      (await loadRecordedIntervalRows(
        this.db,
        uniqueSorted(rides.flatMap((ride) => ride.member_activity_ids)),
      ));
    const canonicalWindows: Record<string, { startedAt: string; endedAt: string }> = {};
    for (const ride of rides) {
      canonicalWindows[ride.id] = { startedAt: ride.started_at, endedAt: ride.ended_at };
    }
    const [identities, sampleRows] = await Promise.all([
      new PerformanceComparisonIdentity(this.db, this.#store, this.userId).identities(
        rides.map((ride) => ({
          activity_id: ride.id,
          member_activity_ids: ride.member_activity_ids,
          canonical_type: "cycling",
          modality: ride.modality,
        })),
      ),
      loadCyclingSampleRows(
        this.#store,
        this.userId,
        rides.map((ride) => ride.id),
        ["power"],
        undefined,
        {
          authorizedPowerLinks: rides.flatMap((ride) =>
            ride.member_activity_ids.map((memberActivityId) => ({
              activityId: ride.id,
              memberActivityId,
            })),
          ),
          canonicalWindows,
        },
      ),
    ]);
    const identitiesByRide = new Map<string, ComparisonIdentityRow[]>();
    for (const identity of identities) {
      const rows = identitiesByRide.get(identity.canonical_activity_id) ?? [];
      rows.push(identity);
      identitiesByRide.set(identity.canonical_activity_id, rows);
    }
    return rides.flatMap((ride) => {
      const prepared = prepareRide(
        ride,
        intervalRows,
        sampleRows,
        identitiesByRide.get(ride.id) ?? [],
      );
      return prepared ? [prepared] : [];
    });
  }

  async #readSelected(activityId: string): Promise<RideRow | null> {
    const localDate = postgresActivityLocalDate(sql`a`, this.timezone);
    const rows = await this.query(
      rideRowSchema,
      sql`/* cycling-progression:selected */
        SELECT a.id::text AS id,
          (${localDate})::text AS local_date,
          a.started_at::text AS started_at,
          a.ended_at::text AS ended_at,
          a.modality,
          a.perceived_exertion,
          a.member_activity_ids,
          ${effortConsistentColumn}
        FROM fitness.v_activity AS a
        WHERE a.id = ${activityId}::uuid
          AND a.user_id = ${this.userId}::uuid
          AND a.canonical_type = 'cycling'
          ${this.timestampAccessPredicate(sql`a.started_at`)}
        LIMIT 1`,
    );
    return rows[0] ?? null;
  }

  async #readCandidates(
    selected: ValidatedRideRow,
    after: { startedAt: string; id: string } | null,
  ): Promise<RideRow[]> {
    const localDate = postgresActivityLocalDate(sql`a`, this.timezone);
    return this.query(
      rideRowSchema,
      sql`/* cycling-progression:candidates */
        SELECT a.id::text AS id,
          (${localDate})::text AS local_date,
          a.started_at::text AS started_at,
          a.ended_at::text AS ended_at,
          a.modality,
          a.perceived_exertion,
          a.member_activity_ids,
          ${effortConsistentColumn}
        FROM fitness.v_activity AS a
        WHERE a.user_id = ${this.userId}::uuid
          AND a.canonical_type = 'cycling'
          AND a.modality IS NOT DISTINCT FROM ${selected.modality}
          AND ${localDate} < ${selected.local_date}::date
          AND ${localDate} >= ${selected.local_date}::date - ${sql.raw(String(COMPARISON_WINDOW_DAYS))}
          AND a.started_at < ${selected.started_at}::timestamptz
          AND a.perceived_exertion > 0
          AND a.perceived_exertion <= ${sql.raw(String(MAXIMUM_SESSION_EFFORT))}
          AND a.ended_at IS NOT NULL
          AND a.ended_at > a.started_at
          AND a.ended_at <= a.started_at + INTERVAL '12 hours'
          AND EXISTS (
            SELECT 1 FROM fitness.activity_interval AS work
            WHERE work.activity_id = ANY(a.member_activity_ids)
              AND work.source_kind = 'provider_recorded'
              AND LOWER(BTRIM(COALESCE(
                work.work_recovery_kind, work.segment_type, work.interval_type
              ))) = 'work'
          )
          AND ${effortConsistentPredicate}
          ${
            after
              ? sql`AND (a.started_at < ${after.startedAt}::timestamptz
                OR (a.started_at = ${after.startedAt}::timestamptz
                  AND a.id < ${after.id}::uuid))`
              : sql``
          }
          ${this.timestampAccessPredicate(sql`a.started_at`)}
        ORDER BY a.started_at DESC, a.id DESC
        LIMIT ${sql.raw(String(MAXIMUM_CANDIDATES))}`,
    );
  }
}
