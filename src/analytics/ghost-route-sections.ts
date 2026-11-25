import {
  type GhostRecordedWaypoint,
  type GhostRouteMatchResult,
  type GhostTrackPoint,
  prepareGhostRouteSectionMatch,
  recordedGhostRouteChunks,
} from "./ghost-route-matching.ts";

interface RecordedBounds {
  start: GhostRecordedWaypoint;
  end: GhostRecordedWaypoint;
}

interface RecordedAltitude {
  timestampMs: number;
  altitudeMeters: number | null;
}

interface CoveredAltitude {
  timestampMs: number;
  altitudeMeters: number;
  before: GhostRecordedWaypoint;
  after: GhostRecordedWaypoint;
}

type RouteMatch = GhostRouteMatchResult["matches"][number];
type MatchedPosition = RouteMatch["anchor"]["start"];

const maximumAltitudeSamples = 20_000;
const maximumClimbs = 16;
const maximumSectionMatches = 32;
const maximumGpsBracketMs = 1_000;
const minimumAltitudeGapMs = 3_000;
const maximumAltitudeGapMs = 10_000;
const climbBlockMeters = 30;
const minimumBlockGrade = 0.02;
const minimumRisingBlocks = 4;
const minimumRiseMeters = 12;
const minimumClimbGrade = 0.03;

function isEarlier({ anchor, candidate }: RouteMatch): boolean {
  return candidate.end.timestampMs <= anchor.start.timestampMs;
}

function sameRecording(left: readonly GhostTrackPoint[], right: readonly GhostTrackPoint[]) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((point, index) => {
        const other = right[index];
        return (
          other?.timestampMs === point.timestampMs &&
          other.lat === point.lat &&
          other.lng === point.lng
        );
      }))
  );
}

function samePair(left: RouteMatch, right: RouteMatch) {
  return (
    left.anchor.start.timestampMs === right.anchor.start.timestampMs &&
    left.anchor.end.timestampMs === right.anchor.end.timestampMs &&
    left.candidate.start.timestampMs === right.candidate.start.timestampMs &&
    left.candidate.end.timestampMs === right.candidate.end.timestampMs
  );
}

function matchEarlierPasses(
  anchorPoints: readonly GhostTrackPoint[],
  candidatePoints: readonly GhostTrackPoint[],
  bounds: RecordedBounds,
): GhostRouteMatchResult {
  const sameWorkout = sameRecording(anchorPoints, candidatePoints);
  const matchSection = prepareGhostRouteSectionMatch(
    anchorPoints,
    sameWorkout ? anchorPoints : candidatePoints,
    bounds,
  );
  const result = matchSection();
  const matches = result.matches.filter(isEarlier);
  if (
    !result.matches.some(
      (match) => !isEarlier(match) && match.candidate.start.timestampMs < bounds.start.timestampMs,
    ) ||
    !sameWorkout
  ) {
    return { ...result, matches };
  }

  // The longest pairing can overlap itself and hide a genuinely prior pass.
  // Recheck one recorded prefix for this workout without changing core alignment.
  const earlier = matchSection(true);
  let bounded = result.status === "bounded" || earlier.status === "bounded";
  for (const match of earlier.matches) {
    if (!isEarlier(match) || matches.some((prior) => samePair(prior, match))) continue;
    if (matches.length >= maximumSectionMatches) {
      bounded = true;
      break;
    }
    matches.push(match);
  }
  matches.sort(
    (left, right) =>
      left.anchor.start.timestampMs - right.anchor.start.timestampMs ||
      left.candidate.start.timestampMs - right.candidate.start.timestampMs,
  );
  return { ...result, matches, status: bounded ? "bounded" : "complete" };
}

/** Compare the original anchor section with strictly earlier recorded passes. */
export function matchGhostRouteSection(
  anchorPoints: readonly GhostTrackPoint[],
  candidatePoints: readonly GhostTrackPoint[],
  bounds: RecordedBounds,
): GhostRouteMatchResult {
  const result = matchEarlierPasses(anchorPoints, candidatePoints, bounds);
  if (!result.matches.length) return result;
  // Preparation keeps canonical distance. At exact sample times preserve the
  // original coordinates too, including longitudes at the antimeridian.
  const original = new Map(
    anchorPoints
      .slice(bounds.start.originalIndex, bounds.end.originalIndex + 1)
      .map((point) => [point.timestampMs, point]),
  );
  const restoreAnchor = (point: MatchedPosition) => {
    const exact = original.get(point.timestampMs);
    return exact && exact.lat !== null && exact.lng !== null
      ? { ...point, lat: exact.lat, lng: exact.lng }
      : point;
  };
  return {
    ...result,
    matches: result.matches.map((match) => ({
      ...match,
      anchor: {
        ...match.anchor,
        start: restoreAnchor(match.anchor.start),
        end: restoreAnchor(match.anchor.end),
      },
      replay: match.replay.map(({ anchor, candidate }) => ({
        anchor: restoreAnchor(anchor),
        candidate,
      })),
    })),
  };
}

function collapseAltitude(samples: readonly RecordedAltitude[]): RecordedAltitude[] {
  const ordered: RecordedAltitude[] = [];
  for (const { timestampMs, altitudeMeters } of samples) {
    const previous = ordered.at(-1);
    if (!Number.isFinite(timestampMs) || (previous && timestampMs < previous.timestampMs))
      return [];
    const value =
      altitudeMeters !== null && Number.isFinite(altitudeMeters) ? altitudeMeters : null;
    if (previous?.timestampMs !== timestampMs) ordered.push({ timestampMs, altitudeMeters: value });
    else if (previous.altitudeMeters !== value) previous.altitudeMeters = null;
  }
  return ordered;
}

function* coveredAltitudeRuns(
  chunks: readonly GhostRecordedWaypoint[][],
  altitude: readonly RecordedAltitude[],
) {
  let altitudeIndex = 0;
  for (const chunk of chunks) {
    const first = chunk[0];
    const last = chunk.at(-1);
    if (!first || !last) continue;
    let sample = altitude[altitudeIndex];
    while (sample && sample.timestampMs < first.timestampMs) {
      altitudeIndex += 1;
      sample = altitude[altitudeIndex];
    }
    let gpsIndex = 0;
    let run: CoveredAltitude[] = [];
    while (sample && sample.timestampMs <= last.timestampMs) {
      const { timestampMs, altitudeMeters } = sample;
      let next = chunk[gpsIndex + 1];
      while (next && next.timestampMs <= timestampMs) {
        gpsIndex += 1;
        next = chunk[gpsIndex + 1];
      }
      const before = chunk[gpsIndex];
      const after = before?.timestampMs === timestampMs ? before : next;
      if (
        altitudeMeters !== null &&
        before &&
        after &&
        timestampMs - before.timestampMs <= maximumGpsBracketMs &&
        after.timestampMs - timestampMs <= maximumGpsBracketMs
      ) {
        run.push({ timestampMs, altitudeMeters, before, after });
      } else if (run.length) {
        yield run;
        run = [];
      }
      altitudeIndex += 1;
      sample = altitude[altitudeIndex];
    }
    if (run.length) yield run;
  }
}

function altitudeGapLimit(run: readonly CoveredAltitude[]): number {
  const intervals: number[] = [];
  let previous: CoveredAltitude | undefined;
  for (const sample of run) {
    if (previous) intervals.push(sample.timestampMs - previous.timestampMs);
    previous = sample;
  }
  intervals.sort((left, right) => left - right);
  const median = intervals[Math.floor(intervals.length / 2)] ?? 0;
  return Math.min(maximumAltitudeGapMs, Math.max(minimumAltitudeGapMs, 2 * median));
}

function climbBounds(
  first: CoveredAltitude | undefined,
  last: CoveredAltitude | undefined,
  blocks: number,
): RecordedBounds | null {
  if (!first || !last || blocks < minimumRisingBlocks) return null;
  const start = first.before;
  const end = last.after;
  const distance = end.distanceMeters - start.distanceMeters;
  const rise = last.altitudeMeters - first.altitudeMeters;
  return distance >= climbBlockMeters * minimumRisingBlocks &&
    rise >= minimumRiseMeters &&
    rise / distance >= minimumClimbGrade
    ? { start, end }
    : null;
}

function* sustainedClimbs(run: readonly CoveredAltitude[]) {
  const maximumGapMs = altitudeGapLimit(run);
  let previous: CoveredAltitude | undefined;
  let blockStart: CoveredAltitude | undefined;
  let climbStart: CoveredAltitude | undefined;
  let summit: CoveredAltitude | undefined;
  let blocks = 0;
  for (const sample of run) {
    const gap = previous && sample.timestampMs - previous.timestampMs > maximumGapMs;
    previous = sample;
    if (!blockStart) {
      blockStart = sample;
      continue;
    }
    const distance = sample.before.distanceMeters - blockStart.before.distanceMeters;
    if (!gap && distance < climbBlockMeters) continue;
    if (
      !gap &&
      (sample.altitudeMeters - blockStart.altitudeMeters) / distance >= minimumBlockGrade
    ) {
      climbStart ??= blockStart;
      summit = sample;
      blocks += 1;
    } else {
      const section = climbBounds(climbStart, summit, blocks);
      if (section) yield section;
      climbStart = undefined;
      summit = undefined;
      blocks = 0;
    }
    blockStart = sample;
  }
  const section = climbBounds(climbStart, summit, blocks);
  if (section) yield section;
}

/** Supply selected-source observations in time order, with null marking unusable evidence. */
export function findUnnamedGhostClimbs(
  points: readonly GhostTrackPoint[],
  altitude: readonly RecordedAltitude[],
): { sections: RecordedBounds[]; bounded: boolean } {
  if (altitude.length > maximumAltitudeSamples) return { sections: [], bounded: true };
  const recording = recordedGhostRouteChunks(points);
  const sections: RecordedBounds[] = [];
  for (const run of coveredAltitudeRuns(recording.chunks, collapseAltitude(altitude))) {
    for (const section of sustainedClimbs(run)) {
      if (sections.length >= maximumClimbs) return { sections, bounded: true };
      sections.push(section);
    }
  }
  return { sections, bounded: recording.bounded };
}
