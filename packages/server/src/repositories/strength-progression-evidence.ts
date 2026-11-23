import { strengthExerciseIdentityKey } from "@dofek/training/training";
import type { z } from "zod";
import type {
  StrengthEvidenceEffort,
  StrengthEvidenceObservation,
  TrainingProgressionStrengthRow,
} from "../contracts/training-progression-strength.ts";
import {
  type ConsolidatedSet,
  consolidatedStrengthQualityFlags,
  estimateConsolidatedStrengthSet,
  isWorking,
  type strengthSetRowSchema,
} from "./strength-set-estimate.ts";

const REP_IMPROVEMENT_MIN_DATES = 3;
const EFFORT_SPREAD_LIMIT = 0.5;
const FLAT_BENCHMARK_MIN_DATES = 6;
const FLAT_BENCHMARK_MIN_SPAN_DAYS = 28;
const FLAT_BENCHMARK_MAX_SPREAD_PERCENT = 2.5;

type EvidenceRow = z.infer<typeof strengthSetRowSchema> & {
  session_date: string;
  activity_started_at: string;
};
type EvidenceSet = ConsolidatedSet<EvidenceRow>;

/** The canonical session behind a set, precise enough to separate same-day sessions. */
interface SessionAnchor {
  startedAt: string;
  activityId: string;
}

interface AnchoredObservation {
  observation: StrengthEvidenceObservation;
  anchor: SessionAnchor;
}

interface EffortAssessment extends StrengthEvidenceEffort {
  /** True only when every observation in the group carries a recorded RPE. */
  fullyRecorded: boolean;
}

interface EvidenceCandidate {
  evidence: TrainingProgressionStrengthRow["evidence"];
  status: TrainingProgressionStrengthRow["status"];
  latestDate: string;
  latestAnchor: SessionAnchor | null;
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function dateSpanDays(first: string, last: string): number {
  return (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000;
}

/**
 * A set's position is taken from its recorded exercise occurrence, ordinal, and
 * set type, never from a compacted list of working sets: dropping an invalid
 * neighbor must not move a valid set into another session's slot, and drop or
 * failure variants must not be compared as ordinary working sets.
 */
function positionKey(set: EvidenceSet): string {
  return JSON.stringify([set.row.exercise_index, set.row.set_index, set.row.set_type]);
}

function recordedSlot(set: EvidenceSet): number {
  return set.row.set_index + 1;
}

/**
 * Merged duplicate sets can carry several provider labels for one recorded effort.
 * The lowest provider ID is a deterministic representative; identical normalized
 * values are the reason those source rows merged in the first place.
 */
function representativeSource(set: EvidenceSet): EvidenceRow {
  const provider = unique(set.sourceRows.map((row) => row.set_provider))[0] ?? set.row.set_provider;
  return (
    set.sourceRows
      .filter((row) => row.set_provider === provider)
      .sort((a, b) => a.set_id.localeCompare(b.set_id))[0] ?? set.row
  );
}

function observationOf(
  set: EvidenceSet,
  source: EvidenceRow,
  weightKg: number,
  reps: number,
  estimateKg: number | null,
): StrengthEvidenceObservation {
  return {
    date: set.row.session_date,
    activityId: set.row.activity_id,
    sourceActivityId: source.set_activity_id,
    sourceSetId: source.set_id,
    provider: source.set_provider,
    setIndex: recordedSlot(set),
    weightKg,
    reps,
    rpe: set.row.rpe,
    estimatedMaxKg: estimateKg === null ? null : round(estimateKg),
  };
}

function assessEffort(observations: StrengthEvidenceObservation[]): EffortAssessment {
  const first = observations[0];
  if (!first) throw new Error("Effort assessment requires at least one observation");
  const providers = unique(observations.map((observation) => observation.provider));
  const recordedRatings = observations.flatMap((observation) =>
    observation.rpe === null ? [] : [observation.rpe],
  );
  const fullyRecorded = recordedRatings.length === observations.length;
  const spread =
    recordedRatings.length === 0
      ? null
      : Math.max(...recordedRatings) - Math.min(...recordedRatings);
  return {
    provider: first.provider,
    rpeSpread: spread === null ? null : round(spread),
    comparable:
      providers.length === 1 && fullyRecorded && spread !== null && spread <= EFFORT_SPREAD_LIMIT,
    fullyRecorded,
  };
}

function effortEvidence(effort: EffortAssessment): StrengthEvidenceEffort {
  return {
    provider: effort.provider,
    rpeSpread: effort.rpeSpread,
    comparable: effort.comparable,
  };
}

function sessionAnchor(row: EvidenceRow): SessionAnchor {
  return { startedAt: row.activity_started_at, activityId: row.activity_id };
}

/** Later canonical session wins; activity id breaks ties deterministically. */
function compareSessionAnchors(a: SessionAnchor, b: SessionAnchor): number {
  return (
    Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.activityId.localeCompare(b.activityId)
  );
}

/**
 * One observation per distinct date keeps the repetition and span counts honest.
 * When several eligible sets share a date, the latest canonical session wins so
 * a newer same-day session stays matched to its own evidence rather than an
 * older set with a smaller source id. Ordering is by canonical session time, not
 * local date: travel across time zones can make a physically later session carry
 * an earlier local date, and sorting by date would drop the actual latest series.
 */
function dailyObservations(anchored: AnchoredObservation[]): {
  observations: StrengthEvidenceObservation[];
  latestAnchor: SessionAnchor | null;
} {
  const byDate = new Map<string, AnchoredObservation>();
  for (const entry of anchored) {
    const current = byDate.get(entry.observation.date);
    if (!current || compareSessionAnchors(entry.anchor, current.anchor) > 0) {
      byDate.set(entry.observation.date, entry);
    }
  }
  const ordered = [...byDate.values()].sort((a, b) => compareSessionAnchors(a.anchor, b.anchor));
  return {
    observations: ordered.map((entry) => entry.observation),
    latestAnchor: ordered.at(-1)?.anchor ?? null,
  };
}

/**
 * The most recent canonical session carrying an eligible working exposure for a
 * lift. A candidate anchored to an earlier session describes an older training
 * block; selecting it would keep a readiness or stagnation status alive after a
 * newer session at a different load, slot, or performance level. Every set in
 * that session shares the anchor, so one session can still yield several lifts.
 */
function latestEligibleSession(sets: EvidenceSet[]): SessionAnchor | null {
  let latest: SessionAnchor | null = null;
  for (const set of sets) {
    if (consolidatedStrengthQualityFlags(set).length > 0 || !isWorking(set.row)) continue;
    const { weight_kg: weight, reps } = set.row;
    if (weight === null || weight <= 0 || reps === null || reps <= 0) continue;
    const anchor = sessionAnchor(set.row);
    if (latest === null || compareSessionAnchors(anchor, latest) > 0) latest = anchor;
  }
  return latest;
}

/**
 * A candidate is current only when its latest observation comes from the same
 * canonical session as the lift's latest eligible exposure. Anchors and
 * observations are both built from the canonical `row.activity_id` (only
 * `sourceActivityId` uses a source/member id), so comparing activity ids is
 * sufficient and avoids relying on recorded start times. Apply this before
 * ranking: local dates can tie across distinct same-day sessions, so an older
 * ready series would otherwise win the status tiebreak and then be discarded,
 * hiding a current valid series entirely.
 */
function isCurrentCandidate(
  candidate: EvidenceCandidate,
  latestEligible: SessionAnchor | null,
): boolean {
  return (
    latestEligible !== null && candidate.latestAnchor?.activityId === latestEligible.activityId
  );
}

function repeatedRepsCandidate(
  sets: EvidenceSet[],
  latestEligible: SessionAnchor | null,
): EvidenceCandidate | null {
  const byPosition = new Map<
    string,
    { slot: number; weightKg: number; anchored: AnchoredObservation[] }
  >();
  for (const set of sets) {
    if (consolidatedStrengthQualityFlags(set).length > 0 || !isWorking(set.row)) continue;
    const { weight_kg: weight, reps } = set.row;
    if (weight === null || weight <= 0 || reps === null || reps <= 0) continue;
    const key = JSON.stringify([positionKey(set), weight]);
    const group = byPosition.get(key) ?? {
      slot: recordedSlot(set),
      weightKg: weight,
      anchored: [],
    };
    group.anchored.push({
      observation: observationOf(set, representativeSource(set), weight, reps, null),
      anchor: sessionAnchor(set.row),
    });
    byPosition.set(key, group);
  }

  const candidates: Array<EvidenceCandidate & { slot: number; weightKg: number }> = [];
  for (const group of byPosition.values()) {
    const { observations, latestAnchor } = dailyObservations(group.anchored);
    const baseline = observations[0]?.reps ?? 0;
    const previous = observations.at(-2)?.reps ?? 0;
    const latest = observations.at(-1)?.reps ?? 0;
    if (observations.length < 2 || latest <= baseline) continue;
    const effort = assessEffort(observations);
    const repeatable =
      observations.length >= REP_IMPROVEMENT_MIN_DATES &&
      previous > baseline &&
      latest > baseline &&
      latest >= previous &&
      effort.comparable &&
      effort.rpeSpread !== null;
    const newestFirst = [...observations].reverse();
    candidates.push({
      evidence: {
        kind: "rep_improvement",
        slot: group.slot,
        weightKg: group.weightKg,
        effort: effortEvidence(effort),
        observations: newestFirst,
      },
      status: repeatable ? "ready" : null,
      latestDate: newestFirst[0]?.date ?? "",
      latestAnchor,
      slot: group.slot,
      weightKg: group.weightKg,
    });
  }
  const current = candidates.filter((candidate) => isCurrentCandidate(candidate, latestEligible));
  // Current candidates share the latest eligible canonical session, so their
  // latest date is tied by definition; ready outranks observed, then slot/load.
  current.sort(
    (a, b) =>
      Number(b.status === "ready") - Number(a.status === "ready") ||
      a.slot - b.slot ||
      a.weightKg - b.weightKg,
  );
  const chosen = current[0];
  return chosen
    ? {
        evidence: chosen.evidence,
        status: chosen.status,
        latestDate: chosen.latestDate,
        latestAnchor: chosen.latestAnchor,
      }
    : null;
}

function flatBenchmarkCandidate(
  sets: EvidenceSet[],
  latestEligible: SessionAnchor | null,
): EvidenceCandidate | null {
  const byProtocol = new Map<string, { reps: number; anchored: AnchoredObservation[] }>();
  for (const set of sets) {
    const flags = consolidatedStrengthQualityFlags(set);
    if (flags.length > 0) continue;
    const estimate = estimateConsolidatedStrengthSet(set, flags);
    const { weight_kg: weight, reps } = set.row;
    const source = estimate.source;
    if (
      estimate.value === null ||
      source === null ||
      weight === null ||
      weight <= 0 ||
      reps === null ||
      reps <= 0
    ) {
      continue;
    }
    const key = JSON.stringify([positionKey(set), reps, source.set_provider]);
    const group = byProtocol.get(key) ?? { reps, anchored: [] };
    group.anchored.push({
      observation: observationOf(set, source, weight, reps, estimate.value),
      anchor: sessionAnchor(set.row),
    });
    byProtocol.set(key, group);
  }

  const candidates: EvidenceCandidate[] = [];
  for (const group of byProtocol.values()) {
    const { observations, latestAnchor } = dailyObservations(group.anchored);
    if (observations.length < FLAT_BENCHMARK_MIN_DATES) continue;
    // Observations are ordered by session chronology; the benchmark span still
    // needs the earliest/latest local dates, which need not be the end entries.
    const dates = observations.map((observation) => observation.date).sort();
    const spanDays = dateSpanDays(dates[0] ?? "", dates.at(-1) ?? "");
    if (spanDays < FLAT_BENCHMARK_MIN_SPAN_DAYS) continue;
    const values = observations.flatMap((observation) =>
      observation.estimatedMaxKg === null ? [] : [observation.estimatedMaxKg],
    );
    if (values.length !== observations.length) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spreadPercent = round(((max - min) / min) * 100);
    if (spreadPercent > FLAT_BENCHMARK_MAX_SPREAD_PERCENT) continue;
    const assessed = assessEffort(observations);
    // Every observation here carries a labelled Failure estimate; that shared
    // protocol supplies comparability when no RPE was recorded at all. A partial
    // RPE series stays incomparable, while its recorded values remain visible.
    const failureBaselineComparable =
      assessed.rpeSpread === null &&
      unique(observations.map((observation) => observation.provider)).length === 1;
    const effort: StrengthEvidenceEffort = {
      provider: assessed.provider,
      rpeSpread: assessed.rpeSpread,
      comparable: assessed.comparable || failureBaselineComparable,
    };
    if (!effort.comparable) continue;
    const newestFirst = [...observations].reverse();
    candidates.push({
      evidence: {
        kind: "flat_benchmark",
        formula: "Epley",
        reps: group.reps,
        effort,
        observedDates: observations.length,
        spanDays,
        observedRangeKg: { min: round(min), max: round(max), spreadPercent },
        observations: newestFirst,
      },
      status: "stagnating",
      latestDate: newestFirst[0]?.date ?? "",
      latestAnchor,
    });
  }
  // Filter before ranking so a flat group anchored to a stale same-day session
  // cannot preempt the current one. JS sort is stable, so ties among current
  // groups keep the original protocol discovery order.
  const current = candidates.filter((candidate) => isCurrentCandidate(candidate, latestEligible));
  return current[0] ?? null;
}

/**
 * Pure production entry point: decide the strength-progression evidence for a
 * set of already consolidated, user-scoped canonical sets. The repository owns
 * the bounded read and access checks; every selection and status rule lives here.
 */
export function selectStrengthProgressionEvidence(
  sets: EvidenceSet[],
): TrainingProgressionStrengthRow[] {
  const groups = new Map<
    string,
    { exerciseId: string; exerciseName: string; equipment: string | null; sets: EvidenceSet[] }
  >();
  for (const set of sets) {
    const row = set.row;
    const key = JSON.stringify([row.exercise_id, row.equipment]);
    const group = groups.get(key) ?? {
      exerciseId: row.exercise_id,
      exerciseName: row.exercise_name,
      equipment: row.equipment,
      sets: [],
    };
    group.sets.push(set);
    groups.set(key, group);
  }

  const results: TrainingProgressionStrengthRow[] = [];
  for (const group of groups.values()) {
    const latestEligible = latestEligibleSession(group.sets);
    const chosen =
      repeatedRepsCandidate(group.sets, latestEligible) ??
      flatBenchmarkCandidate(group.sets, latestEligible);
    if (!chosen) continue;
    results.push({
      identityKey: strengthExerciseIdentityKey({
        exerciseName: group.exerciseName,
        equipment: group.equipment,
      }),
      exerciseId: group.exerciseId,
      exerciseName: group.exerciseName,
      equipment: group.equipment,
      status: chosen.status,
      evidence: chosen.evidence,
      latestEvidenceDate: chosen.latestDate,
    });
  }
  return results.sort(
    (a, b) =>
      b.latestEvidenceDate.localeCompare(a.latestEvidenceDate) ||
      a.exerciseName.localeCompare(b.exerciseName) ||
      (a.equipment ?? "").localeCompare(b.equipment ?? "") ||
      a.exerciseId.localeCompare(b.exerciseId),
  );
}
