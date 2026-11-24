import { z } from "zod";
import {
  type GhostRecordedWaypoint,
  type GhostTrackPoint,
  recordedGhostRouteChunks,
} from "./ghost-route-matching.ts";

interface GhostRouteLabelRequest {
  sport: "running" | "cycling";
  points: readonly GhostTrackPoint[];
  enabled: boolean;
  canDispatch: () => Promise<boolean>;
  signal?: AbortSignal;
}

interface GhostRouteLabelConfig {
  apiKey: string;
  region: "global" | "eu";
}

interface Label {
  kind: "named-road" | "named-trail";
  name: string;
}

interface GhostMapSection extends Label {
  start: GhostRecordedWaypoint;
  end: GhostRecordedWaypoint;
  attribution: string;
}

type ProviderError = {
  status: "error";
  reason: "rate-limited" | "request-failed" | "invalid-response";
  retryAfterSeconds?: number;
};

type GhostRouteLabelResult =
  | { status: "disabled" | "cancelled" }
  | ProviderError
  | {
      status: "ready" | "unavailable";
      sections: GhostMapSection[];
      coverage: { sampledWaypoints: number; confirmedWaypoints: number; bounded: boolean };
    };

const maximumPieces = 4;
const maximumWaypoints = 100;
const waypointSpacingMeters = 20;
const turnContextMeters = 10;
const turnHeadingCosine = Math.cos(Math.PI / 3);
const minimumSectionMeters = 40;
const minimumConfirmedFraction = 0.8;
const maximumMatchMeters = 15;
const originalEchoToleranceDegrees = 0.000_001;
const stepSnapToleranceMeters = 3;
const progressionToleranceMeters = 0.001;
const requestTimeoutMs = 5_000;
const maximumResponseBytes = 1_048_576;
const maximumRetryAfterSeconds = 3_600;
const maximumLegs = 8;
const maximumSteps = 512;
const maximumVertices = 4_096;
const maximumSections = 64;
const attribution = "© OpenStreetMap contributors · Powered by Geoapify";
const metersPerDegree = (6_371_000 * Math.PI) / 180;
const roadClasses = new Set([
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
]);
const trailClasses = new Set(["path", "footway", "bridleway", "cycleway"]);

const coordinateSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
type Coordinate = z.infer<typeof coordinateSchema>;
const indexSchema = z.number().int().nonnegative();
const tagsSchema = z.object({
  highway: z.string().optional(),
  path: z.string().optional(),
  footway: z.string().optional(),
  cycleway: z.string().optional(),
  crossing: z.string().optional(),
});
const stepSchema = z.object({
  name: z.string().nullish(),
  from_index: indexSchema,
  to_index: indexSchema,
  osmtags: tagsSchema.nullish(),
});
const waypointSchema = z.object({
  original_index: indexSchema,
  original_location: coordinateSchema.nullish(),
  location: coordinateSchema.nullish(),
  match_type: z.string(),
  match_distance: z.number().nonnegative().nullish(),
  leg_index: indexSchema.nullish(),
  step_index: indexSchema.nullish(),
});
const featureSchema = z.object({
  type: z.literal("Feature"),
  geometry: z.object({
    type: z.literal("MultiLineString"),
    coordinates: z.array(z.array(coordinateSchema).min(2).max(maximumVertices)).max(maximumLegs),
  }),
  properties: z.object({
    legs: z
      .array(z.object({ steps: z.array(stepSchema).min(1).max(maximumSteps) }))
      .max(maximumLegs),
    waypoints: z.array(waypointSchema).max(maximumWaypoints),
  }),
});
const collectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(featureSchema).max(1),
});

interface NamedStep {
  from: number;
  to: number;
  label: Label | null;
  groupIndex: number;
}

interface Leg {
  coordinates: Coordinate[];
  steps: NamedStep[];
}

interface Mapping {
  location: Coordinate;
  label: Label | null;
  legIndex: number;
  stepIndex: number;
  groupIndex: number;
  progress: number;
}

interface Evidence {
  point: GhostRecordedWaypoint;
  mapping: Mapping | null;
  label: Label | null;
  continuesPrevious: boolean;
}

function coordinate(point: GhostRecordedWaypoint): Coordinate {
  return [point.lng, point.lat];
}

function longitudeOffset(longitude: number, origin: number): number {
  const offset = longitude - origin;
  if (offset > 180) return offset - 360;
  if (offset < -180) return offset + 360;
  return offset;
}

function offsetMeters(origin: Coordinate, target: Coordinate): Coordinate {
  return [
    longitudeOffset(target[0], origin[0]) * metersPerDegree * Math.cos((origin[1] * Math.PI) / 180),
    (target[1] - origin[1]) * metersPerDegree,
  ];
}

function separationMeters(left: Coordinate, right: Coordinate): number {
  return Math.hypot(...offsetMeters(left, right));
}

function sharpTurn(
  before: GhostRecordedWaypoint,
  at: GhostRecordedWaypoint,
  after: GhostRecordedWaypoint,
) {
  const [beforeEast, beforeNorth] = offsetMeters(coordinate(at), coordinate(before));
  const [afterEast, afterNorth] = offsetMeters(coordinate(at), coordinate(after));
  const scale = Math.hypot(beforeEast, beforeNorth) * Math.hypot(afterEast, afterNorth);
  return (
    scale > 0 && -(beforeEast * afterEast + beforeNorth * afterNorth) <= scale * turnHeadingCosine
  );
}

function sampleChunk(chunk: readonly GhostRecordedWaypoint[]): GhostRecordedWaypoint[] {
  // Stationary samples stay available in the recording. One original visit is
  // sufficient for lookup, and the final endpoint retains its recorded time.
  const points = chunk.filter(
    (point, index) =>
      index === chunk.length - 1 || point.distanceMeters !== chunk[index - 1]?.distanceMeters,
  );
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last || first === last) return [];
  const selected = [first];
  let previous = first;
  let beforeIndex = 0;
  let afterIndex = 1;
  for (const [index, point] of points.entries()) {
    if (index === 0 || point === last || point.distanceMeters === last.distanceMeters) continue;
    while (beforeIndex + 1 < index) {
      const nearer = points[beforeIndex + 1];
      if (!nearer || point.distanceMeters - nearer.distanceMeters < turnContextMeters) break;
      beforeIndex += 1;
    }
    while (afterIndex < points.length) {
      const after = points[afterIndex];
      if (!after || after.distanceMeters - point.distanceMeters >= turnContextMeters) break;
      afterIndex += 1;
    }
    const before = points[beforeIndex];
    const after = points[afterIndex];
    if (
      point.distanceMeters - previous.distanceMeters >= waypointSpacingMeters ||
      (before &&
        after &&
        point.distanceMeters - before.distanceMeters >= turnContextMeters &&
        sharpTurn(before, point, after))
    ) {
      selected.push(point);
      previous = point;
    }
  }
  selected.push(last);
  return selected;
}

function* pieces(chunks: readonly GhostRecordedWaypoint[][]) {
  for (const chunk of chunks) {
    const selected = sampleChunk(chunk);
    for (let start = 0; start < selected.length - 1; start += maximumWaypoints - 1) {
      const piece = selected.slice(start, start + maximumWaypoints);
      const first = piece[0];
      if (
        first &&
        piece.some(
          (point) => point.lat !== first.lat || longitudeOffset(point.lng, first.lng) !== 0,
        )
      )
        yield piece;
    }
  }
}

function stepLabel(step: z.infer<typeof stepSchema>): Label | null {
  const name = step.name?.trim();
  const tags = step.osmtags;
  const highway = tags?.highway;
  if (!name || name.length > 256 || !highway) return null;
  if (roadClasses.has(highway)) return { kind: "named-road", name };
  if (
    trailClasses.has(highway) &&
    tags.footway !== "sidewalk" &&
    tags.footway !== "crossing" &&
    tags.cycleway !== "crossing" &&
    tags.path !== "crossing" &&
    (!tags.crossing || tags.crossing === "no")
  ) {
    return { kind: "named-trail", name };
  }
  return null;
}

function sameLabel(left: Label | null, right: Label | null): boolean {
  return left?.kind === right?.kind && left?.name === right?.name;
}

function prepareLegs(feature: z.infer<typeof featureSchema>): Leg[] | null {
  const { legs } = feature.properties;
  if (legs.length !== feature.geometry.coordinates.length || legs.length === 0) return null;
  const prepared: Leg[] = [];
  let totalVertices = 0;
  let totalSteps = 0;
  for (const [index, leg] of legs.entries()) {
    const coordinates = feature.geometry.coordinates[index];
    if (!coordinates) return null;
    totalVertices += coordinates.length;
    totalSteps += leg.steps.length;
    if (totalVertices > maximumVertices || totalSteps > maximumSteps) return null;
    const steps: NamedStep[] = [];
    for (const [stepIndex, step] of leg.steps.entries()) {
      const from = step.from_index;
      const to = step.to_index;
      const previous = steps.at(-1);
      if (from >= to || to >= coordinates.length || (previous && from < previous.to)) return null;
      const label = stepLabel(step);
      const groupIndex =
        label && previous?.to === from && sameLabel(previous.label, label)
          ? previous.groupIndex
          : stepIndex;
      steps.push({ from, to, label, groupIndex });
    }
    prepared.push({ coordinates, steps });
  }
  return prepared;
}

function stepProgress(
  location: Coordinate,
  line: Coordinate[],
  { from, to }: NamedStep,
): number | null {
  let distanceAlong = 0;
  let minimumProgress = Infinity;
  let maximumProgress = -Infinity;
  let bestDistance = Infinity;
  let bestProgress: number | null = null;
  const longitudeScale = metersPerDegree * Math.cos((location[1] * Math.PI) / 180);
  for (let index = from; index < to; index += 1) {
    const start = line[index];
    const end = line[index + 1];
    if (!start || !end) return null;
    const [startEast, startNorth] = offsetMeters(location, start);
    // Follow the segment across the dateline in its own direction. Wrapping
    // both endpoints around a remote snap can put them on opposite sides of it.
    const east = longitudeOffset(end[0], start[0]) * longitudeScale;
    const north = (end[1] - start[1]) * metersPerDegree;
    const length = Math.hypot(east, north);
    if (length === 0) continue;
    const fraction = Math.min(
      1,
      Math.max(0, -(startEast * east + startNorth * north) / length ** 2),
    );
    const distance = Math.hypot(startEast + fraction * east, startNorth + fraction * north);
    if (distance <= stepSnapToleranceMeters) {
      const progress = distanceAlong + fraction * length;
      minimumProgress = Math.min(minimumProgress, progress);
      maximumProgress = Math.max(maximumProgress, progress);
      if (
        maximumProgress - minimumProgress >
        2 * stepSnapToleranceMeters + progressionToleranceMeters
      )
        return null;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestProgress = progress;
      }
    }
    distanceAlong += length;
  }
  return bestProgress;
}

function mapWaypoint(
  waypoint: z.infer<typeof waypointSchema>,
  original: GhostRecordedWaypoint,
  legs: Leg[],
): Mapping | null {
  const {
    location,
    original_location: echo,
    match_distance: distance,
    leg_index: legIndex,
    step_index: stepIndex,
  } = waypoint;
  if (
    waypoint.match_type !== "matched" ||
    !location ||
    !echo ||
    distance == null ||
    distance > maximumMatchMeters ||
    legIndex == null ||
    stepIndex == null ||
    Math.abs(longitudeOffset(echo[0], original.lng)) > originalEchoToleranceDegrees ||
    Math.abs(echo[1] - original.lat) > originalEchoToleranceDegrees ||
    separationMeters(coordinate(original), location) > maximumMatchMeters
  )
    return null;
  const leg = legs[legIndex];
  const step = leg?.steps[stepIndex];
  if (!leg || !step) return null;
  const progress = stepProgress(location, leg.coordinates, step);
  return progress === null
    ? null
    : {
        location,
        label: step.label,
        groupIndex: step.groupIndex,
        legIndex,
        stepIndex,
        progress,
      };
}

function followsMapping(previous: Mapping | null, mapping: Mapping) {
  if (!previous || mapping.legIndex > previous.legIndex) return true;
  if (mapping.legIndex < previous.legIndex) return false;
  if (mapping.stepIndex !== previous.stepIndex) return mapping.stepIndex > previous.stepIndex;
  return mapping.progress + progressionToleranceMeters >= previous.progress;
}

function parseMappings(value: unknown, sent: GhostRecordedWaypoint[]): (Mapping | null)[] | null {
  const parsed = collectionSchema.safeParse(value);
  if (!parsed.success) return null;
  const mappings = sent.map<Mapping | null>(() => null);
  const feature = parsed.data.features[0];
  if (!feature) return mappings;
  const legs = prepareLegs(feature);
  if (!legs) return null;
  let previousIndex = -1;
  let previous: Mapping | null = null;
  for (const waypoint of feature.properties.waypoints) {
    const index = waypoint.original_index;
    const original = sent[index];
    if (index <= previousIndex || !original) return null;
    previousIndex = index;
    const mapped = mapWaypoint(waypoint, original, legs);
    if (mapped && followsMapping(previous, mapped)) {
      mappings[index] = mapped;
      previous = mapped;
    }
  }
  return mappings;
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumResponseBytes) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

async function requestMappings(
  url: URL,
  mode: "walk" | "bicycle",
  sent: GhostRecordedWaypoint[],
  signal: AbortSignal,
): Promise<{ mappings: (Mapping | null)[] } | ProviderError> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        waypoints: sent.map((point) => ({ location: coordinate(point) })),
        lookup_step_osmtags: true,
      }),
      signal,
    });
  } catch {
    // Transport failures may include the credentialed URL in the native error.
    return { status: "error", reason: "request-failed" };
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
    return {
      status: "error",
      reason: "rate-limited",
      ...(seconds !== undefined && seconds <= maximumRetryAfterSeconds
        ? { retryAfterSeconds: seconds }
        : {}),
    };
  }
  if (!response.ok) return { status: "error", reason: "request-failed" };
  try {
    const mappings = parseMappings(await boundedResponseJson(response), sent);
    return mappings ? { mappings } : { status: "error", reason: "invalid-response" };
  } catch {
    return { status: "error", reason: signal.aborted ? "request-failed" : "invalid-response" };
  }
}

function recordPiece(
  evidence: Map<number, Evidence>,
  sent: GhostRecordedWaypoint[],
  mappings: (Mapping | null)[],
) {
  const qualified =
    mappings.filter((mapping) => mapping !== null).length / sent.length >= minimumConfirmedFraction;
  for (const [index, point] of sent.entries()) {
    const mapping = mappings[index] ?? null;
    const label = qualified ? (mapping?.label ?? null) : null;
    const prior = evidence.get(point.originalIndex);
    if (prior) {
      const agrees =
        mapping &&
        prior.mapping &&
        sameLabel(mapping.label, prior.mapping.label) &&
        separationMeters(mapping.location, prior.mapping.location) <= 2 * stepSnapToleranceMeters;
      prior.mapping = agrees ? mapping : null;
      if (!agrees || !sameLabel(label, prior.label)) prior.label = null;
      continue;
    }
    const previous = mappings[index - 1];
    evidence.set(point.originalIndex, {
      point,
      mapping,
      label,
      continuesPrevious: Boolean(
        label &&
          mapping &&
          previous &&
          previous.legIndex === mapping.legIndex &&
          previous.groupIndex === mapping.groupIndex,
      ),
    });
  }
}

function collectSections(evidence: Iterable<Evidence>): GhostMapSection[] {
  const sections: GhostMapSection[] = [];
  let run: GhostMapSection | null = null;
  for (const { point, label, continuesPrevious } of evidence) {
    if (run && label && continuesPrevious && sameLabel(run, label)) {
      run.end = point;
    } else {
      if (run && run.end.distanceMeters - run.start.distanceMeters >= minimumSectionMeters)
        sections.push(run);
      run = label ? { ...label, start: point, end: point, attribution } : null;
    }
  }
  if (run && run.end.distanceMeters - run.start.distanceMeters >= minimumSectionMeters)
    sections.push(run);
  return sections;
}

/** Attach provider names to original recorded intervals after caller authorization. */
export async function labelGhostRoute(
  request: GhostRouteLabelRequest,
  config: GhostRouteLabelConfig,
): Promise<GhostRouteLabelResult> {
  if (!request.enabled) return { status: "disabled" };
  if (request.signal?.aborted) return { status: "cancelled" };
  const host = config.region === "eu" ? "api-eu.geoapify.com" : "api.geoapify.com";
  const url = new URL(`https://${host}/v1/mapmatching`);
  url.searchParams.set("apiKey", config.apiKey);
  const mode = request.sport === "running" ? "walk" : "bicycle";
  const recording = recordedGhostRouteChunks(request.points);
  const evidence = new Map<number, Evidence>();
  let bounded = recording.bounded;
  let requestsSent = 0;
  for (const sent of pieces(recording.chunks)) {
    if (requestsSent >= maximumPieces) {
      bounded = true;
      break;
    }
    if (!(await request.canDispatch()) || request.signal?.aborted) return { status: "cancelled" };
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const result = await requestMappings(url, mode, sent, signal);
    if (request.signal?.aborted) return { status: "cancelled" };
    if ("status" in result) return result;
    requestsSent += 1;
    recordPiece(evidence, sent, result.mappings);
  }
  const sections = collectSections(evidence.values());
  return {
    status: sections.length ? "ready" : "unavailable",
    sections: sections.slice(0, maximumSections),
    coverage: {
      sampledWaypoints: evidence.size,
      confirmedWaypoints: [...evidence.values()].filter(({ mapping }) => mapping !== null).length,
      bounded: bounded || sections.length > maximumSections,
    },
  };
}
