import { afterEach, describe, expect, it } from "vitest";
import {
  invalidateAllQueries,
  invalidateAllUserQueries,
  invalidateUserQueryDomains,
  queryCache,
} from "./cache.js";

const TTL_MS = 60_000;

afterEach(async () => {
  await queryCache.invalidateAll();
});

describe("query cache invalidation", () => {
  it("invalidates every prefix for the requested user domains", async () => {
    await Promise.all([
      queryCache.set("user-1:journal.entries", "entries", TTL_MS),
      queryCache.set("user-1:journal.trends", "trends", TTL_MS),
      queryCache.set("user-1:behaviorImpact.sleep", "impact", TTL_MS),
      queryCache.set("user-1:personalization.preferences", "preferences", TTL_MS),
      queryCache.set("user-1:mobileDashboard.summary", "dashboard", TTL_MS),
      queryCache.set("user-1:recovery.score", "recovery", TTL_MS),
      queryCache.set("user-1:stress.score", "stress", TTL_MS),
      queryCache.set("user-1:pmc.chart", "pmc", TTL_MS),
      queryCache.set("user-1:lifeEvents.timeline", "life events", TTL_MS),
      queryCache.set("user-2:journal.entries", "other user", TTL_MS),
    ]);

    await invalidateUserQueryDomains("user-1", ["journalEntries", "personalization"]);

    await expect(queryCache.get("user-1:journal.entries")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:journal.trends")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:behaviorImpact.sleep")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:personalization.preferences")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:mobileDashboard.summary")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:recovery.score")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:stress.score")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:pmc.chart")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:lifeEvents.timeline")).resolves.toBe("life events");
    await expect(queryCache.get("user-2:journal.entries")).resolves.toBe("other user");
  });

  it("invalidates every query belonging to one user", async () => {
    await Promise.all([
      queryCache.set("user-1:journal.entries", "entries", TTL_MS),
      queryCache.set("user-1:recovery.score", "recovery", TTL_MS),
      queryCache.set("user-2:journal.entries", "other user", TTL_MS),
    ]);

    await invalidateAllUserQueries("user-1");

    await expect(queryCache.get("user-1:journal.entries")).resolves.toBeUndefined();
    await expect(queryCache.get("user-1:recovery.score")).resolves.toBeUndefined();
    await expect(queryCache.get("user-2:journal.entries")).resolves.toBe("other user");
  });

  it("invalidates every cached query", async () => {
    await Promise.all([
      queryCache.set("user-1:journal.entries", "entries", TTL_MS),
      queryCache.set("user-2:recovery.score", "recovery", TTL_MS),
    ]);

    await invalidateAllQueries();

    await expect(queryCache.get("user-1:journal.entries")).resolves.toBeUndefined();
    await expect(queryCache.get("user-2:recovery.score")).resolves.toBeUndefined();
  });
});
