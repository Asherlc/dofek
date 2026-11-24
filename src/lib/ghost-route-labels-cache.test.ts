import { expect, it } from "vitest";
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
