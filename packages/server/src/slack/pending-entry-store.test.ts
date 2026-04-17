import { describe, expect, it } from "vitest";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import {
  InMemoryPendingEntryStore,
  type PendingSlackEntry,
  RedisPendingEntryStore,
} from "./pending-entry-store.ts";

const makeFoodItem = (overrides: Partial<NutritionItemWithMeal> = {}): NutritionItemWithMeal => ({
  foodName: "Apple",
  foodDescription: "Red apple",
  category: "fruit",
  calories: 95,
  proteinG: 0.5,
  carbsG: 25,
  fatG: 0.3,
  fiberG: 4.4,
  saturatedFatG: 0.1,
  sugarG: 19,
  sodiumMg: 2,
  meal: "snack",
  ...overrides,
});

const makeEntry = (
  overrides: Partial<Omit<PendingSlackEntry, "id">> = {},
): Omit<PendingSlackEntry, "id"> => ({
  userId: "00000000-0000-0000-0000-000000000001",
  date: "2026-04-16",
  item: makeFoodItem(),
  channelId: "C123",
  confirmationMessageTs: "123.456",
  threadTs: "123.000",
  sourceMessageTs: "122.000",
  slackUserId: "U123",
  ...overrides,
});

describe("InMemoryPendingEntryStore", () => {
  const store = new InMemoryPendingEntryStore();

  it("saves and loads entries by ID", async () => {
    const entry = makeEntry({ userId: "00000000-0000-0000-0000-000000000002" });
    const ids = await store.save([entry]);
    const id = ids[0];
    if (!id) throw new Error("ID not generated");
    expect(id).toBeDefined();

    const [loaded] = await store.loadByIds([id]);
    expect(loaded).toMatchObject({ ...entry, id });
  });

  it("filters out non-existent IDs on load", async () => {
    const loaded = await store.loadByIds(["00000000-0000-0000-0000-000000000003"]);
    expect(loaded).toHaveLength(0);
  });

  it("finds IDs by message context", async () => {
    const e1 = makeEntry({ channelId: "c1", confirmationMessageTs: "ts1" });
    const e2 = makeEntry({ channelId: "c1", confirmationMessageTs: "ts1" });
    const [id1, id2] = await store.save([e1, e2]);

    const ids = await store.findIdsByMessage("c1", "ts1");
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
    expect(ids).toHaveLength(2);
  });

  it("deletes entries by ID and updates message index", async () => {
    const e1 = makeEntry({ channelId: "c2", confirmationMessageTs: "ts2" });
    const [id1] = await store.save([e1]);
    if (!id1) throw new Error("ID not generated");

    await store.deleteByIds([id1]);
    const loaded = await store.loadByIds([id1]);
    expect(loaded).toHaveLength(0);

    const ids = await store.findIdsByMessage("c2", "ts2");
    expect(ids).toHaveLength(0);
  });
});

describe("RedisPendingEntryStore", () => {
  const mockRedis = {
    storage: new Map<string, string>(),
    async set(key: string, value: string) {
      this.storage.set(key, value);
      return "OK" as const;
    },
    async get(key: string) {
      return this.storage.get(key) ?? null;
    },
    async del(...keys: string[]) {
      let count = 0;
      for (const k of keys) {
        if (this.storage.delete(k)) count++;
      }
      return count;
    },
  };

  const store = new RedisPendingEntryStore(async () => mockRedis);

  it("saves and loads entries with JSON serialization", async () => {
    const entry = makeEntry();
    const [id] = await store.save([entry]);
    if (!id) throw new Error("ID not generated");

    const [loaded] = await store.loadByIds([id]);
    expect(loaded).toMatchObject({ ...entry, id });
  });

  it("maintains message index in Redis", async () => {
    const e1 = makeEntry({ channelId: "rc1", confirmationMessageTs: "rts1" });
    const [id1] = await store.save([e1]);

    const ids = await store.findIdsByMessage("rc1", "rts1");
    expect(ids).toEqual([id1]);
  });

  it("deletes entries and cleans up index", async () => {
    const e1 = makeEntry({ channelId: "rc2", confirmationMessageTs: "rts2" });
    const [id1] = await store.save([e1]);
    if (!id1) throw new Error("ID not generated");

    await store.deleteByIds([id1]);
    expect(await store.loadByIds([id1])).toHaveLength(0);
    expect(await store.findIdsByMessage("rc2", "rts2")).toHaveLength(0);
  });

  it("handles multiple entries in message index on delete", async () => {
    const e1 = makeEntry({ channelId: "rc3", confirmationMessageTs: "rts3" });
    const e2 = makeEntry({ channelId: "rc3", confirmationMessageTs: "rts3" });
    const [id1, id2] = await store.save([e1, e2]);
    if (!id1) throw new Error("ID not generated");

    await store.deleteByIds([id1]);
    const ids = await store.findIdsByMessage("rc3", "rts3");
    expect(ids).toEqual([id2]);
  });

  it("handles malformed JSON in Redis gracefully", async () => {
    mockRedis.storage.set("slack:pending-entry:bad", "invalid json");
    const loaded = await store.loadByIds(["bad"]);
    expect(loaded).toHaveLength(0);

    mockRedis.storage.set("slack:pending-message:bad", "not an array");
    const key = "slack:pending-message:m1:ts1";
    mockRedis.storage.set(key, "not an array");
    expect(await store.findIdsByMessage("m1", "ts1")).toHaveLength(0);
  });
});
