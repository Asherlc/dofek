import {
  evaluateRouteMatch,
  MAXIMUM_ROUTE_COMPARISON_WORK,
  ROUTE_MATCH_THRESHOLDS,
  routeComparisonWork,
} from "@dofek/training/route-equivalence";

export interface GhostTrackPoint {
  timestampMs: number;
  lat: number | null;
  lng: number | null;
}

interface GhostPosition {
  timestampMs: number;
  lat: number;
  lng: number;
  distanceMeters: number;
}

interface GhostInterval {
  start: GhostPosition;
  end: GhostPosition;
  elapsedMs: number;
}

interface ReplayPosition {
  anchor: GhostPosition;
  candidate: GhostPosition;
}

interface GhostRouteMatch {
  kind: "full-route" | "shared-stretch";
  anchor: GhostInterval;
  candidate: GhostInterval;
  elapsedDifferenceMs: number;
  replay: ReplayPosition[];
  replayDownsampled: boolean;
}

type TrackCoverage = "complete" | "partial" | "unusable";

export interface GhostRouteMatchResult {
  status: "complete" | "bounded";
  anchorCoverage: TrackCoverage;
  candidateCoverage: TrackCoverage;
  matches: GhostRouteMatch[];
}

const metersPerDegree = (6_371_000 * Math.PI) / 180;
const maximumTrackPoints = 20_000;
const maximumProjectionDegrees = 2;
const maximumProjectionLatitude = 75;
const maximumGapMs = ROUTE_MATCH_THRESHOLDS.largest_gap_seconds * 1_000;
const minimumCadenceGapMs = 5_000;
const maximumJumpMeters = 80;
const maximumSpeedMetersPerSecond = 35;
const minimumOverlapMeters = 120;
const typicalLateralMeters = 6;
const maximumLateralMeters = 9;
const minimumHeadingCosine = Math.cos((35 * Math.PI) / 180);
const maximumHeadingSegmentMeters = 8;
const maximumHeadingContextMeters = 18;
const maximumHeadingContextSegments = 4;
const maximumSeamMeters = 2;
const maximumFullRouteTrimMeters = 25;
const spatialCellMeters = 32;
const maximumIndexVisits = 250_000;
const maximumMatches = 32;
const maximumReplayPoints = 96;
const maximumNormalizedRoutePoints = 64;
const distanceEpsilon = 0.000_01;

interface PlanePoint {
  east: number;
  north: number;
}

type ProjectedPoint = Omit<GhostPosition, "distanceMeters"> & PlanePoint;
type LocatedPoint = ProjectedPoint & Pick<GhostPosition, "distanceMeters">;

interface Segment {
  chunk: number;
  start: LocatedPoint;
  end: LocatedPoint;
  arrival: LocatedPoint;
  startsChunk: boolean;
  length: number;
  direction: PlanePoint;
  heading: PlanePoint;
}

interface Track {
  coverage: TrackCoverage;
  segments: Segment[];
  distanceMeters: number;
}

interface AlignedPiece {
  anchorSegment: Segment;
  candidateSegment: Segment;
  start: ReplayPosition;
  end: ReplayPosition;
  arrival: ReplayPosition;
}

interface Alignment {
  piece: AlignedPiece;
  start: ReplayPosition;
  firstAnchorSegment: Segment;
  previous: Alignment | undefined;
}

function difference(end: PlanePoint, start: PlanePoint): PlanePoint {
  return { east: end.east - start.east, north: end.north - start.north };
}

function dot(left: PlanePoint, right: PlanePoint): number {
  return left.east * right.east + left.north * right.north;
}

function position(point: GhostTrackPoint): point is GhostTrackPoint & { lat: number; lng: number } {
  return (
    point.lat !== null &&
    point.lng !== null &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lng) <= 180
  );
}

function unavailableTrack(): Track {
  return { coverage: "unusable", segments: [], distanceMeters: 0 };
}

function collapseTiedPositions(points: readonly GhostTrackPoint[]): GhostTrackPoint[] {
  const observations: GhostTrackPoint[] = [];
  for (const point of points) {
    const prior = observations.at(-1);
    if (prior?.timestampMs !== point.timestampMs) {
      observations.push(point);
    } else if (prior.lat !== point.lat || prior.lng !== point.lng) {
      observations[observations.length - 1] = {
        timestampMs: point.timestampMs,
        lat: null,
        lng: null,
      };
    }
  }
  return observations;
}

function stabilizeHeadings(segments: Segment[]): void {
  for (const [index, segment] of segments.entries()) {
    if (segment.length > maximumHeadingSegmentMeters) continue;
    let start = segment.start;
    let end = segment.end;
    // Average nested chords so a changing outer sample does not move the
    // projection axis abruptly between neighboring raw segments.
    const chord = { east: 0, north: 0 };
    for (let step = 1; step <= maximumHeadingContextSegments; step += 1) {
      const before = segments[index - step];
      const after = segments[index + step];
      if (
        before?.chunk === segment.chunk &&
        segment.start.distanceMeters - before.start.distanceMeters <= maximumHeadingContextMeters
      )
        start = before.start;
      if (
        after?.chunk === segment.chunk &&
        after.end.distanceMeters - segment.end.distanceMeters <= maximumHeadingContextMeters
      )
        end = after.end;
      chord.east += end.east - start.east;
      chord.north += end.north - start.north;
    }
    const length = Math.hypot(chord.east, chord.north);
    // A local reversal can fold the chord back. Keep the recorded direction
    // when the surrounding positions do not establish forward movement.
    if (
      length > segment.length * maximumHeadingContextSegments &&
      dot(chord, segment.direction) > length * 0.1
    )
      segment.heading = { east: chord.east / length, north: chord.north / length };
  }
}

function movingGapLimitMs(points: readonly ProjectedPoint[]): number {
  const intervals: number[] = [];
  let previous: ProjectedPoint | undefined;
  for (const point of points) {
    if (previous) intervals.push(point.timestampMs - previous.timestampMs);
    previous = point;
  }
  intervals.sort((left, right) => left - right);
  // Use the same positive median interval rule as activity route coverage.
  const median = intervals[Math.floor(intervals.length / 2)] ?? 0;
  return Math.min(maximumGapMs, Math.max(minimumCadenceGapMs, 2 * median));
}

function prepareTrack(
  points: readonly GhostTrackPoint[],
  origin: { lat: number; lng: number },
): Track | null {
  const longitudeScale = metersPerDegree * Math.cos((origin.lat * Math.PI) / 180);
  let rawChunk: ProjectedPoint[] = [];
  const rawChunks = [rawChunk];
  let coverage: TrackCoverage = "complete";
  let previousTimestampMs = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.timestampMs) || point.timestampMs <= previousTimestampMs)
      return unavailableTrack();
    previousTimestampMs = point.timestampMs;
    if (!position(point)) {
      if (rawChunk.length > 0) {
        rawChunk = [];
        rawChunks.push(rawChunk);
      }
      coverage = "partial";
      continue;
    }
    const deltaLongitude = point.lng - origin.lng;
    const longitudeOffset =
      deltaLongitude > 180
        ? deltaLongitude - 360
        : deltaLongitude < -180
          ? deltaLongitude + 360
          : deltaLongitude;
    const latitudeOffset = point.lat - origin.lat;
    if (
      Math.abs(point.lat) > maximumProjectionLatitude ||
      Math.abs(latitudeOffset) > maximumProjectionDegrees ||
      Math.abs(longitudeOffset) > maximumProjectionDegrees
    )
      return null;
    const current: ProjectedPoint = {
      lat: point.lat,
      lng: origin.lng + longitudeOffset,
      timestampMs: point.timestampMs,
      east: longitudeOffset * longitudeScale,
      north: latitudeOffset * metersPerDegree,
    };
    const previous = rawChunk.at(-1);
    if (previous) {
      const offset = difference(current, previous);
      const length = Math.hypot(offset.east, offset.north);
      const intervalMs = current.timestampMs - previous.timestampMs;
      if (
        intervalMs > maximumGapMs ||
        length > maximumJumpMeters ||
        length > (maximumSpeedMetersPerSecond * intervalMs) / 1_000
      ) {
        coverage = "partial";
        rawChunk = [];
        rawChunks.push(rawChunk);
      }
    }
    rawChunk.push(current);
  }

  const segments: Segment[] = [];
  let distanceMeters = 0;
  let chunk = 0;
  for (const observations of rawChunks) {
    const movingGapMs = movingGapLimitMs(observations);
    let previous: LocatedPoint | undefined;
    let arrival: LocatedPoint | undefined;
    chunk += 1;
    for (const observation of observations) {
      const current = { ...observation, distanceMeters };
      if (previous && arrival) {
        const offset = difference(current, previous);
        const length = Math.hypot(offset.east, offset.north);
        // A stationary interval has recorded endpoints at the same location.
        // Apply the cadence limit only to motion that would need interpolation.
        if (length > distanceEpsilon) {
          if (current.timestampMs - previous.timestampMs > movingGapMs) {
            coverage = "partial";
            chunk += 1;
          } else {
            distanceMeters += length;
            current.distanceMeters = distanceMeters;
            const direction = { east: offset.east / length, north: offset.north / length };
            segments.push({
              chunk,
              start: previous,
              end: current,
              arrival,
              startsChunk: segments.at(-1)?.chunk !== chunk,
              length,
              direction,
              heading: direction,
            });
          }
          arrival = current;
        }
      } else {
        arrival = current;
      }
      previous = current;
    }
  }
  if (segments.length === 0) return unavailableTrack();
  stabilizeHeadings(segments);
  return { coverage, segments, distanceMeters };
}

function segmentPosition(segment: Segment, meters: number): GhostPosition {
  const fraction =
    meters <= distanceEpsilon
      ? 0
      : meters >= segment.length - distanceEpsilon
        ? 1
        : meters / segment.length;
  const start = segment.start;
  const end = segment.end;
  const lng = start.lng + fraction * (end.lng - start.lng);
  return {
    timestampMs:
      fraction === 1
        ? end.timestampMs
        : start.timestampMs +
          Math.round(fraction * (end.timestampMs - start.timestampMs) * 1_000) / 1_000,
    lat: start.lat + fraction * (end.lat - start.lat),
    lng: lng > 180 ? lng - 360 : lng < -180 ? lng + 360 : lng,
    distanceMeters: start.distanceMeters + fraction * segment.length,
  };
}

function arrivalAtStart(segment: Segment, meters: number, start: GhostPosition): GhostPosition {
  // A stop between traversals belongs to the interval only when it is interior.
  return segment.startsChunk && meters <= distanceEpsilon
    ? { ...start, timestampMs: segment.arrival.timestampMs }
    : start;
}

/** Summarize the anchor's recorded route without joining across GPS gaps. */
export function summarizeGhostTrack(points: readonly GhostTrackPoint[]): {
  gpsCoverage: TrackCoverage;
  anchor: GhostInterval | null;
  geometry: { lat: number; lng: number }[][];
} {
  const unavailable = { gpsCoverage: "unusable" as const, anchor: null, geometry: [] };
  if (points.length > maximumTrackPoints) return unavailable;
  const observations = collapseTiedPositions(points);
  const origin = observations.find(position);
  const track = origin && prepareTrack(observations, origin);
  const first = track?.segments[0];
  const last = track?.segments.at(-1);
  if (!track || !first || !last) return unavailable;

  const geometry: { lat: number; lng: number }[][] = [];
  // Match the shared response caps for geometry chunks and recorded vertices.
  for (let index = 0; index < track.segments.length && geometry.length < 8; ) {
    const startSegment = track.segments[index];
    if (!startSegment) break;
    let endIndex = index + 1;
    while (track.segments[endIndex]?.chunk === startSegment.chunk) endIndex += 1;

    const vertexCount = Math.min(endIndex - index + 1, 96);
    const start = segmentPosition(startSegment, 0);
    const vertices = [{ lat: start.lat, lng: start.lng }];
    for (let vertex = 1; vertex < vertexCount; vertex += 1) {
      const segmentIndex =
        index + Math.round((vertex * (endIndex - index)) / (vertexCount - 1)) - 1;
      const segment = track.segments[segmentIndex];
      if (segment) {
        const end = segmentPosition(segment, segment.length);
        vertices.push({ lat: end.lat, lng: end.lng });
      }
    }
    geometry.push(vertices);
    index = endIndex;
  }

  const start = arrivalAtStart(first, 0, segmentPosition(first, 0));
  const end = segmentPosition(last, last.length);
  return {
    gpsCoverage: track.coverage,
    anchor:
      track.coverage === "complete"
        ? { start, end, elapsedMs: end.timestampMs - start.timestampMs }
        : null,
    geometry,
  };
}

/** Intersect the segments' recorded ranges along the anchor's direction of travel. */
function alignSegments(anchor: Segment, candidate: Segment): AlignedPiece | undefined {
  const axis = anchor.heading;
  if (dot(axis, candidate.heading) < minimumHeadingCosine) return undefined;
  const anchorProgress = dot(axis, anchor.direction);
  const candidateProgress = dot(axis, candidate.direction);
  if (anchorProgress <= distanceEpsilon || candidateProgress <= distanceEpsilon) return undefined;
  const candidateOffset = difference(candidate.start, anchor.start);
  const projectedStart = dot(candidateOffset, axis);
  const from = Math.max(0, projectedStart);
  const to = Math.min(
    anchor.length * anchorProgress,
    projectedStart + candidate.length * candidateProgress,
  );
  if (to - from <= distanceEpsilon) return undefined;
  const anchorFrom = from / anchorProgress;
  const anchorTo = to / anchorProgress;
  const candidateFrom = (from - projectedStart) / candidateProgress;
  const candidateTo = (to - projectedStart) / candidateProgress;
  const normal = { east: -axis.north, north: axis.east };
  const lateralOffset = dot(candidateOffset, normal);
  const anchorLateral = dot(anchor.direction, normal);
  const candidateLateral = dot(candidate.direction, normal);
  const lateralFrom = lateralOffset + candidateFrom * candidateLateral - anchorFrom * anchorLateral;
  const lateralTo = lateralOffset + candidateTo * candidateLateral - anchorTo * anchorLateral;
  const meanSquareLateral = (lateralFrom ** 2 + lateralFrom * lateralTo + lateralTo ** 2) / 3;
  if (
    Math.max(Math.abs(lateralFrom), Math.abs(lateralTo)) > maximumLateralMeters ||
    meanSquareLateral > typicalLateralMeters ** 2
  )
    return undefined;

  const anchorStart = segmentPosition(anchor, anchorFrom);
  const candidateStart = segmentPosition(candidate, candidateFrom);
  return {
    anchorSegment: anchor,
    candidateSegment: candidate,
    start: { anchor: anchorStart, candidate: candidateStart },
    end: {
      anchor: segmentPosition(anchor, anchorTo),
      candidate: segmentPosition(candidate, candidateTo),
    },
    arrival: {
      anchor: arrivalAtStart(anchor, anchorFrom, anchorStart),
      candidate: arrivalAtStart(candidate, candidateFrom, candidateStart),
    },
  };
}

function overlapMeters(start: ReplayPosition, end: ReplayPosition): number {
  return Math.min(
    end.anchor.distanceMeters - start.anchor.distanceMeters,
    end.candidate.distanceMeters - start.candidate.distanceMeters,
  );
}

function canExtend(previous: Alignment, piece: AlignedPiece): boolean {
  const end = previous.piece.end;
  return (
    Math.abs(piece.start.anchor.distanceMeters - end.anchor.distanceMeters) <= maximumSeamMeters &&
    Math.abs(piece.start.candidate.distanceMeters - end.candidate.distanceMeters) <=
      maximumSeamMeters &&
    overlapMeters(end, piece.end) > distanceEpsilon
  );
}

function* segmentCells(segment: Segment, margin: number): Iterable<string> {
  const minEast = Math.min(segment.start.east, segment.end.east) - margin;
  const maxEast = Math.max(segment.start.east, segment.end.east) + margin;
  const minNorth = Math.min(segment.start.north, segment.end.north) - margin;
  const maxNorth = Math.max(segment.start.north, segment.end.north) + margin;
  for (
    let east = Math.floor(minEast / spatialCellMeters);
    east <= Math.floor(maxEast / spatialCellMeters);
    east += 1
  ) {
    for (
      let north = Math.floor(minNorth / spatialCellMeters);
      north <= Math.floor(maxNorth / spatialCellMeters);
      north += 1
    ) {
      yield `${east},${north}`;
    }
  }
}

function alignTracks(anchor: Track, candidate: Track): Set<Alignment> | null {
  const index = new Map<string, number[]>();
  for (const [segmentIndex, segment] of candidate.segments.entries()) {
    for (const cell of segmentCells(segment, 0)) {
      const bucket = index.get(cell);
      if (bucket) bucket.push(segmentIndex);
      else index.set(cell, [segmentIndex]);
    }
  }

  const terminals = new Set<Alignment>();
  let previousRow = new Map<number, Alignment>();
  let previousAnchorChunk: number | undefined;
  let indexVisits = 0;
  for (const anchorSegment of anchor.segments) {
    if (anchorSegment.chunk !== previousAnchorChunk) previousRow.clear();
    previousAnchorChunk = anchorSegment.chunk;

    const nearby = new Set<number>();
    for (const cell of segmentCells(anchorSegment, maximumLateralMeters)) {
      for (const candidateIndex of index.get(cell) ?? []) {
        indexVisits += 1;
        if (indexVisits > maximumIndexVisits) return null;
        nearby.add(candidateIndex);
      }
    }

    const currentRow = new Map<number, Alignment>();
    for (const candidateIndex of [...nearby].sort((left, right) => left - right)) {
      const candidateSegment = candidate.segments[candidateIndex];
      if (!candidateSegment) continue;
      const piece = alignSegments(anchorSegment, candidateSegment);
      if (!piece) continue;
      const previousInChunk =
        candidate.segments[candidateIndex - 1]?.chunk === candidateSegment.chunk;
      const predecessors = [previousRow.get(candidateIndex)];
      if (previousInChunk) {
        predecessors.push(currentRow.get(candidateIndex - 1), previousRow.get(candidateIndex - 1));
      }
      let previous: Alignment | undefined;
      for (const predecessor of predecessors) {
        if (!predecessor || !canExtend(predecessor, piece)) continue;
        if (
          !previous ||
          overlapMeters(predecessor.start, piece.end) > overlapMeters(previous.start, piece.end)
        ) {
          previous = predecessor;
        }
      }

      const alignment = {
        piece,
        start: previous?.start ?? piece.arrival,
        firstAnchorSegment: previous?.firstAnchorSegment ?? anchorSegment,
        previous,
      };
      if (previous) terminals.delete(previous);
      terminals.add(alignment);
      currentRow.set(candidateIndex, alignment);
    }
    previousRow = currentRow;
  }
  return terminals;
}

function routeGeometry(track: Track): GhostPosition[] {
  const geometry: GhostPosition[] = [];
  let segmentIndex = 0;
  for (let index = 0; index < maximumNormalizedRoutePoints; index += 1) {
    const meters = (track.distanceMeters * index) / (maximumNormalizedRoutePoints - 1);
    let segment = track.segments[segmentIndex];
    while (segment && segment.end.distanceMeters < meters - distanceEpsilon) {
      segmentIndex += 1;
      segment = track.segments[segmentIndex];
    }
    if (segment) geometry.push(segmentPosition(segment, meters - segment.start.distanceMeters));
  }
  return geometry;
}

function coversTrack(track: Track, start: GhostPosition, end: GhostPosition): boolean {
  return (
    track.coverage === "complete" &&
    start.distanceMeters <= maximumFullRouteTrimMeters &&
    track.distanceMeters - end.distanceMeters <= maximumFullRouteTrimMeters &&
    (end.distanceMeters - start.distanceMeters) / track.distanceMeters >=
      ROUTE_MATCH_THRESHOLDS.overlap_percentage
  );
}

function coarseRouteMatch(anchor: Track, candidate: Track): "matched" | "different" | "bounded" {
  const left = routeGeometry(anchor);
  const right = routeGeometry(candidate);
  if (routeComparisonWork(left, right) > MAXIMUM_ROUTE_COMPARISON_WORK) return "bounded";
  return evaluateRouteMatch({ left, right })?.matched ? "matched" : "different";
}

function stopDuration(previous: GhostPosition, current: GhostPosition): number {
  return current.distanceMeters - previous.distanceMeters <= distanceEpsilon
    ? current.timestampMs - previous.timestampMs
    : 0;
}

function sampleReplay(replay: ReplayPosition[]): ReplayPosition[] {
  const stops: { departureIndex: number; durationMs: number }[] = [];
  for (const [index, point] of replay.entries()) {
    const prior = replay[index - 1];
    if (!prior) continue;
    const durationMs = Math.max(
      stopDuration(prior.anchor, point.anchor),
      stopDuration(prior.candidate, point.candidate),
    );
    if (durationMs > 0) stops.push({ departureIndex: index, durationMs });
  }
  const keep = new Set([0, replay.length - 1]);
  stops.sort(
    (left, right) =>
      right.durationMs - left.durationMs || left.departureIndex - right.departureIndex,
  );
  for (const { departureIndex } of stops) {
    const arrivalIndex = departureIndex - 1;
    const additionalKeys = Number(!keep.has(arrivalIndex)) + Number(!keep.has(departureIndex));
    if (keep.size + additionalKeys > maximumReplayPoints) continue;
    keep.add(arrivalIndex);
    keep.add(departureIndex);
  }

  const available = Array.from(replay.keys()).filter((index) => !keep.has(index));
  const remaining = maximumReplayPoints - keep.size;
  for (let index = 0; index < remaining; index += 1) {
    const evenlySpacedIndex = available[Math.floor(((index + 0.5) * available.length) / remaining)];
    if (evenlySpacedIndex !== undefined) keep.add(evenlySpacedIndex);
  }
  return replay.filter((_, index) => keep.has(index));
}

function pauseAtStart(segment: Segment, previous: GhostPosition) {
  const arrivalMs = segment.arrival.timestampMs;
  if (arrivalMs >= segment.start.timestampMs || arrivalMs < previous.timestampMs) return undefined;
  const departure = segmentPosition(segment, 0);
  return { arrival: { ...departure, timestampMs: arrivalMs }, departure };
}

function appendReplayPosition(replay: ReplayPosition[], point: ReplayPosition): void {
  const prior = replay.at(-1);
  if (
    prior &&
    point.anchor.timestampMs >= prior.anchor.timestampMs &&
    point.candidate.timestampMs >= prior.candidate.timestampMs &&
    point.anchor.distanceMeters >= prior.anchor.distanceMeters &&
    point.candidate.distanceMeters >= prior.candidate.distanceMeters &&
    (point.anchor.timestampMs > prior.anchor.timestampMs ||
      point.candidate.timestampMs > prior.candidate.timestampMs)
  )
    replay.push(point);
}

function replayPositions(
  alignment: Alignment,
): Pick<GhostRouteMatch, "replay" | "replayDownsampled"> {
  const pieces: AlignedPiece[] = [];
  for (let current: Alignment | undefined = alignment; current; current = current.previous) {
    pieces.push(current.piece);
  }
  const replay = [alignment.start];
  for (const piece of pieces.reverse()) {
    const prior = replay.at(-1);
    if (prior) {
      const anchorPause = pauseAtStart(piece.anchorSegment, prior.anchor);
      const candidatePause = pauseAtStart(piece.candidateSegment, prior.candidate);
      if (anchorPause || candidatePause) {
        // Adjacent projected pieces may trim the sample where a pause was
        // recorded. Keep that sample and pair it with monotone recorded progress.
        const anchor =
          piece.start.anchor.distanceMeters >= prior.anchor.distanceMeters
            ? piece.start.anchor
            : prior.anchor;
        const candidate =
          piece.start.candidate.distanceMeters >= prior.candidate.distanceMeters
            ? piece.start.candidate
            : prior.candidate;
        appendReplayPosition(replay, {
          anchor: anchorPause?.arrival ?? anchor,
          candidate: candidatePause?.arrival ?? candidate,
        });
        appendReplayPosition(replay, {
          anchor: anchorPause?.departure ?? anchor,
          candidate: candidatePause?.departure ?? candidate,
        });
      }
    }
    appendReplayPosition(replay, piece.start);
    replay.push(piece.end);
  }
  if (replay.length <= maximumReplayPoints) return { replay, replayDownsampled: false };
  return { replay: sampleReplay(replay), replayDownsampled: true };
}

function pairedProgress(alignment: Alignment): Map<Segment, [number, number]> {
  const progress = new Map<Segment, [number, number]>();
  for (let current: Alignment | undefined = alignment; current; current = current.previous) {
    const { anchorSegment, start, end } = current.piece;
    const range = progress.get(anchorSegment);
    if (range) range[0] = Math.min(range[0], start.candidate.distanceMeters);
    else
      progress.set(anchorSegment, [start.candidate.distanceMeters, end.candidate.distanceMeters]);
  }
  return progress;
}

function includesProgress(range: [number, number] | undefined, distanceMeters: number): boolean {
  return (
    range !== undefined &&
    range[0] - maximumSeamMeters <= distanceMeters &&
    distanceMeters <= range[1] + maximumSeamMeters
  );
}

function containsSamePairing(
  outer: Alignment,
  progress: Map<Segment, [number, number]>,
  inner: Alignment,
): boolean {
  // The windows can contain cross-lap matches. Check the candidate progress
  // actually paired with both boundary segments of the shorter anchor span.
  return (
    outer.start.anchor.distanceMeters <= inner.start.anchor.distanceMeters + maximumSeamMeters &&
    outer.start.candidate.distanceMeters <=
      inner.start.candidate.distanceMeters + maximumSeamMeters &&
    outer.piece.end.anchor.distanceMeters >=
      inner.piece.end.anchor.distanceMeters - maximumSeamMeters &&
    outer.piece.end.candidate.distanceMeters >=
      inner.piece.end.candidate.distanceMeters - maximumSeamMeters &&
    includesProgress(
      progress.get(inner.firstAnchorSegment),
      inner.start.candidate.distanceMeters,
    ) &&
    includesProgress(
      progress.get(inner.piece.anchorSegment),
      inner.piece.end.candidate.distanceMeters,
    )
  );
}

function toMatch(alignment: Alignment, fullRoute: boolean): GhostRouteMatch {
  const start = alignment.start;
  const end = alignment.piece.end;
  const anchorElapsedMs = end.anchor.timestampMs - start.anchor.timestampMs;
  const candidateElapsedMs = end.candidate.timestampMs - start.candidate.timestampMs;
  return {
    kind: fullRoute ? "full-route" : "shared-stretch",
    anchor: { start: start.anchor, end: end.anchor, elapsedMs: anchorElapsedMs },
    candidate: { start: start.candidate, end: end.candidate, elapsedMs: candidateElapsedMs },
    elapsedDifferenceMs: anchorElapsedMs - candidateElapsedMs,
    ...replayPositions(alignment),
  };
}

/** Find independently timed, same-direction spans in two recorded operations. */
export function matchGhostRoutes(
  anchorPoints: readonly GhostTrackPoint[],
  candidatePoints: readonly GhostTrackPoint[],
): GhostRouteMatchResult {
  const result: GhostRouteMatchResult = {
    status: "complete",
    anchorCoverage: "unusable",
    candidateCoverage: "unusable",
    matches: [],
  };
  if (anchorPoints.length > maximumTrackPoints || candidatePoints.length > maximumTrackPoints)
    return { ...result, status: "bounded" };
  const anchorObservations = collapseTiedPositions(anchorPoints);
  const candidateObservations = collapseTiedPositions(candidatePoints);
  const origin = anchorObservations.find(position) ?? candidateObservations.find(position);
  if (!origin) return result;

  const anchor = prepareTrack(anchorObservations, origin);
  const candidate = prepareTrack(candidateObservations, origin);
  result.anchorCoverage = anchor?.coverage ?? "unusable";
  result.candidateCoverage = candidate?.coverage ?? "unusable";
  if (!anchor || !candidate) return { ...result, status: "bounded" };
  if (anchor.coverage === "unusable" || candidate.coverage === "unusable") return result;

  const terminals = alignTracks(anchor, candidate);
  if (!terminals) return { ...result, status: "bounded" };
  const eligible = [...terminals]
    .filter(
      ({ piece, start }) =>
        overlapMeters(start, piece.end) >= minimumOverlapMeters - distanceEpsilon,
    )
    .sort(
      (left, right) =>
        overlapMeters(right.start, right.piece.end) - overlapMeters(left.start, left.piece.end),
    );
  const selected = new Map<Alignment, ReturnType<typeof pairedProgress>>();
  for (const alignment of eligible) {
    let duplicate = false;
    for (const [prior, progress] of selected) {
      if (containsSamePairing(prior, progress, alignment)) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;
    if (selected.size === maximumMatches) {
      result.status = "bounded";
      break;
    }
    selected.set(alignment, pairedProgress(alignment));
  }
  const matches = [...selected.keys()];
  const completeRoute = matches.find(
    ({ start, piece: { end } }) =>
      coversTrack(anchor, start.anchor, end.anchor) &&
      coversTrack(candidate, start.candidate, end.candidate),
  );
  const coarse = completeRoute ? coarseRouteMatch(anchor, candidate) : "different";
  if (coarse === "bounded") result.status = "bounded";
  result.matches = matches
    .sort(
      (left, right) =>
        left.start.anchor.timestampMs - right.start.anchor.timestampMs ||
        left.start.candidate.timestampMs - right.start.candidate.timestampMs,
    )
    .map((alignment) => toMatch(alignment, alignment === completeRoute && coarse === "matched"));
  return result;
}
