import { expect, it } from "vitest";
import { MemoryCacheStore } from "./cache.ts";
import { ghostRouteLabelsCacheKey, readGhostRouteLabelsCache } from "./ghost-route-labels-cache.ts";

const revision = {
  userId: "00000000-0000-4000-8000-000000000001",
  activityId: "00000000-0000-4000-8000-000000000002",
  sourceVersion: "a".repeat(64),
  consentRevision: "2026-11-24T12:00:00.123456Z",
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
