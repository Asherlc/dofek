import { expect, it, vi } from "vitest";
import { AccountErasureUserFencedError } from "../db/account-erasure.ts";
import type { ActivitySearchChange, ActivitySearchState } from "./opensearch.ts";
import {
  type ActivitySearchSource,
  listChangedActivityTitles,
  publishActivitySearchChanges,
} from "./publisher.ts";

const userId = "a0000000-0000-4000-8000-000000000001";
const otherUserId = "a0000000-0000-4000-8000-000000000002";
const activityId = "a0000000-0000-4000-8000-000000000003";
const mergedActivityId = "a0000000-0000-4000-8000-000000000004";
const version = "1794952647000000000";

const renamed = {
  version,
  userId,
  activityId,
  title: "Golden Hill Ride",
  activityType: "cycling",
  startedAt: "2021-05-14T15:00:00Z",
  searchable: true,
} satisfies ActivitySearchSource;
const merged = { ...renamed, activityId: mergedActivityId, searchable: false };
const blocked = { ...renamed, userId: otherUserId };
const lowerBoundary = "00000000-0000-0000-0000-000000000000";
const upperBoundary = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const checkpoint = { version, userId, activityId };

it("loads one batch of canonical rows with a lossless checkpoint and rejects malformed rows", async () => {
  const query = vi.fn().mockResolvedValue({
    json: async () => [{ ...renamed, title: "  Golden Hill Ride  " }],
  });

  await expect(listChangedActivityTitles({ query })).resolves.toEqual([renamed]);
  const unbounded = query.mock.calls[0]?.[0];
  expect(unbounded).toEqual({
    query: expect.stringContaining("FROM analytics.deduped_activities FINAL"),
    query_params: { limit: 500 },
    format: "JSONEachRow",
    clickhouse_settings: { max_threads: 1 },
  });
  expect(unbounded.query).not.toContain("WHERE (refresh_version");

  await expect(listChangedActivityTitles({ query }, checkpoint)).resolves.toEqual([renamed]);
  const continued = query.mock.calls[1]?.[0];
  expect(continued.query).toContain("WHERE (refresh_version, user_id, activity_id) >");
  expect(continued.query).toContain("ORDER BY refresh_version, user_id, activity_id");
  expect(continued.query_params).toEqual({ ...checkpoint, limit: 500 });

  query.mockResolvedValueOnce({ json: async () => [{ ...renamed, searchable: "yes" }] });
  await expect(listChangedActivityTitles({ query })).rejects.toThrow();
});

it("replays a failed batch, checkpoints both keys tied on a version, and emits merge deletions", async () => {
  let state: ActivitySearchState = { ready: false };
  let fail = true;
  const writes: ActivitySearchChange[][] = [];
  const loads: Array<ActivitySearchState["checkpoint"]> = [];
  const dependencies = {
    assertActive: async () => {},
    loadBatch: async (checkpoint: ActivitySearchState["checkpoint"]) => {
      loads.push(checkpoint);
      return checkpoint ? [] : [renamed, merged];
    },
    withWriteFence: async (_userId: string, write: () => Promise<void>) => write(),
    index: {
      loadState: async () => state,
      saveState: async (next: ActivitySearchState) => {
        state = next;
      },
      applyChanges: async (changes: ActivitySearchChange[]) => {
        writes.push(changes);
        if (fail) throw new Error("partial bulk failure");
      },
    },
  };

  await expect(publishActivitySearchChanges(dependencies)).rejects.toThrow("partial bulk failure");
  expect(state).toEqual({ ready: false });
  fail = false;
  await publishActivitySearchChanges(dependencies);
  await publishActivitySearchChanges(dependencies);

  const changes = [
    {
      kind: "index",
      activity: {
        userId,
        activityId,
        title: "Golden Hill Ride",
        activityType: "cycling",
        startedAt: "2021-05-14T15:00:00Z",
      },
    },
    { kind: "delete", userId, activityId: mergedActivityId },
  ];
  expect(writes).toEqual([changes, changes]);
  expect(state).toEqual({
    ready: true,
    checkpoint: {
      version,
      userId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      activityId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    },
  });
  expect(loads).toEqual([undefined, undefined, state.checkpoint]);
});

it("advances past an erased user without publishing stale data from that account", async () => {
  let state: ActivitySearchState = { ready: false };
  const writes: ActivitySearchChange[][] = [];
  await publishActivitySearchChanges({
    assertActive: async () => {},
    loadBatch: async () => [renamed, blocked],
    withWriteFence: async (accountId, write) => {
      if (accountId === otherUserId)
        throw new AccountErasureUserFencedError(new Error("account erased"));
      await write();
    },
    index: {
      loadState: async () => state,
      saveState: async (next) => {
        state = next;
      },
      applyChanges: async (changes) => {
        writes.push(changes);
      },
    },
  });

  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject([{ kind: "index", activity: { userId, activityId } }]);
  expect(state.ready).toBe(true);
  expect(state.checkpoint?.version).toEqual(version);
  expect(JSON.stringify(state)).not.toContain(otherUserId);
  expect(JSON.stringify(state)).not.toContain(activityId);
});

it("marks an empty backfill ready once without publishing or inventing a checkpoint", async () => {
  const loadState = vi
    .fn<() => Promise<ActivitySearchState>>()
    .mockResolvedValueOnce({ ready: false })
    .mockResolvedValueOnce({ ready: true });
  const saveState = vi.fn(async (_state: ActivitySearchState) => {});
  const applyChanges = vi.fn(async () => {});
  const publisher = {
    assertActive: async () => {},
    loadBatch: async () => [],
    withWriteFence: async (_userId: string, write: () => Promise<void>) => write(),
    index: { loadState, saveState, applyChanges },
  };
  await publishActivitySearchChanges(publisher);
  await publishActivitySearchChanges(publisher);
  expect(saveState.mock.calls).toEqual([[{ ready: true, checkpoint: undefined }]]);
  expect(applyChanges).not.toHaveBeenCalled();
});

it("only persists the safe boundary of a full batch and continues after its fenced tail", async () => {
  const renamedRows = Array.from({ length: 499 }, (_, index) => ({
    ...renamed,
    activityId: `a0000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
  }));
  const lastPublished = renamedRows.at(-1);
  if (!lastPublished) throw new Error("Missing test batch");
  const loadBatch = vi
    .fn()
    .mockResolvedValueOnce([...renamedRows, blocked])
    .mockResolvedValueOnce([]);
  const saveState = vi.fn(async (_state: ActivitySearchState) => {});
  const applyChanges = vi.fn(async (_changes: ActivitySearchChange[]) => {});
  await publishActivitySearchChanges({
    assertActive: async () => {},
    loadBatch,
    withWriteFence: async (accountId, write) => {
      if (accountId === otherUserId) throw new AccountErasureUserFencedError(new Error("fenced"));
      await write();
    },
    index: { loadState: async () => ({ ready: false }), saveState, applyChanges },
  });

  expect(loadBatch.mock.calls).toEqual([
    [undefined],
    [{ version, userId: otherUserId, activityId }],
  ]);
  expect(saveState.mock.calls).toEqual([
    [{ ready: false, checkpoint: { version, userId, activityId: lastPublished.activityId } }],
    [{ ready: true, checkpoint: { version, userId: upperBoundary, activityId: upperBoundary } }],
  ]);
  expect(applyChanges).toHaveBeenCalledTimes(1);
  expect(applyChanges.mock.calls[0]?.[0]).toHaveLength(499);
});

it("bounds a publication and never checkpoints a fenced account in an unfinished version", async () => {
  const fullBatch = Array.from({ length: 500 }, (_, index) => ({
    ...blocked,
    activityId: `a0000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
  }));
  const loadBatch = vi.fn<() => Promise<ActivitySearchSource[]>>().mockResolvedValue([]);
  for (let batch = 0; batch < 20; batch++) loadBatch.mockResolvedValueOnce(fullBatch);
  const saveState = vi.fn(async (_state: ActivitySearchState) => {});
  const applyChanges = vi.fn(async () => {});
  await publishActivitySearchChanges({
    assertActive: async () => {},
    loadBatch,
    withWriteFence: async () => {
      throw new AccountErasureUserFencedError(new Error("fenced"));
    },
    index: { loadState: async () => ({ ready: true }), saveState, applyChanges },
  });

  expect(loadBatch).toHaveBeenCalledTimes(20);
  expect(saveState).toHaveBeenCalledTimes(20);
  expect(saveState).toHaveBeenLastCalledWith({
    ready: true,
    checkpoint: { version, userId: lowerBoundary, activityId: lowerBoundary },
  });
  expect(applyChanges).not.toHaveBeenCalled();
});
