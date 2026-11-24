import {
  catalogueAreasAreNearby,
  normalizeCatalogueName,
} from "@dofek/climbing-catalogue/matching";
import {
  type Area,
  type ClimbSetting,
  climbingLogEntryAreaPath,
} from "@dofek/training/climbing-log";
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

interface LocatedArea {
  area: Area;
  parents: readonly Area[];
  owner: string;
  setting: ClimbSetting | null;
  conflictingSettings: boolean;
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

function gymsAgree(first: LocatedArea, second: LocatedArea): boolean {
  if (
    first.parents.length !== second.parents.length ||
    first.parents.some((parent, index) => {
      const other = second.parents[index];
      return !other || !gymNamesAgree(parent.name, other.name);
    })
  )
    return false;
  return (
    gymNamesAgree(first.area.name, second.area.name) &&
    catalogueAreasAreNearby(first.area, second.area, 200)
  );
}

function outdoorAreasAgree(first: LocatedArea, second: LocatedArea): boolean {
  const leafName = normalizeCatalogueName(first.area.name);
  if (!leafName || leafName !== normalizeCatalogueName(second.area.name)) return false;
  const nearby = catalogueAreasAreNearby(first.area, second.area);
  if (first.area.coordinates && second.area.coordinates && !nearby) return false;

  const firstParents = first.parents.map((parent) => normalizeCatalogueName(parent.name));
  const secondParents = second.parents.map((parent) => normalizeCatalogueName(parent.name));
  if (
    firstParents.length === secondParents.length &&
    firstParents.every((name, index) => name !== "" && name === secondParents[index])
  )
    return true;

  // A provider may include extra regional levels or qualify the crag as a park.
  const sharedDepth = Math.min(firstParents.length, secondParents.length);
  if (sharedDepth < 2 && !(sharedDepth === 1 && nearby)) return false;
  const localParents = (parents: string[]) =>
    parents
      .slice(-sharedDepth)
      .map((name, index) => (index === sharedDepth - 1 ? name.replace(/ park$/u, "") : name));
  const otherParents = localParents(secondParents);
  return localParents(firstParents).every(
    (name, index) => name !== "" && name === otherParents[index],
  );
}

function areasAgree(first: LocatedArea, second: LocatedArea): boolean {
  if (
    first.owner !== second.owner ||
    first.area.providerId === second.area.providerId ||
    first.conflictingSettings ||
    second.conflictingSettings
  )
    return false;
  const indoor = first.setting === "indoor";
  if (indoor !== (second.setting === "indoor")) return false;
  return indoor ? gymsAgree(first, second) : outdoorAreasAgree(first, second);
}

function areaGroups(logs: readonly ClimbingLogEntryDetail[]): Map<string, string> {
  const areas = new Map<string, LocatedArea>();
  for (const log of logs) {
    if (log.providerAbsentAt !== null) continue;
    const path = climbingLogEntryAreaPath(log);
    const area = path.at(-1);
    if (!area) continue;
    const key = `${log.userId}:${area.id}`;
    const setting = log.climb?.setting ?? null;
    const previous = areas.get(key);
    if (previous) {
      previous.conflictingSettings ||=
        previous.setting !== null && setting !== null && previous.setting !== setting;
      previous.setting ??= setting;
      continue;
    }
    areas.set(key, {
      area,
      parents: path.slice(0, -1),
      owner: log.userId,
      setting,
      conflictingSettings: false,
    });
  }
  const nodes = [...areas.entries()];
  const neighbors = new Map(nodes.map(([key]) => [key, new Set<string>()]));
  nodes.forEach(([leftKey, left], index) => {
    for (const [rightKey, right] of nodes.slice(index + 1)) {
      if (areasAgree(left, right)) {
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
    // Pairwise agreement prevents proximity chains and competing same-source areas.
    const unambiguous = members.every(
      ([memberKey]) => neighbors.get(memberKey)?.size === members.length - 1,
    );
    const anchor = unambiguous ? members.map(([, node]) => node.area.id).sort()[0] : undefined;
    for (const [memberKey, member] of members) {
      groups.set(memberKey, anchor ?? member.area.id);
    }
  }
  return groups;
}

/** Resolve display locations without writing provider facts or merging log occurrences. */
export function resolveClimbingLocations<T extends ClimbingLogEntryDetail>(
  logs: readonly T[],
): T[] {
  const groups = areaGroups(logs);
  const located = logs.map((log) => {
    const area = climbingLogEntryAreaPath(log).at(-1);
    const group =
      area && log.providerAbsentAt === null ? groups.get(`${log.userId}:${area.id}`) : undefined;
    return { ...log, areaGroupId: group ?? null };
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
