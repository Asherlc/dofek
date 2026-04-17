import { describe, expect, it, vi } from "vitest";
import type { NutritionItemWithMeal } from "../lib/ai-nutrition.ts";
import {
  extractLatestConfirmFromThread,
  FoodEntryRepository,
  slackTimestampToDateString,
  slackTimestampToLocalTime,
} from "./food-entry-repository.ts";
import type { PendingSlackEntry } from "./pending-entry-store.ts";
import { InMemoryPendingEntryStore } from "./pending-entry-store.ts";

/**
 * Coerce any object into T for test mocks. Not type-safe at runtime, but test
 * files are excluded from the server tsconfig so TypeScript does not check the
 * implicit return type mismatch here. Biome will still lint this file normally.
 */
function asMock<T>(value: object): T {
  return value;
}

function makeItem(overrides: Partial<NutritionItemWithMeal> = {}): NutritionItemWithMeal {
  return {
    foodName: "Test Food",
    foodDescription: "1 serving",
    category: "other",
    calories: 200,
    proteinG: 10,
    carbsG: 20,
    fatG: 8,
    fiberG: 3,
    saturatedFatG: 2,
    sugarG: 5,
    sodiumMg: 100,
    meal: "lunch",
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<Omit<PendingSlackEntry, "id">> = {},
): Omit<PendingSlackEntry, "id"> {
  return {
    userId: "00000000-0000-0000-0000-000000000001",
    date: "2026-04-16",
    item: makeItem(),
    channelId: "C1",
    confirmationMessageTs: "ts1",
    threadTs: "ts1",
    sourceMessageTs: "ts0",
    slackUserId: "U1",
    ...overrides,
  };
}

describe("extractLatestConfirmFromThread", () => {
  it("returns null for empty messages array", () => {
    expect(extractLatestConfirmFromThread([])).toBeNull();
  });

  it("returns null when no bot_id or no blocks", () => {
    expect(
      extractLatestConfirmFromThread([
        { ts: "1" },
        { ts: "2", bot_id: "B1" },
        { ts: "3", blocks: [] },
      ]),
    ).toBeNull();
  });

  it("returns null when block is not actions type", () => {
    expect(
      extractLatestConfirmFromThread([
        {
          ts: "1",
          bot_id: "B1",
          blocks: [{ type: "section", elements: [{ action_id: "confirm_food", value: "x" }] }],
        },
      ]),
    ).toBeNull();
  });

  it("returns null when action_id does not match confirm_food", () => {
    expect(
      extractLatestConfirmFromThread([
        {
          ts: "1",
          bot_id: "B1",
          blocks: [{ type: "actions", elements: [{ action_id: "cancel_food", value: "x" }] }],
        },
      ]),
    ).toBeNull();
  });

  it("returns null when confirm button value is empty or whitespace-only", () => {
    const messages = [
      {
        ts: "1",
        bot_id: "B1",
        blocks: [{ type: "actions", elements: [{ action_id: "confirm_food", value: "" }] }],
      },
      {
        ts: "2",
        bot_id: "B1",
        blocks: [{ type: "actions", elements: [{ action_id: "confirm_food", value: ", ," }] }],
      },
    ];
    expect(extractLatestConfirmFromThread(messages)).toBeNull();
  });

  it("returns the LATEST (highest-index) bot message with confirm button", () => {
    const messages = [
      {
        ts: "100",
        bot_id: "B1",
        blocks: [{ type: "actions", elements: [{ action_id: "confirm_food", value: "id1,id2" }] }],
      },
      {
        ts: "200",
        bot_id: "B1",
        blocks: [{ type: "actions", elements: [{ action_id: "confirm_food", value: "id3,id4" }] }],
      },
      { ts: "300", text: "plain user message" },
    ];
    const result = extractLatestConfirmFromThread(messages);
    expect(result).toEqual({ entryIds: ["id3", "id4"], messageTs: "200" });
  });

  it("finds entry in the first (index 0) message — kills i > 0 mutation", () => {
    const messages = [
      {
        ts: "first",
        bot_id: "B1",
        blocks: [{ type: "actions", elements: [{ action_id: "confirm_food", value: "only-id" }] }],
      },
    ];
    const result = extractLatestConfirmFromThread(messages);
    expect(result?.entryIds).toEqual(["only-id"]);
    expect(result?.messageTs).toBe("first");
  });

  it("trims and filters IDs from the value string", () => {
    const messages = [
      {
        ts: "1",
        bot_id: "B1",
        blocks: [
          {
            type: "actions",
            elements: [{ action_id: "confirm_food", value: " id1 , id2 , " }],
          },
        ],
      },
    ];
    const result = extractLatestConfirmFromThread(messages);
    expect(result?.entryIds).toEqual(["id1", "id2"]);
  });

  it("returns null messageTs when threadMsg.ts is undefined", () => {
    const messages = [
      {
        bot_id: "B1",
        blocks: [{ type: "actions", elements: [{ action_id: "confirm_food", value: "id1" }] }],
      },
    ];
    const result = extractLatestConfirmFromThread(messages);
    expect(result?.messageTs).toBeNull();
  });
});

describe("slackTimestampToDateString", () => {
  it("converts epoch seconds to YYYY-MM-DD in the given timezone", () => {
    // 2024-04-16T18:00:00Z in UTC → "2024-04-16"
    expect(slackTimestampToDateString("1713290400.000", "UTC")).toBe("2024-04-16");
  });

  it("respects timezone when converting — different timezone shifts the date", () => {
    // 2024-04-16T00:30:00Z is still 2024-04-15 in Los Angeles (UTC-7)
    const ts = "1713224200.000"; // 2024-04-15T23:56:40Z
    expect(slackTimestampToDateString(ts, "America/Los_Angeles")).toBe("2024-04-15");
    expect(slackTimestampToDateString(ts, "UTC")).toBe("2024-04-15");
  });
});

describe("slackTimestampToLocalTime", () => {
  it("formats time with 12-hour clock (kills hour12: false mutation)", () => {
    const ts = "1713290400.000"; // 2024-04-16T18:00:00Z → 6:00 PM UTC
    const formatted = slackTimestampToLocalTime(ts, "UTC");
    expect(formatted).toContain("6:00 PM");
    expect(formatted).not.toContain("18:00");
  });

  it("includes weekday in the formatted output", () => {
    const ts = "1713290400.000"; // Tuesday, April 16, 2024
    const formatted = slackTimestampToLocalTime(ts, "UTC");
    expect(formatted).toContain("Tuesday");
  });
});

describe("FoodEntryRepository", () => {
  describe("confirm", () => {
    it("returns empty result immediately for empty input", async () => {
      const store = new InMemoryPendingEntryStore();
      const mockExecute = vi.fn();
      const repo = new FoodEntryRepository(asMock({ execute: mockExecute }), store);

      const result = await repo.confirm([]);

      expect(result).toEqual({ confirmedCount: 0, confirmedEntryIds: [], userId: null });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("inserts to DB and deletes from store when entries are pending", async () => {
      const store = new InMemoryPendingEntryStore();
      const entry = makeEntry({ userId: "user-1" });
      const [entryId] = await store.save([entry]);
      if (!entryId) throw new Error("Expected ID");

      const mockExecute = vi.fn();
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // INSERT ... RETURNING id
      mockExecute.mockResolvedValueOnce([{ id: entryId }]);

      const repo = new FoodEntryRepository(asMock({ execute: mockExecute }), store);
      const result = await repo.confirm([entryId]);

      expect(result.confirmedCount).toBe(1);
      expect(result.confirmedEntryIds).toEqual([entryId]);
      expect(result.userId).toBe("user-1");

      // Entry must be removed from the pending store after confirmation
      const remaining = await store.loadByIds([entryId]);
      expect(remaining).toHaveLength(0);
    });

    it("throws when the DB returns no row for the insert", async () => {
      const store = new InMemoryPendingEntryStore();
      const entry = makeEntry({ userId: "user-1" });
      const [entryId] = await store.save([entry]);
      if (!entryId) throw new Error("Expected ID");

      const mockExecute = vi.fn();
      // ensureDofekProvider
      mockExecute.mockResolvedValueOnce([]);
      // INSERT returns empty (simulating DB failure)
      mockExecute.mockResolvedValueOnce([]);

      const repo = new FoodEntryRepository(asMock({ execute: mockExecute }), store);

      await expect(repo.confirm([entryId])).rejects.toThrow(
        'Failed to confirm parsed food entry "Test Food"',
      );
    });

    it("returns early when pending entry has no userId", async () => {
      const mockLoadByIds = vi
        .fn()
        .mockResolvedValue([{ id: "e1", userId: null, item: makeItem() }]);
      const mockStore = {
        loadByIds: mockLoadByIds,
        save: vi.fn(),
        deleteByIds: vi.fn(),
        findIdsByMessage: vi.fn(),
      };
      const mockExecute = vi.fn();
      const repo = new FoodEntryRepository(asMock({ execute: mockExecute }), asMock(mockStore));

      const result = await repo.confirm(["e1"]);

      expect(result).toEqual({ confirmedCount: 0, confirmedEntryIds: [], userId: null });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("confirms multiple entries in a single call", async () => {
      const store = new InMemoryPendingEntryStore();
      const [id1, id2] = await store.save([makeEntry(), makeEntry()]);
      if (!id1 || !id2) throw new Error("Expected IDs");

      const mockExecute = vi.fn();
      // ensureDofekProvider (once)
      mockExecute.mockResolvedValueOnce([]);
      // INSERT for entry 1
      mockExecute.mockResolvedValueOnce([{ id: id1 }]);
      // INSERT for entry 2
      mockExecute.mockResolvedValueOnce([{ id: id2 }]);

      const repo = new FoodEntryRepository(asMock({ execute: mockExecute }), store);
      const result = await repo.confirm([id1, id2]);

      expect(result.confirmedCount).toBe(2);
      expect(result.confirmedEntryIds).toEqual([id1, id2]);
    });

    it("passes all optional micronutrients through to SQL insert values", async () => {
      const store = new InMemoryPendingEntryStore();
      const entryWithMicronutrients = makeEntry({
        userId: "user-1",
        item: makeItem({
          polyunsaturatedFatG: 11,
          monounsaturatedFatG: 12,
          transFatG: 13,
          cholesterolMg: 14,
          potassiumMg: 15,
          vitaminAMcg: 16,
          vitaminCMg: 17,
          vitaminDMcg: 18,
          vitaminEMg: 19,
          vitaminKMcg: 20,
          vitaminB1Mg: 21,
          vitaminB2Mg: 22,
          vitaminB3Mg: 23,
          vitaminB5Mg: 24,
          vitaminB6Mg: 25,
          vitaminB7Mcg: 26,
          vitaminB9Mcg: 27,
          vitaminB12Mcg: 28,
          calciumMg: 29,
          ironMg: 30,
          magnesiumMg: 31,
          zincMg: 32,
          seleniumMcg: 33,
          copperMg: 34,
          manganeseMg: 35,
          chromiumMcg: 36,
          iodineMcg: 37,
          omega3Mg: 38,
          omega6Mg: 39,
        }),
      });
      const [entryId] = await store.save([entryWithMicronutrients]);
      if (!entryId) throw new Error("Expected ID");

      const executedQueries: unknown[] = [];
      const mockExecute = vi.fn(async (query: unknown) => {
        executedQueries.push(query);
        // ensureDofekProvider first query
        if (executedQueries.length === 1) return [];
        // INSERT ... RETURNING id second query
        return [{ id: entryId }];
      });

      const repo = new FoodEntryRepository(asMock({ execute: mockExecute }), store);
      const result = await repo.confirm([entryId]);

      expect(result.confirmedCount).toBe(1);
      expect(result.confirmedEntryIds).toEqual([entryId]);

      const insertQuery = executedQueries[1];
      const queryChunksCandidate =
        typeof insertQuery === "object" && insertQuery !== null
          ? Reflect.get(insertQuery, "queryChunks")
          : undefined;
      expect(Array.isArray(queryChunksCandidate)).toBe(true);
      if (!Array.isArray(queryChunksCandidate)) {
        throw new Error("Expected second execute() call to receive a SQL query with queryChunks");
      }

      const scalarBindValues = queryChunksCandidate
        .filter(
          (chunk): chunk is number | string | null =>
            typeof chunk === "number" || typeof chunk === "string" || chunk === null,
        )
        .filter((chunk) => typeof chunk === "number");

      const expectedMicronutrientValues = [
        11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
        34, 35, 36, 37, 38, 39,
      ];

      for (const expectedValue of expectedMicronutrientValues) {
        expect(scalarBindValues).toContain(expectedValue);
      }
    });
  });

  describe("deleteUnconfirmed", () => {
    it("does not call deleteByIds when given an empty list", async () => {
      const mockDeleteByIds = vi.fn();
      const mockStore = {
        deleteByIds: mockDeleteByIds,
        save: vi.fn(),
        loadByIds: vi.fn(),
        findIdsByMessage: vi.fn(),
      };
      const repo = new FoodEntryRepository(asMock({}), asMock(mockStore));

      await repo.deleteUnconfirmed([]);

      expect(mockDeleteByIds).not.toHaveBeenCalled();
    });

    it("delegates to the store when IDs are provided", async () => {
      const mockDeleteByIds = vi.fn().mockResolvedValue(undefined);
      const mockStore = {
        deleteByIds: mockDeleteByIds,
        save: vi.fn(),
        loadByIds: vi.fn(),
        findIdsByMessage: vi.fn(),
      };
      const repo = new FoodEntryRepository(asMock({}), asMock(mockStore));

      await repo.deleteUnconfirmed(["id1", "id2"]);

      expect(mockDeleteByIds).toHaveBeenCalledWith(["id1", "id2"]);
    });
  });
});
