import { z } from "zod";
import { getMeasuredGhostScalarWindow } from "../db/activity-ghost-scalar-sample.ts";
import type { getGhostTrack } from "../db/activity-ghost-track.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { ghostTrackStampSchema } from "../db/ghost-track-evidence.ts";
import type { GhostRouteMatchResult } from "./ghost-route-matching.ts";
import {
  type GhostSessionScalarObservation,
  measureGhostSession,
} from "./ghost-session-measurement.ts";

type Match = GhostRouteMatchResult["matches"][number];
type TrackStamp = z.infer<typeof ghostTrackStampSchema>;
type SelectedMember = Pick<TrackStamp, "activityId" | "memberActivityId">;
type LoadedTrack = Awaited<ReturnType<typeof getGhostTrack>>;

export const scalarFetchLimitPerInterval = 4_001;
const scalarRowsPerPreparation = 20_000;
const scalarWindowMilliseconds = 24 * 60 * 60 * 1_000;

export const ghostScalarPairProofSchema = z
  .object({
    activityId: z.uuid(),
    memberActivityId: z.uuid(),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime(),
    count: z.number().int().nonnegative().lt(scalarFetchLimitPerInterval),
    digest: z.string().regex(/^[A-F0-9]{64}$/),
  })
  .array()
  .max(2);

function exactUtc(timestampMs: number): string {
  const wholeMs = Math.floor(timestampMs);
  const fractionalMicros = Math.round((timestampMs - wholeMs) * 1_000);
  return new Date(wholeMs + Math.floor(fractionalMicros / 1_000))
    .toISOString()
    .replace("Z", `${String(fractionalMicros % 1_000).padStart(3, "0")}Z`);
}

export function ghostScalarWindow(activity: SelectedMember, interval: Match["anchor"]) {
  return {
    activityId: activity.activityId,
    memberActivityId: activity.memberActivityId,
    startedAt: exactUtc(interval.start.timestampMs),
    endedAt: exactUtc(interval.end.timestampMs),
  };
}

export function matchesSelectedGhostTrack(
  track: LoadedTrack,
  stamp: TrackStamp,
): track is Extract<LoadedTrack, { status: "ready" }> {
  return (
    track.status === "ready" &&
    track.memberActivityId === stamp.memberActivityId &&
    track.providerId === stamp.providerId &&
    track.deviceId === stamp.deviceId &&
    track.sport === stamp.sport &&
    track.modality === stamp.modality &&
    track.refreshVersion === stamp.refreshVersion &&
    track.sourceRefreshedAtNs === stamp.sourceRefreshedAtNs &&
    track.memberSourceSyncedAtNs === stamp.memberSourceSyncedAtNs &&
    (track.startedAt === null || track.startedAt === stamp.startedAt) &&
    (track.endedAt === null || track.endedAt === stamp.endedAt)
  );
}

export function createGhostScalarReader(client: Pick<ClickHouseClient, "query">, userId: string) {
  let remaining = scalarRowsPerPreparation;
  return async (activity: SelectedMember, interval: Match["anchor"]) => {
    const fetchLimit = Math.min(scalarFetchLimitPerInterval, remaining);
    if (fetchLimit < 2 || interval.elapsedMs > scalarWindowMilliseconds) return { proof: null };
    const { observationRows, proof, rawCount } = await getMeasuredGhostScalarWindow(
      client,
      userId,
      ghostScalarWindow(activity, interval),
      fetchLimit,
    );
    remaining -= rawCount;
    const heartRateBpm: GhostSessionScalarObservation[] = [];
    const powerWatts: GhostSessionScalarObservation[] = [];
    for (const [recordedAt, channel, value, measurementKind] of observationRows) {
      const observation = { recordedAt, value, isEstimated: measurementKind === "estimated" };
      if (channel === "heart_rate") heartRateBpm.push(observation);
      if (channel === "power") powerWatts.push(observation);
    }
    return { heartRateBpm, powerWatts, proof };
  };
}

export async function prepareGhostSessionPair(
  readScalars: ReturnType<typeof createGhostScalarReader>,
  anchor: SelectedMember & Pick<TrackStamp, "sport">,
  candidate: SelectedMember,
  match: Match,
) {
  const anchorObservations = await readScalars(anchor, match.anchor);
  const candidateObservations = await readScalars(candidate, match.candidate);
  const comparison = measureGhostSession({
    match,
    sport: anchor.sport,
    anchorObservations,
    candidateObservations,
  });
  const measured =
    comparison.metrics.heartRateBpm !== null || comparison.metrics.powerWatts !== null;
  const scalarProof = [anchorObservations.proof, candidateObservations.proof];
  if (measured && scalarProof.some((proof) => proof === null))
    throw new Error("Measured Ghost Sessions metrics require a scalar proof for each interval");
  return { comparison, scalarProof: scalarProof.filter((proof) => proof !== null) };
}
