import { resampleSignal } from "@dofek/cycling-power/resample-signal";
import {
  type GhostSessionsCompareResponse,
  ghostSessionsCompareResponseSchema,
} from "@dofek/training/ghost-sessions";
import { z } from "zod";
import { cyclingPowerCoveragePolicy } from "./cycling-power-policy.ts";
import type { GhostRouteMatchResult } from "./ghost-route-matching.ts";

export interface GhostSessionScalarObservation {
  recordedAt: string;
  value: number | null;
  isEstimated?: boolean;
}

export interface GhostSessionObservations {
  heartRateBpm?: readonly GhostSessionScalarObservation[];
  powerWatts?: readonly GhostSessionScalarObservation[];
}

type RouteMatch = GhostRouteMatchResult["matches"][number];
type RecordedInterval = RouteMatch["anchor"];

const sourceTimestampSchema = z.iso.datetime().regex(/:\d{2}(?:\.\d{1,6})?Z$/);
const minimumCoverage = 0.9;
const maximumObservationsPerChannel = 50_000;
const maximumSignalSeconds = 24 * 60 * 60;

function timestampMilliseconds(recordedAt: string): number | null {
  if (!sourceTimestampSchema.safeParse(recordedAt).success) return null;
  const wholeSecondMs = Date.parse(`${recordedAt.slice(0, 19)}Z`);
  const fractionalSecond = recordedAt[19] === "." ? Number(recordedAt.slice(19, -1)) : 0;
  return wholeSecondMs + fractionalSecond * 1_000;
}

function coveredMean(
  observations: readonly GhostSessionScalarObservation[] | undefined,
  interval: RecordedInterval,
  allowZero: boolean,
): number | null {
  const elapsedSeconds = interval.elapsedMs / 1_000;
  const wholeSeconds = Math.floor(elapsedSeconds);
  if (
    !observations?.length ||
    observations.length > maximumObservationsPerChannel ||
    wholeSeconds < 1 ||
    elapsedSeconds > maximumSignalSeconds
  )
    return null;

  const values = new Map<number, number | null>();
  for (const observation of observations) {
    const timestampMs = timestampMilliseconds(observation.recordedAt);
    if (timestampMs === null) return null;
    if (timestampMs < interval.start.timestampMs || timestampMs >= interval.end.timestampMs)
      continue;
    const offsetSeconds = (timestampMs - interval.start.timestampMs) / 1_000;
    const observed = observation.value;
    const value =
      !observation.isEstimated &&
      observed !== null &&
      Number.isFinite(observed) &&
      (allowZero ? observed >= 0 : observed > 0)
        ? observed
        : null;
    const prior = values.get(offsetSeconds);
    // Retain missing, estimated, invalid and conflicting readings as barriers.
    values.set(offsetSeconds, prior === undefined || prior === value ? value : null);
  }

  // A reading in the fractional tail can establish continuity for the last
  // whole second. Exclude the tail from the covered buckets below.
  const { buckets } = resampleSignal(
    [...values].map(([elapsedSeconds, value]) => ({ elapsedSeconds, value })),
    Math.ceil(elapsedSeconds),
    cyclingPowerCoveragePolicy,
  );

  let weightedSum = 0;
  let coveredSeconds = 0;
  let coveredWholeSeconds = 0;
  for (const [second, bucket] of buckets) {
    if (second >= wholeSeconds) continue;
    weightedSum += bucket.value;
    coveredSeconds += bucket.coveredDuration;
    coveredWholeSeconds += 1;
  }
  if (coveredWholeSeconds / elapsedSeconds < minimumCoverage) return null;
  const mean = weightedSum / coveredSeconds;
  return Number.isFinite(mean) ? mean : null;
}

function measureChannel(
  match: RouteMatch,
  anchorObservations: readonly GhostSessionScalarObservation[] | undefined,
  candidateObservations: readonly GhostSessionScalarObservation[] | undefined,
  allowZero: boolean,
): { anchor: number; candidate: number } | null {
  if (!anchorObservations?.length || !candidateObservations?.length) return null;
  const anchor = coveredMean(anchorObservations, match.anchor, allowZero);
  if (anchor === null) return null;
  const candidate = coveredMean(candidateObservations, match.candidate, allowZero);
  return candidate === null ? null : { anchor, candidate };
}

function runningPace(match: RouteMatch): { anchor: number; candidate: number } {
  const distanceMeters = Math.min(
    match.anchor.end.distanceMeters - match.anchor.start.distanceMeters,
    match.candidate.end.distanceMeters - match.candidate.start.distanceMeters,
  );
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0)
    throw new RangeError("A running comparison requires a positive measured shared distance");
  // Milliseconds per meter is numerically equal to seconds per kilometer.
  return {
    anchor: match.anchor.elapsedMs / distanceMeters,
    candidate: match.candidate.elapsedMs / distanceMeters,
  };
}

/** Measure a verified match using independently selected, bounded source observations. */
export function measureGhostSession({
  match,
  sport,
  anchorObservations,
  candidateObservations,
}: {
  match: RouteMatch;
  sport: "running" | "cycling";
  anchorObservations: GhostSessionObservations;
  candidateObservations: GhostSessionObservations;
}): GhostSessionsCompareResponse {
  return ghostSessionsCompareResponseSchema.parse({
    anchor: match.anchor,
    candidate: match.candidate,
    elapsedDifferenceMs: match.elapsedDifferenceMs,
    timeBasis: "elapsed-including-recorded-stops",
    replay: match.replay,
    replayDownsampled: match.replayDownsampled,
    metrics: {
      paceSecondsPerKm: sport === "running" ? runningPace(match) : null,
      heartRateBpm: measureChannel(
        match,
        anchorObservations.heartRateBpm,
        candidateObservations.heartRateBpm,
        false,
      ),
      powerWatts: measureChannel(
        match,
        anchorObservations.powerWatts,
        candidateObservations.powerWatts,
        true,
      ),
    },
  });
}
