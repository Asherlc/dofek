import { expect, it, vi } from "vitest";
import { ghostRouteLabelsSourceVersion } from "../db/ghost-track-evidence.ts";
import { MemoryCacheStore } from "./cache.ts";
import { ghostRouteLabelsCacheKey, readGhostRouteLabelsCache } from "./ghost-route-labels-cache.ts";

const revision = {
  userId: "00000000-0000-4000-8000-000000000001",
  activityId: "00000000-0000-4000-8000-000000000002",
  sourceVersion: "a".repeat(64),
  consentRevision: "2026-11-24T12:00:00.123456Z",
};

const anchorStamp = {
  activityId: revision.activityId,
  memberActivityId: "00000000-0000-4000-8000-000000000003",
  providerId: "garmin",
  deviceId: null,
  sport: "cycling",
  modality: "road",
  startedAt: "2026-11-24T12:00:00.123456Z",
  endedAt: "2026-11-24T12:01:00.123456Z",
  refreshVersion: "1",
  sourceRefreshedAtNs: "2",
  memberSourceSyncedAtNs: "3",
  gpsRefreshVersion: "4",
  gpsSourceRefreshedAtNs: "5",
  memberSignature: "6",
  markerSignature: null,
} as const;

const start = { originalIndex: 0, timestampMs: 1_000.125, lat: 51, lng: -2, distanceMeters: 0 };
const end = { originalIndex: 4, timestampMs: 9_000.125, lat: 51.001, lng: -2, distanceMeters: 111 };
const named = {
  kind: "named-trail",
  name: "Ridge Trail",
  attribution: "OpenStreetMap",
  start,
  end,
};
const labels = {
  status: "ready",
  sections: [named],
  coverage: { sampledWaypoints: 5, confirmedWaypoints: 5, bounded: false },
};

it("reads only the exact owner, activity, source and consent cache revision", async () => {
  const cache = new MemoryCacheStore();
  const key = ghostRouteLabelsCacheKey(revision);
  const result = { status: "error", reason: "rate-limited", retryAfterSeconds: 20 };
  expect(key).toMatch(new RegExp(`^${revision.userId}:ghostRouteLabels\\.`));
  await cache.set(key, result, 60_000);
  expect(await readGhostRouteLabelsCache(cache, revision)).toEqual(result);
  expect(
    await readGhostRouteLabelsCache(cache, {
      ...revision,
      consentRevision: "2026-11-24T12:00:00.123457Z",
    }),
  ).toBeUndefined();
  expect(
    await readGhostRouteLabelsCache(cache, { ...revision, sourceVersion: "b".repeat(64) }),
  ).toBeUndefined();
});

it("withholds a malformed cached label result", async () => {
  const cache = new MemoryCacheStore();
  await cache.set(ghostRouteLabelsCacheKey(revision), { status: "ready", sections: null }, 60_000);
  expect(await readGhostRouteLabelsCache(cache, revision)).toBeUndefined();
});

it("reads optional prepared sections and keeps base names if that envelope is malformed", async () => {
  const cache = new MemoryCacheStore();
  const current = {
    ...revision,
    sourceVersion: ghostRouteLabelsSourceVersion({ status: "ready", ...anchorStamp }),
  };
  const base = {
    status: "ready",
    sections: [],
    coverage: { sampledWaypoints: 4, confirmedWaypoints: 4, bounded: false },
  };
  const prepared = {
    status: "ready",
    anchorStamp,
    candidateStamps: [],
    bounded: false,
    sections: [],
  };
  const key = ghostRouteLabelsCacheKey(current);
  await cache.set(key, { ...base, prepared }, 60_000);
  expect(await readGhostRouteLabelsCache(cache, current)).toEqual({ ...base, prepared });
  await cache.set(key, { ...base, prepared: { ...prepared, candidateStamps: null } }, 60_000);
  expect(await readGhostRouteLabelsCache(cache, current)).toEqual(base);
});

it("uses the saved label deadline even when the cache backend still returns the entry", async () => {
  const ready = {
    status: "ready",
    sections: [],
    coverage: { sampledWaypoints: 0, confirmedWaypoints: 0, bounded: false },
  };
  const unexpired = { ...ready, expiresAt: Date.now() + 60_000 };
  const expired = { ...ready, expiresAt: Date.now() - 1 };
  expect(await readGhostRouteLabelsCache({ get: async () => unexpired }, revision)).toEqual(
    unexpired,
  );
  expect(await readGhostRouteLabelsCache({ get: async () => expired }, revision)).toBeUndefined();
  expect(await readGhostRouteLabelsCache({ get: async () => ready }, revision)).toEqual(ready);
});

it("validates persisted labels and provider failures after a worker loads the cache reader", async () => {
  vi.resetModules();
  const { readGhostRouteLabelsCache: readCache } = await import("./ghost-route-labels-cache.ts");
  const read = (value: unknown) => readCache({ get: async () => value }, revision);
  expect(await read(labels)).toEqual(labels);
  const unavailable = { ...labels, status: "unavailable", sections: [] };
  expect(await read(unavailable)).toEqual(unavailable);
  const limited = { status: "error", reason: "rate-limited", retryAfterSeconds: 7 };
  expect(await read(limited)).toEqual(limited);
  expect(await read({ ...limited, retryAfterSeconds: 3_601 })).toBeUndefined();
  for (const section of [
    { ...named, start: { ...start, lat: 91 } },
    { ...named, end: { ...end, lng: -181 } },
    { ...named, attribution: "" },
    { ...named, name: "a".repeat(257) },
  ]) {
    expect(await read({ ...labels, sections: [section] })).toBeUndefined();
  }
});

it("keeps named preparation only for the same recording and keeps its base names on a mismatch", async () => {
  const current = {
    ...revision,
    sourceVersion: ghostRouteLabelsSourceVersion({ status: "ready", ...anchorStamp }),
  };
  const section = {
    sectionId: "a".repeat(64),
    kind: named.kind,
    name: named.name,
    attribution: named.attribution,
    anchor: {
      start: { timestampMs: start.timestampMs, lat: start.lat, lng: start.lng, distanceMeters: 0 },
      end: { timestampMs: end.timestampMs, lat: end.lat, lng: end.lng, distanceMeters: 111 },
      elapsedMs: 8_000,
    },
    historyCoverage: "partial",
    passes: [],
  };
  const prepared = {
    status: "ready",
    anchorStamp,
    candidateStamps: [],
    bounded: false,
    sections: [section],
  };
  const lookup = (entry: unknown, key = current) =>
    readGhostRouteLabelsCache({ get: async () => entry }, key);
  expect(await lookup({ ...labels, prepared })).toEqual({ ...labels, prepared });
  expect(
    await lookup({ ...labels, prepared }, { ...current, sourceVersion: "b".repeat(64) }),
  ).toEqual(labels);
  const wrongActivity = "00000000-0000-4000-8000-000000000004";
  expect(await lookup({ ...labels, prepared }, { ...current, activityId: wrongActivity })).toEqual(
    labels,
  );
  const { name: _name, attribution: _attribution, ...bounds } = section;
  expect(
    await lookup({
      ...labels,
      prepared: { ...prepared, sections: [{ ...bounds, kind: "unnamed-climb" }] },
    }),
  ).toEqual(labels);
});

it("withholds labels exactly at the deadline even if the backend returns the cached names", async () => {
  const expiresAt = Date.parse("2026-11-25T12:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt);
  try {
    expect(
      await readGhostRouteLabelsCache({ get: async () => ({ ...labels, expiresAt }) }, revision),
    ).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
