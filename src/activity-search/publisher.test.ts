import { expect, it } from "vitest";
import { AccountErasureUserFencedError } from "../db/account-erasure.ts";
import type { ActivitySearchChange, ActivitySearchState } from "./opensearch.ts";
import { type ActivitySearchSource, publishActivitySearchChanges } from "./publisher.ts";

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
