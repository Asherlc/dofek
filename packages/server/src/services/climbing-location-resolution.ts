import { normalizeCatalogueName } from "@dofek/climbing-catalogue/matching";
import { type Area, climbingLogEntryAreaPath } from "@dofek/training/climbing-log";
import { z } from "zod";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";

const facilityWords = new Set([
  "the",
  "and",
  "climbing",
  "climb",
  "boulder",
  "bouldering",
  "gym",
  "gymnasium",
  "rock",
  "fitness",
  "center",
  "centre",
  "club",
]);
const sourceSessionSchema = z.object({
  sessionId: z.string().trim().min(1).nullish(),
  session_id: z.string().trim().min(1).nullish(),
});

/** Only an exact upstream session identity supplies location context. */
export function climbingSourceSession(log: Pick<ClimbingLogEntryDetail, "raw">): string | null {
  const parsed = sourceSessionSchema.safeParse(log.raw);
  if (!parsed.success) return null;
  const { sessionId, session_id: snakeSessionId } = parsed.data;
  if (sessionId && snakeSessionId && sessionId !== snakeSessionId) return null;
  return sessionId ?? snakeSessionId ?? null;
}

interface GymArea {
  area: Area;
  parents: readonly Area[];
  owner: string;
  explicitGroup: string | null;
}

function gymNamesAgree(first: string, second: string): boolean {
  const tokens = (name: string) =>
    new Set(
      normalizeCatalogueName(name)
        .split(" ")
        .filter((word) => word && !facilityWords.has(word)),
    );
  const left = tokens(first);
  const right = tokens(second);
  const shared = [...left].filter((word) => right.has(word)).length;
  return (
    shared > 0 &&
    ((shared === left.size && shared === right.size) ||
      (shared >= 2 && shared === Math.min(left.size, right.size)))
  );
}

function gymsAgree(first: GymArea, second: GymArea): boolean {
  if (first.owner !== second.owner) return false;
  if (first.explicitGroup && first.explicitGroup === second.explicitGroup) return true;
  if (first.explicitGroup && second.explicitGroup) return false;
  if (first.area.providerId === second.area.providerId) return false;
  if (
    first.parents.length !== second.parents.length ||
    first.parents.some((parent, index) => {
      const other = second.parents[index];
      return !other || !gymNamesAgree(parent.name, other.name);
    })
  )
    return false;
  const origin = first.area.coordinates;
  const destination = second.area.coordinates;
  if (!origin || !destination || !gymNamesAgree(first.area.name, second.area.name)) return false;
  const radians = Math.PI / 180;
  const haversine =
    Math.sin(((destination.latitude - origin.latitude) * radians) / 2) ** 2 +
    Math.cos(origin.latitude * radians) *
      Math.cos(destination.latitude * radians) *
      Math.sin(((destination.longitude - origin.longitude) * radians) / 2) ** 2;
  // Gym entrance and board pins can differ. This is not the outdoor route policy.
  return 2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, haversine))) <= 200;
}

function gymGroups(logs: readonly ClimbingLogEntryDetail[]): Map<string, string> {
  const areas = new Map<string, GymArea>();
  for (const log of logs) {
    if (log.providerAbsentAt !== null || log.climb?.setting !== "indoor") continue;
    const path = climbingLogEntryAreaPath(log);
    const area = path.at(-1);
    if (area)
      areas.set(`${log.userId}:${area.id}`, {
        area,
        parents: path.slice(0, -1),
        owner: log.userId,
        explicitGroup: log.areaGroupId ?? null,
      });
  }
  const nodes = [...areas.entries()];
  const neighbors = new Map(nodes.map(([key]) => [key, new Set<string>()]));
  nodes.forEach(([leftKey, left], index) => {
    for (const [rightKey, right] of nodes.slice(index + 1)) {
      if (gymsAgree(left, right)) {
        neighbors.get(leftKey)?.add(rightKey);
        neighbors.get(rightKey)?.add(leftKey);
      }
    }
  });
  const groups = new Map<string, string>();
  for (const [key] of nodes) {
    if (groups.has(key)) continue;
    const pending = [key];
    const component = new Set<string>();
    while (pending.length) {
      const current = pending.pop();
      if (!current || component.has(current)) continue;
      component.add(current);
      pending.push(...(neighbors.get(current) ?? []));
    }
    const members = nodes.filter(([key]) => component.has(key));
    // Pairwise agreement prevents proximity chains and competing same-source gyms.
    const unambiguous = members.every(([, left], index) =>
      members.slice(index + 1).every(([, right]) => gymsAgree(left, right)),
    );
    const explicit = members.map(([, node]) => node.explicitGroup).find((group) => group !== null);
    const anchor = members.map(([, node]) => node.area.id).sort()[0];
    for (const [memberKey, member] of members) {
      groups.set(
        memberKey,
        unambiguous && anchor ? (explicit ?? anchor) : (member.explicitGroup ?? member.area.id),
      );
    }
  }
  return groups;
}

/** Resolve display locations without writing provider facts or merging log occurrences. */
export function resolveClimbingLocations<T extends ClimbingLogEntryDetail>(
  logs: readonly T[],
): T[] {
  const groups = gymGroups(logs);
  const located = logs.map((log) => {
    const area = climbingLogEntryAreaPath(log).at(-1);
    const group =
      area && log.climb?.setting === "indoor" ? groups.get(`${log.userId}:${area.id}`) : null;
    return group ? { ...log, areaGroupId: group } : log;
  });
  const sessions = new Map<string, T[]>();
  const nativeLocationSessions = new Set<string>();
  const sessionKey = (log: T) => {
    const session = climbingSourceSession(log);
    return session ? JSON.stringify([log.userId, log.providerId, session]) : null;
  };
  for (const log of located) {
    const key = sessionKey(log);
    if (!key || log.providerAbsentAt !== null || log.climb?.setting !== "indoor") continue;
    if (!climbingLogEntryAreaPath(log).length) {
      if (log.mapLocation) nativeLocationSessions.add(key);
      continue;
    }
    const peers = sessions.get(key) ?? [];
    peers.push(log);
    sessions.set(key, peers);
  }
  return located.map((log) => {
    if (
      log.providerAbsentAt !== null ||
      log.climb?.setting !== "indoor" ||
      log.mapLocation !== null ||
      climbingLogEntryAreaPath(log).length
    )
      return log;
    const key = sessionKey(log);
    if (key && nativeLocationSessions.has(key)) return log;
    const peers = key ? (sessions.get(key) ?? []) : [];
    if (new Set(peers.map((peer) => peer.areaGroupId)).size !== 1) return log;
    const origin = peers.slice().sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!origin) return log;
    const areaPath = [...climbingLogEntryAreaPath(origin)];
    const area = areaPath
      .slice()
      .reverse()
      .find((area) => area.coordinates);
    return {
      ...log,
      areaPath,
      areaGroupId: origin.areaGroupId,
      mapLocation: area?.coordinates
        ? {
            coordinates: area.coordinates,
            scope: "area",
            objectId: area.id,
            providerId: area.providerId,
            name: area.name,
          }
        : null,
    };
  });
}
