import { createHash } from "node:crypto";
import { getGhostTrack } from "../db/activity-ghost-track.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  type GhostTrackEvidence,
  ghostTrackStampSchema,
  hasActiveGhostMember,
  readGhostTrackEvidence,
  resolveActiveGhostMembers,
} from "../db/ghost-track-evidence.ts";
import type { Database } from "../db/index.ts";
import {
  ghostRecordedSectionId,
  ghostSectionPreparationLimits,
  type PreparedGhostSections,
  preparedGhostSectionsSchema,
  preparedGhostTrackStampSchema,
} from "../lib/ghost-route-section-results.ts";
import {
  type GhostRecordedWaypoint,
  type GhostRouteMatchResult,
  recordedGhostRouteChunks,
} from "./ghost-route-matching.ts";
import { matchGhostRouteSection } from "./ghost-route-sections.ts";
import {
  createGhostScalarReader,
  ghostScalarWindow,
  matchesSelectedGhostTrack,
  prepareGhostSessionPair,
} from "./ghost-session-pair-preparation.ts";
import { listGhostTrackCandidates } from "./ghost-track-index.ts";

type ReadyStamp = Extract<GhostTrackEvidence, { status: "ready" }>;
type ReadyTrack = Extract<Awaited<ReturnType<typeof getGhostTrack>>, { status: "ready" }>;
type Recording = { stamp: ReadyStamp; track: ReadyTrack };
type PreparedSection = PreparedGhostSections["sections"][number];
type Pass = PreparedSection["passes"][number];
type Match = GhostRouteMatchResult["matches"][number];
type ActiveMembers = Awaited<ReturnType<typeof resolveActiveGhostMembers>>;
type QueryClient = Pick<ClickHouseClient, "query">;

type SectionBounds = { start: GhostRecordedWaypoint; end: GhostRecordedWaypoint };
type SourceSection = SectionBounds &
  (
    | { kind: "unnamed-climb" }
    | { kind: "named-road" | "named-trail"; name: string; attribution: string }
  );

interface PreparationInput {
  userId: string;
  anchor: Recording;
  sections: readonly SourceSection[];
}

const maximumSectionInputs = 64;
const stale = { status: "stale" } as const;
const limits = ghostSectionPreparationLimits;

function fingerprint(parts: readonly (number | string)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sameWaypoint(left: GhostRecordedWaypoint, right: GhostRecordedWaypoint) {
  return (
    left.originalIndex === right.originalIndex &&
    left.timestampMs === right.timestampMs &&
    left.lat === right.lat &&
    left.lng === right.lng &&
    left.distanceMeters === right.distanceMeters
  );
}

function recordedSection(
  chunks: readonly GhostRecordedWaypoint[][],
  { start, end }: SectionBounds,
) {
  if (start.originalIndex >= end.originalIndex || start.distanceMeters >= end.distanceMeters)
    return [];
  for (const chunk of chunks) {
    const first = chunk.findIndex((point) => sameWaypoint(point, start));
    if (first < 0) continue;
    const last = chunk.findIndex((point) => sameWaypoint(point, end));
    return last > first ? chunk.slice(first, last + 1) : [];
  }
  return [];
}

function sectionGeometry(points: readonly GhostRecordedWaypoint[]): PreparedSection["geometry"] {
  const count = Math.min(points.length, limits.geometryVertices);
  if (count < 2) return undefined;
  const geometry = [];
  for (let index = 0; index < count; index += 1) {
    const source = points[Math.round((index * (points.length - 1)) / (count - 1))];
    if (!source) return undefined;
    geometry.push({ lat: source.lat, lng: source.lng });
  }
  return [geometry];
}

function drawSection(
  activityId: string,
  source: SourceSection,
  chunks: readonly GhostRecordedWaypoint[][],
): PreparedSection | null {
  const geometry = sectionGeometry(recordedSection(chunks, source));
  if (!geometry) return null;
  const { originalIndex: _startIndex, ...start } = source.start;
  const { originalIndex: _endIndex, ...end } = source.end;
  const result = {
    sectionId: ghostRecordedSectionId(activityId, source.kind, start.timestampMs, end.timestampMs),
    anchor: { start, end, elapsedMs: end.timestampMs - start.timestampMs },
    geometry,
    historyCoverage: "partial" as const,
    passes: [],
  };
  return source.kind === "unnamed-climb"
    ? { ...result, kind: source.kind }
    : { ...result, kind: source.kind, name: source.name, attribution: source.attribution };
}

function currentTrackEvidence(client: QueryClient, userId: string, activityIds: readonly string[]) {
  return readGhostTrackEvidence(
    async (schema, query, keys) => {
      const result = await client.query({ query, query_params: keys, format: "JSONEachRow" });
      return schema.array().parse(await result.json());
    },
    { userId, activityIds },
  );
}

function sameCurrentStamp(expected: ReadyStamp, current: GhostTrackEvidence | undefined) {
  return (
    current?.status === "ready" &&
    JSON.stringify(preparedGhostTrackStampSchema.parse(current)) ===
      JSON.stringify(preparedGhostTrackStampSchema.parse(expected))
  );
}

function memberIsCurrent(active: ActiveMembers, expected: ReadyStamp) {
  const resolved = active.get(expected.memberActivityId);
  return (
    hasActiveGhostMember(active, expected) &&
    resolved?.sport === expected.sport &&
    resolved.modality === expected.modality
  );
}

function orderedSections(sections: readonly SourceSection[]) {
  return sections
    .slice(0, maximumSectionInputs)
    .sort(
      (left, right) =>
        left.start.timestampMs - right.start.timestampMs ||
        left.end.timestampMs - right.end.timestampMs ||
        compareText(left.kind, right.kind) ||
        compareText("name" in left ? left.name : "", "name" in right ? right.name : ""),
    );
}

function selectPasses(
  sectionId: string,
  activity: Recording,
  source: SourceSection,
  candidates: readonly Recording[],
) {
  const matches = new Map<string, { passId: string; candidate: ReadyStamp; match: Match }>();
  let bounded = false;
  for (const candidate of candidates) {
    const result = matchGhostRouteSection(activity.track.points, candidate.track.points, source);
    bounded ||= result.status === "bounded";
    for (const match of result.matches) {
      const passId = fingerprint([
        sectionId,
        match.anchor.start.timestampMs,
        match.anchor.end.timestampMs,
        candidate.stamp.activityId,
        match.candidate.start.timestampMs,
        match.candidate.end.timestampMs,
      ]);
      if (!matches.has(passId)) matches.set(passId, { passId, candidate: candidate.stamp, match });
    }
  }
  const ranked = [...matches.values()].sort(
    (left, right) =>
      right.match.candidate.start.timestampMs - left.match.candidate.start.timestampMs ||
      compareText(left.candidate.activityId, right.candidate.activityId) ||
      compareText(left.passId, right.passId),
  );
  return {
    passes: ranked.slice(0, limits.passesPerSection),
    bounded: bounded || ranked.length > limits.passesPerSection,
  };
}

/** Prepare one bounded snapshot from an already selected anchor recording. */
export async function prepareGhostSectionComparisons(
  { db, clickhouse }: { db: Pick<Database, "execute">; clickhouse: QueryClient },
  { userId, anchor, sections }: PreparationInput,
): Promise<PreparedGhostSections | typeof stale> {
  if (!matchesSelectedGhostTrack(anchor.track, anchor.stamp)) return stale;
  const anchorId = anchor.stamp.activityId;
  const recorded = recordedGhostRouteChunks(anchor.track.points);
  let bounded = recorded.bounded || sections.length > maximumSectionInputs;
  const selectedSections = new Map<string, { display: PreparedSection; source: SourceSection }>();
  for (const source of orderedSections(sections)) {
    const display = drawSection(anchorId, source, recorded.chunks);
    if (!display || selectedSections.has(display.sectionId)) continue;
    if (selectedSections.size >= limits.sections) {
      bounded = true;
      break;
    }
    selectedSections.set(display.sectionId, { display, source });
  }

  const page = selectedSections.size
    ? await listGhostTrackCandidates(clickhouse, { userId, anchorActivityId: anchorId })
    : null;
  const discovered = page?.candidates.slice(0, limits.earlierCandidates) ?? [];
  bounded ||= Boolean(page?.nextCursor) || (page?.candidates.length ?? 0) > discovered.length;
  const evidence = await currentTrackEvidence(clickhouse, userId, [
    anchorId,
    ...discovered.map(({ activityId }) => activityId),
  ]);
  if (!sameCurrentStamp(anchor.stamp, evidence.get(anchorId))) return stale;

  const candidateStamps: ReadyStamp[] = [];
  for (const entry of discovered) {
    const stamp = evidence.get(entry.activityId);
    if (
      stamp?.status === "ready" &&
      stamp.activityId !== anchorId &&
      stamp.sport === anchor.stamp.sport &&
      JSON.stringify(ghostTrackStampSchema.parse(stamp)) ===
        JSON.stringify(ghostTrackStampSchema.parse(entry))
    ) {
      candidateStamps.push(stamp);
    } else bounded = true;
  }
  const active = await resolveActiveGhostMembers(db, userId, [
    anchor.stamp.memberActivityId,
    ...candidateStamps.map(({ memberActivityId }) => memberActivityId),
  ]);
  if (!memberIsCurrent(active, anchor.stamp)) return stale;
  const candidates = [anchor];
  for (const stamp of candidateStamps) {
    if (memberIsCurrent(active, stamp)) {
      const track = await getGhostTrack(clickhouse, { userId, activityId: stamp.activityId });
      if (matchesSelectedGhostTrack(track, stamp)) {
        candidates.push({ stamp, track });
        continue;
      }
    }
    bounded = true;
  }

  const read = createGhostScalarReader(clickhouse, userId);
  const measured = new Map<string, ReturnType<typeof read>>();
  const readOnce: typeof read = (stamp, interval) => {
    const key = JSON.stringify(ghostScalarWindow(stamp, interval));
    const existing = measured.get(key);
    if (existing) return existing;
    const measurement = read(stamp, interval);
    measured.set(key, measurement);
    return measurement;
  };
  const prepared: PreparedSection[] = [];
  const used = new Map<string, ReadyStamp>([[anchorId, anchor.stamp]]);
  for (const { display, source } of selectedSections.values()) {
    const selected = selectPasses(display.sectionId, anchor, source, candidates);
    const passes: Pass[] = [];
    bounded ||= selected.bounded;
    for (const { passId, candidate, match } of selected.passes) {
      const { comparison, scalarProof } = await prepareGhostSessionPair(
        readOnce,
        anchor.stamp,
        candidate,
        match,
      );
      used.set(candidate.activityId, candidate);
      passes.push({
        passId,
        activityId: candidate.activityId,
        startedAt: candidate.startedAt,
        comparison,
        scalarProof,
      });
    }
    prepared.push({ ...display, passes });
  }

  const usedStamps = [...used.values()];
  const current = await currentTrackEvidence(clickhouse, userId, [...used.keys()]);
  const currentMembers = await resolveActiveGhostMembers(
    db,
    userId,
    usedStamps.map(({ memberActivityId }) => memberActivityId),
  );
  if (
    !usedStamps.every(
      (stamp) =>
        sameCurrentStamp(stamp, current.get(stamp.activityId)) &&
        memberIsCurrent(currentMembers, stamp),
    )
  )
    return stale;
  return preparedGhostSectionsSchema.parse({
    status: "ready",
    anchorStamp: anchor.stamp,
    candidateStamps: usedStamps.filter(({ activityId }) => activityId !== anchorId),
    bounded,
    sections: prepared,
  });
}
