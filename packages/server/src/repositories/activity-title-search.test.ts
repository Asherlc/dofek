import type { ActivitySearchIndex } from "dofek/activity-search/opensearch";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { searchActivityTitles } from "./activity-title-search.ts";

const userId = "a0000000-0000-4000-8000-000000000001";
const staleId = "a0000000-0000-4000-8000-000000000002";
const olderId = "a0000000-0000-4000-8000-000000000003";
const nextId = "a0000000-0000-4000-8000-000000000004";
const olderActivity = { id: olderId, date: "2021-05-14", name: "Golden Hill Ride" };
const nextActivity = { id: nextId, date: "2019-08-02", name: "Golden Hill Ride" };

type Hit = Awaited<ReturnType<ActivitySearchIndex["search"]>>[number];
const hits: Hit[] = [
  { activityId: staleId, sort: [5, 1_750_000_000_000, staleId] },
  { activityId: olderId, sort: [4, 1_621_013_200_000, olderId] },
  { activityId: nextId, sort: [4, 1_564_700_000_000, nextId] },
];

const input = {
  userId,
  timezone: "UTC",
  accessWindow: { kind: "full", paid: true, reason: "paid_grant" } as const,
  title: "golden hi",
  activityType: "cycling",
  pageSize: 1,
};

beforeEach(() => {
  vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY_BASE64", Buffer.alloc(32, 1).toString("base64"));
});
afterEach(() => vi.unstubAllEnvs());

it("fills search pages after removing stale candidates and preserves ranked order", async () => {
  const search: ActivitySearchIndex["search"] = async ({ after }) =>
    after ? hits.slice(hits.findIndex(({ sort }) => sort[2] === after[2]) + 1) : hits;
  const index = { loadState: async () => ({ ready: true }), search };
  const hydrate = async (ids: string[]) =>
    [nextActivity, olderActivity].filter(({ id }) => ids.includes(id));

  const first = await searchActivityTitles(index, hydrate, input);
  expect(first.activities).toEqual([olderActivity]);
  expect(first.next).toEqual(expect.any(String));

  const second = await searchActivityTitles(index, hydrate, {
    ...input,
    cursor: first.next ?? undefined,
  });
  expect(second).toEqual({ activities: [nextActivity], next: null });
});

it("keeps inaccessible activity IDs and dates out of a stale-only continuation", async () => {
  const search: ActivitySearchIndex["search"] = async () => hits.slice(0, 2);
  const index = { loadState: async () => ({ ready: true }), search };
  const result = await searchActivityTitles(index, async () => [], input);
  expect(result.activities).toEqual([]);
  expect(result.next).toEqual(expect.any(String));
  expect(JSON.stringify(result.next)).not.toContain(olderId);
  expect(JSON.stringify(result.next)).not.toContain("1621013200000");
});

it("rejects a cursor from another query before contacting the index", async () => {
  const loadState = vi.fn(async () => ({ ready: true }));
  const search = vi.fn(async () => hits);
  const index = { loadState, search };
  const hydrate = async () => [olderActivity, nextActivity];
  const page = await searchActivityTitles(index, hydrate, input);
  expect(page.next).not.toBeNull();
  loadState.mockClear();
  search.mockClear();

  await expect(
    searchActivityTitles(index, hydrate, {
      ...input,
      title: "coastal",
      cursor: page.next ?? undefined,
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(loadState).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
});

it("reports an incomplete history backfill as unavailable", async () => {
  const index = { loadState: async () => ({ ready: false }), search: async () => hits };
  await expect(
    searchActivityTitles(index, async () => [olderActivity], input),
  ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
});
